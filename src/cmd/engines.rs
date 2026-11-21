//! Docker engines for the Engines page: Hullport's own engine (a Lima VM the app runs, see
//! `crate::engine`) and other engines on this Mac that Hullport can connect to.

use crate::engine::{Engine, EngineState};
use crate::lifecycle;
use serde::Serialize;
use std::path::Path;
use std::sync::Arc;
use tauri::AppHandle;

fn socket_alive(path: &Path) -> bool {
    std::os::unix::net::UnixStream::connect(path).is_ok()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HullportEngine {
    pub state: EngineState,
    pub error: Option<String>,
    pub socket: String,
    /// Docker context name the app uses for it.
    pub context: String,
    pub cpus: Option<String>,
    pub memory: Option<String>,
    pub disk: Option<String>,
    /// Whether this run can start and stop it (not in launch modes like --verify).
    pub managed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    pub id: String,
    pub name: String,
    pub installed: bool,
    pub running: bool,
    pub socket: String,
    /// Docker context Hullport switches to for this engine.
    pub context: String,
    pub note: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnginesOverview {
    pub hullport: HullportEngine,
    pub others: Vec<EngineInfo>,
    pub docker_cli: Option<String>,
}

#[tauri::command]
pub fn engines_overview(app: AppHandle) -> EnginesOverview {
    let managed = lifecycle::engine(&app);
    let engine = managed.clone().unwrap_or_else(|| Arc::new(Engine::new()));
    let state = if managed.is_some() { engine.state() } else { engine.refresh() };
    let (cpus, memory, disk) = engine.resources().map(|(c, m, d)| (Some(c), Some(m), Some(d))).unwrap_or_default();
    let h = dirs::home_dir().unwrap_or_default();
    let other = |id: &str, name: &str, app_path: &str, socket: std::path::PathBuf, context: &str, note: &str| EngineInfo {
        id: id.into(),
        name: name.into(),
        installed: Path::new(app_path).exists() || socket.exists(),
        running: socket_alive(&socket),
        socket: socket.display().to_string(),
        context: context.into(),
        note: note.into(),
    };
    EnginesOverview {
        hullport: HullportEngine {
            state,
            error: engine.last_error(),
            socket: engine.socket().display().to_string(),
            context: crate::docker::context::HULLPORT.into(),
            cpus,
            memory,
            disk,
            managed: managed.is_some(),
        },
        others: vec![
            other("orbstack", "OrbStack", "/Applications/OrbStack.app", h.join(".orbstack/run/docker.sock"), "orbstack", "Started and stopped from OrbStack itself. Its data is migrated from here later."),
            other("desktop", "Docker Desktop", "/Applications/Docker.app", h.join(".docker/run/docker.sock"), "desktop-linux", "Started and stopped from Docker Desktop itself."),
            other("colima", "Colima", "/opt/homebrew/bin/colima", h.join(".colima/default/docker.sock"), "colima", "Started and stopped with the colima command."),
        ],
        docker_cli: crate::docker::cli::find_docker().map(|p| p.display().to_string()),
    }
}

/// Start Hullport's engine; progress arrives as `engine-state` events.
#[tauri::command]
pub fn engine_start(app: AppHandle) {
    lifecycle::start_engine(&app);
}

/// Stop Hullport's engine cleanly; progress arrives as `engine-state` events.
#[tauri::command]
pub fn engine_stop(app: AppHandle) {
    lifecycle::stop_engine(&app);
}
