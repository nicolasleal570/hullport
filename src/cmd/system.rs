use crate::docker::{context, ConnStatus};
use crate::error::{other, AppResult};
use crate::state::{AppState, LaunchMode};
use base64::Engine;
use tauri::State;

#[tauri::command]
pub fn get_status(state: State<'_, AppState>) -> ConnStatus {
    state.docker.status()
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextList {
    pub contexts: Vec<context::DockerContext>,
    pub cli_current: String,
    pub selected: Option<String>,
}

#[tauri::command]
pub fn list_contexts(state: State<'_, AppState>) -> ContextList {
    ContextList {
        contexts: context::list_contexts(),
        cli_current: context::cli_current_context(),
        selected: state.docker.preferred(),
    }
}

/// `None` follows the Docker CLI's current context.
#[tauri::command]
pub fn set_context(state: State<'_, AppState>, name: Option<String>) -> AppResult<()> {
    let mut prefs = state.store.prefs();
    prefs.context = name.clone();
    state.store.set_prefs(&prefs)?;
    state.docker.set_context(name);
    Ok(())
}

#[tauri::command]
pub fn reconnect(state: State<'_, AppState>) {
    state.docker.reconnect();
}

#[tauri::command]
pub async fn disk_usage(state: State<'_, AppState>) -> AppResult<serde_json::Value> {
    let d = state.docker.docker()?;
    let df = d.df(None).await?;
    Ok(serde_json::to_value(df)?)
}

#[tauri::command]
pub fn cancel_op(state: State<'_, AppState>, id: String) -> bool {
    state.cancel_op(&id)
}

#[tauri::command]
pub fn launch_mode(state: State<'_, AppState>) -> LaunchMode {
    state.launch.clone()
}

/// Used by `--screenshot`: the UI renders itself to PNG and hands the bytes here.
#[tauri::command]
pub fn write_launch_output_b64(state: State<'_, AppState>, data: String) -> AppResult<()> {
    let path = state.launch.path.clone().ok_or_else(|| other("no output path"))?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.trim())
        .map_err(|e| other(e.to_string()))?;
    write_out(&path, &bytes)
}

/// Used by `--self-test`: the UI writes its JSON report here.
#[tauri::command]
pub fn write_launch_output_text(state: State<'_, AppState>, text: String) -> AppResult<()> {
    let path = state.launch.path.clone().ok_or_else(|| other("no output path"))?;
    write_out(&path, text.as_bytes())
}

fn write_out(path: &str, bytes: &[u8]) -> AppResult<()> {
    let p = std::path::Path::new(path);
    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    std::fs::write(p, bytes)?;
    Ok(())
}

#[tauri::command]
pub fn exit_app(app: tauri::AppHandle, code: i32) {
    app.exit(code);
}

#[tauri::command]
pub fn docker_cli_path() -> Option<String> {
    crate::docker::cli::find_docker().map(|p| p.display().to_string())
}
