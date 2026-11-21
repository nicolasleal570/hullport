use crate::error::{other, AppError, AppResult};
use crate::state::AppState;
use bollard::models::{ImageInspect, ImageSummary};
use bollard::query_parameters::{
    CreateImageOptionsBuilder, ListImagesOptionsBuilder, PruneImagesOptionsBuilder,
    RemoveImageOptionsBuilder, TagImageOptionsBuilder,
};
use bollard::Docker;
use futures_util::StreamExt;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;
use tokio::io::{AsyncBufReadExt, BufReader};

/// Add `:latest` when a reference has neither tag nor digest, so a pull never fetches every tag.
pub fn normalize_ref(r: &str) -> String {
    let r = r.trim();
    if r.contains('@') {
        return r.to_string();
    }
    let last = r.rsplit('/').next().unwrap_or(r);
    if last.contains(':') {
        r.to_string()
    } else {
        format!("{r}:latest")
    }
}

pub async fn pull_quiet(d: &Docker, reference: &str, platform: Option<&str>) -> AppResult<()> {
    let mut b = CreateImageOptionsBuilder::default().from_image(reference);
    if let Some(p) = platform.filter(|s| !s.is_empty()) {
        b = b.platform(p);
    }
    let mut s = d.create_image(Some(b.build()), None, None);
    while let Some(item) = s.next().await {
        item?;
    }
    Ok(())
}

#[tauri::command]
pub async fn list_images(state: State<'_, AppState>) -> AppResult<Vec<ImageSummary>> {
    let d = state.docker.docker()?;
    Ok(d.list_images(Some(ListImagesOptionsBuilder::default().all(false).build())).await?)
}

#[tauri::command]
pub async fn inspect_image(state: State<'_, AppState>, id: String) -> AppResult<ImageInspect> {
    let d = state.docker.docker()?;
    Ok(d.inspect_image(&id).await?)
}

#[tauri::command]
pub async fn image_history(state: State<'_, AppState>, id: String) -> AppResult<serde_json::Value> {
    let d = state.docker.docker()?;
    Ok(serde_json::to_value(d.image_history(&id).await?)?)
}

#[tauri::command]
pub async fn tag_image(state: State<'_, AppState>, id: String, repo: String, tag: String) -> AppResult<()> {
    let d = state.docker.docker()?;
    let tag = if tag.trim().is_empty() { "latest".to_string() } else { tag.trim().to_string() };
    d.tag_image(&id, Some(TagImageOptionsBuilder::default().repo(repo.trim()).tag(&tag).build()))
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn remove_image(state: State<'_, AppState>, id: String, force: bool) -> AppResult<serde_json::Value> {
    let d = state.docker.docker()?;
    let res = d
        .remove_image(&id, Some(RemoveImageOptionsBuilder::default().force(force).build()), None)
        .await?;
    Ok(serde_json::to_value(res)?)
}

/// `all = false` removes dangling images only; `all = true` removes every unused image.
#[tauri::command]
pub async fn prune_images(state: State<'_, AppState>, all: bool) -> AppResult<serde_json::Value> {
    let d = state.docker.docker()?;
    let f = crate::cmd::filters(&[("dangling", if all { "false" } else { "true" })]);
    let res = d.prune_images(Some(PruneImagesOptionsBuilder::default().filters(&f).build())).await?;
    Ok(serde_json::to_value(res)?)
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PullEvent {
    /// One JSON progress message from the engine (id, status, progressDetail...).
    Progress { info: serde_json::Value },
    /// A plain text line (from the CLI fallback).
    Text { line: String },
    Done { error: Option<String>, canceled: bool },
}

fn needs_credentials(msg: &str) -> bool {
    let m = msg.to_ascii_lowercase();
    m.contains("unauthorized") || m.contains("denied") || m.contains("authentication required")
}

/// Pull an image with streaming progress. Returns an op id for `cancel_op`.
/// Pulls go through the Engine API anonymously; when the registry needs
/// credentials it falls back to `docker pull`, which uses the user's own
/// credential helpers without exposing anything to the UI.
#[tauri::command]
pub async fn pull_image(
    state: State<'_, AppState>,
    reference: String,
    platform: Option<String>,
    channel: Channel<PullEvent>,
) -> AppResult<String> {
    let d = state.docker.docker()?;
    if reference.trim().is_empty() {
        return Err(other("Enter an image reference, e.g. nginx:alpine"));
    }
    let reference = normalize_ref(&reference);
    let (op, token) = state.register_op();
    let (ctx, host) = state.docker.endpoint();
    tauri::async_runtime::spawn(async move {
        let mut b = CreateImageOptionsBuilder::default().from_image(&reference);
        if let Some(p) = platform.as_deref().filter(|s| !s.is_empty()) {
            b = b.platform(p);
        }
        let stream = d.create_image(Some(b.build()), None, None);
        tokio::pin!(stream);
        let mut error: Option<String> = None;
        let mut canceled = false;
        loop {
            tokio::select! {
                _ = token.cancelled() => { canceled = true; break; }
                item = stream.next() => match item {
                    Some(Ok(info)) => {
                        let v = serde_json::to_value(&info).unwrap_or_default();
                        let _ = channel.send(PullEvent::Progress { info: v });
                    }
                    Some(Err(e)) => { error = Some(AppError::from(e).to_string()); break; }
                    None => break,
                }
            }
        }
        if let Some(msg) = error.clone().filter(|m| needs_credentials(m)) {
            let _ = channel.send(PullEvent::Text {
                line: "Registry requires credentials, retrying with the Docker CLI...".into(),
            });
            error = cli_pull(&ctx, &host, &reference, platform.as_deref(), &channel, &token)
                .await
                .err()
                .map(|e| format!("{e}\n(API: {msg})"));
            canceled = token.is_cancelled();
        }
        let _ = channel.send(PullEvent::Done { error, canceled });
    });
    Ok(op)
}

async fn cli_pull(
    ctx: &str,
    host: &str,
    reference: &str,
    platform: Option<&str>,
    channel: &Channel<PullEvent>,
    token: &tokio_util::sync::CancellationToken,
) -> Result<(), String> {
    let mut cmd = crate::docker::cli::command(ctx, host)?;
    cmd.arg("pull");
    if let Some(p) = platform.filter(|s| !s.is_empty()) {
        cmd.arg("--platform").arg(p);
    }
    cmd.arg(reference)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let out = child.stdout.take().unwrap();
    let err = child.stderr.take().unwrap();
    let mut lines_out = BufReader::new(out).lines();
    let mut lines_err = BufReader::new(err).lines();
    let mut last_err = String::new();
    let (mut out_done, mut err_done) = (false, false);
    while !(out_done && err_done) {
        tokio::select! {
            _ = token.cancelled() => { let _ = child.start_kill(); return Err("Canceled".into()); }
            l = lines_out.next_line(), if !out_done => match l {
                Ok(Some(line)) => { let _ = channel.send(PullEvent::Text { line }); }
                _ => out_done = true,
            },
            l = lines_err.next_line(), if !err_done => match l {
                Ok(Some(line)) => { last_err = line.clone(); let _ = channel.send(PullEvent::Text { line }); }
                _ => err_done = true,
            },
        }
    }
    let status = child.wait().await.map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(if last_err.is_empty() { format!("docker pull exited with {status}") } else { last_err })
    }
}
