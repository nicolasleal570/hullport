//! Builds run through `docker buildx build --progress=rawjson`, which streams
//! BuildKit's solve status (steps/vertices, logs, warnings). History comes
//! from BuildKit itself (`buildx history`) plus records of builds started here.

use crate::error::{other, AppResult};
use crate::state::AppState;
use crate::store::{BuildConfig, BuildRecord, BuildStepRecord};
use base64::Engine;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Instant;
use tauri::ipc::Channel;
use tauri::{Manager, State};
use tokio::io::{AsyncBufReadExt, BufReader};

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum BuildEvent {
    Started { build_id: String, command: String },
    /// One raw BuildKit SolveStatus JSON object.
    Status { status: serde_json::Value },
    Text { line: String },
    Done { record: BuildRecord },
}

#[derive(Default)]
struct Vertex {
    name: String,
    started: Option<String>,
    completed: Option<String>,
    cached: bool,
    error: Option<String>,
    order: usize,
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn ms_between(a: &str, b: &str) -> Option<i64> {
    let a = chrono::DateTime::parse_from_rfc3339(a).ok()?;
    let b = chrono::DateTime::parse_from_rfc3339(b).ok()?;
    Some((b - a).num_milliseconds())
}

fn resolve_dockerfile(ctx: &Path, df: Option<&str>) -> Option<PathBuf> {
    let df = df.map(str::trim).filter(|s| !s.is_empty())?;
    let p = PathBuf::from(df);
    Some(if p.is_absolute() { p } else { ctx.join(p) })
}

#[tauri::command]
pub async fn build_start(app: tauri::AppHandle, state: State<'_, AppState>, config: BuildConfig, channel: Channel<BuildEvent>) -> AppResult<String> {
    let ctx_dir = PathBuf::from(config.context_dir.trim());
    if !ctx_dir.is_dir() {
        return Err(other(format!("Build context folder not found: {}", ctx_dir.display())));
    }
    let dockerfile = resolve_dockerfile(&ctx_dir, config.dockerfile.as_deref());
    if let Some(df) = &dockerfile {
        if !df.is_file() {
            return Err(other(format!("Dockerfile not found: {}", df.display())));
        }
    } else if !ctx_dir.join("Dockerfile").is_file() {
        return Err(other("No Dockerfile in the build context. Choose one."));
    }
    let image = config.image.trim().to_string();
    if image.is_empty() {
        return Err(other("Give the image a name"));
    }
    let tag = config.tag.clone().map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).unwrap_or_else(|| "latest".into());
    let full_tag = format!("{image}:{tag}");

    let (dctx, host) = state.docker.endpoint();
    let mut cmd = crate::docker::cli::command(&dctx, &host).map_err(other)?;
    let meta_file = std::env::temp_dir().join(format!("berth-build-{}.json", uuid::Uuid::new_v4().simple()));
    let mut args: Vec<String> = vec![
        "buildx".into(), "build".into(), "--progress=rawjson".into(),
        "--metadata-file".into(), meta_file.display().to_string(),
        "-t".into(), full_tag.clone(),
    ];
    if let Some(df) = &dockerfile {
        args.push("-f".into());
        args.push(df.display().to_string());
    }
    for kv in &config.build_args {
        if !kv.key.trim().is_empty() {
            args.push("--build-arg".into());
            args.push(format!("{}={}", kv.key.trim(), kv.value));
        }
    }
    if let Some(t) = config.target.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        args.push("--target".into());
        args.push(t.into());
    }
    if let Some(p) = config.platform.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        args.push("--platform".into());
        args.push(p.into());
    }
    if config.no_cache {
        args.push("--no-cache".into());
    }
    if config.pull {
        args.push("--pull".into());
    }
    args.push("--load".into());
    args.push(ctx_dir.display().to_string());
    let command_line = format!("docker {}", args.join(" "));
    cmd.args(&args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .current_dir(&ctx_dir);

    let mut child = cmd.spawn().map_err(|e| other(format!("Could not start docker buildx: {e}")))?;
    let build_id = uuid::Uuid::new_v4().to_string();
    let token = tokio_util::sync::CancellationToken::new();
    state.builds.lock().unwrap().insert(build_id.clone(), (child.id(), token.clone()));

    let mut record = BuildRecord {
        id: build_id.clone(),
        config: config.clone(),
        status: "running".into(),
        started_at: now(),
        docker_context: Some(dctx.clone()),
        ..Default::default()
    };
    let _ = state.store.upsert_build_record(&record);
    let _ = channel.send(BuildEvent::Started { build_id: build_id.clone(), command: command_line });

    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    tauri::async_runtime::spawn(async move {
        let started = Instant::now();
        let mut vertices: HashMap<String, Vertex> = HashMap::new();
        let mut order = 0usize;
        let mut log_tail = String::new();
        let mut last_text = Vec::<String>::new();
        let mut lines_err = BufReader::new(stderr).lines();
        let mut lines_out = BufReader::new(stdout).lines();
        let (mut e_done, mut o_done) = (false, false);
        let b64 = base64::engine::general_purpose::STANDARD;
        let mut canceled = false;
        while !(e_done && o_done) {
            let line = tokio::select! {
                _ = token.cancelled(), if !canceled => {
                    canceled = true;
                    if let Some(pid) = child.id() {
                        unsafe { libc::kill(pid as i32, libc::SIGINT); }
                    }
                    let _ = channel.send(BuildEvent::Text { line: "Canceling build...".into() });
                    continue;
                }
                l = lines_err.next_line(), if !e_done => match l { Ok(Some(l)) => l, _ => { e_done = true; continue; } },
                l = lines_out.next_line(), if !o_done => match l { Ok(Some(l)) => l, _ => { o_done = true; continue; } },
            };
            match serde_json::from_str::<serde_json::Value>(&line) {
                Ok(v) if v.is_object() => {
                    if let Some(vs) = v.get("vertexes").and_then(|x| x.as_array()) {
                        for vx in vs {
                            let digest = vx.get("digest").and_then(|d| d.as_str()).unwrap_or_default().to_string();
                            let e = vertices.entry(digest).or_insert_with(|| {
                                order += 1;
                                Vertex { order, ..Default::default() }
                            });
                            if let Some(n) = vx.get("name").and_then(|x| x.as_str()) { e.name = n.into(); }
                            if let Some(s) = vx.get("started").and_then(|x| x.as_str()) { e.started = Some(s.into()); }
                            if let Some(s) = vx.get("completed").and_then(|x| x.as_str()) { e.completed = Some(s.into()); }
                            if vx.get("cached").and_then(|x| x.as_bool()).unwrap_or(false) { e.cached = true; }
                            if let Some(s) = vx.get("error").and_then(|x| x.as_str()) { e.error = Some(s.into()); }
                        }
                    }
                    if let Some(logs) = v.get("logs").and_then(|x| x.as_array()) {
                        for l in logs {
                            if let Some(data) = l.get("data").and_then(|x| x.as_str()) {
                                if let Ok(bytes) = b64.decode(data) {
                                    let step = l.get("vertex").and_then(|x| x.as_str()).and_then(|d| vertices.get(d)).map(|v| v.order).unwrap_or(0);
                                    for t in String::from_utf8_lossy(&bytes).lines() {
                                        log_tail.push_str(&format!("#{step} {t}\n"));
                                    }
                                }
                            }
                        }
                        if log_tail.len() > 256 * 1024 {
                            let cut = log_tail.len() - 200 * 1024;
                            let cut = log_tail[cut..].find('\n').map(|p| cut + p + 1).unwrap_or(cut);
                            log_tail.drain(..cut);
                        }
                    }
                    let _ = channel.send(BuildEvent::Status { status: v });
                }
                _ => {
                    last_text.push(line.clone());
                    if last_text.len() > 30 { last_text.remove(0); }
                    log_tail.push_str(&line);
                    log_tail.push('\n');
                    let _ = channel.send(BuildEvent::Text { line });
                }
            }
        }
        let status = child.wait().await.ok();
        let success = status.map(|s| s.success()).unwrap_or(false);
        let meta: serde_json::Value = std::fs::read_to_string(&meta_file).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        let _ = std::fs::remove_file(&meta_file);

        let mut steps: Vec<(usize, BuildStepRecord)> = vertices
            .values()
            .map(|v| (v.order, BuildStepRecord {
                name: v.name.clone(),
                cached: v.cached,
                error: v.error.clone(),
                duration_ms: match (&v.started, &v.completed) { (Some(a), Some(b)) => ms_between(a, b), _ => None },
            }))
            .collect();
        steps.sort_by_key(|s| s.0);
        let step_error = vertices.values().filter_map(|v| v.error.clone()).find(|e| !e.contains("context canceled"));
        record.steps = steps.into_iter().map(|s| s.1).collect();
        record.finished_at = Some(now());
        record.duration_ms = Some(started.elapsed().as_millis() as i64);
        record.log_tail = log_tail;
        record.image_id = meta.get("containerimage.config.digest").and_then(|x| x.as_str()).map(String::from);
        record.build_ref = meta.get("buildx.build.ref").and_then(|x| x.as_str()).map(|s| s.rsplit('/').next().unwrap_or(s).to_string());
        if record.build_ref.is_none() {
            // Failed or canceled builds write no metadata; find their BuildKit history entry instead.
            record.build_ref = find_history_ref(&app, &record.started_at, &record.config.context_dir).await;
        }
        record.status = if canceled { "canceled" } else if success { "succeeded" } else { "failed" }.into();
        if !success && !canceled {
            record.error = step_error.or_else(|| last_text.iter().rev().find(|l| l.contains("ERROR")).cloned()).or_else(|| last_text.last().cloned());
        }
        let st = app.state::<AppState>();
        let _ = st.store.upsert_build_record(&record);
        st.builds.lock().unwrap().remove(&record.id);
        let _ = channel.send(BuildEvent::Done { record });
    });
    Ok(build_id)
}

async fn find_history_ref(app: &tauri::AppHandle, started_at: &str, context_dir: &str) -> Option<String> {
    let st = app.state::<AppState>();
    let out = run_cli(&st, &["buildx", "history", "ls", "--format", "json"]).await.ok()?;
    let started = chrono::DateTime::parse_from_rfc3339(started_at).ok()?;
    let base = std::path::Path::new(context_dir).file_name()?.to_string_lossy().to_string();
    out.lines()
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .filter(|v| v.get("name").and_then(|n| n.as_str()) == Some(base.as_str()))
        .filter(|v| {
            v.get("created_at")
                .and_then(|c| c.as_str())
                .and_then(|c| chrono::DateTime::parse_from_rfc3339(c).ok())
                .map(|c| (c - started).num_seconds() >= -2)
                .unwrap_or(false)
        })
        .filter_map(|v| v.get("ref").and_then(|r| r.as_str()).map(|r| r.rsplit('/').next().unwrap_or(r).to_string()))
        .next()
}

#[tauri::command]
pub fn build_cancel(state: State<'_, AppState>, id: String) -> bool {
    match state.builds.lock().unwrap().get(&id) {
        Some((_, token)) => {
            token.cancel();
            true
        }
        None => false,
    }
}

#[tauri::command]
pub fn build_records(state: State<'_, AppState>) -> Vec<BuildRecord> {
    let running: Vec<String> = state.builds.lock().unwrap().keys().cloned().collect();
    state
        .store
        .build_records()
        .into_iter()
        .map(|mut r| {
            // A record left "running" by a previous session never finished here.
            if r.status == "running" && !running.contains(&r.id) {
                r.status = "interrupted".into();
            }
            r
        })
        .collect()
}

#[tauri::command]
pub fn delete_build_records(state: State<'_, AppState>, ids: Vec<String>) -> AppResult<()> {
    state.store.delete_build_records(&ids)?;
    Ok(())
}

#[tauri::command]
pub fn build_configs(state: State<'_, AppState>) -> Vec<BuildConfig> {
    state.store.build_configs()
}

#[tauri::command]
pub fn save_build_config(state: State<'_, AppState>, mut config: BuildConfig) -> AppResult<Vec<BuildConfig>> {
    if config.id.is_empty() {
        config.id = uuid::Uuid::new_v4().to_string();
    }
    config.updated_at = Some(now());
    Ok(state.store.save_build_config(config)?)
}

#[tauri::command]
pub fn delete_build_config(state: State<'_, AppState>, id: String) -> AppResult<Vec<BuildConfig>> {
    Ok(state.store.delete_build_config(&id)?)
}

async fn run_cli(state: &AppState, args: &[&str]) -> AppResult<String> {
    let (ctx, host) = state.docker.endpoint();
    let mut cmd = crate::docker::cli::command(&ctx, &host).map_err(other)?;
    let out = tokio::time::timeout(std::time::Duration::from_secs(30), cmd.args(args).output())
        .await
        .map_err(|_| other("docker buildx timed out"))??;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(other(if err.is_empty() { format!("docker {} failed", args.join(" ")) } else { err }));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// BuildKit's own build history for the active builder (`docker buildx history ls`).
#[tauri::command]
pub async fn buildkit_history(state: State<'_, AppState>) -> AppResult<Vec<serde_json::Value>> {
    let out = run_cli(&state, &["buildx", "history", "ls", "--format", "json"]).await?;
    Ok(out.lines().filter_map(|l| serde_json::from_str(l).ok()).collect())
}

#[tauri::command]
pub async fn buildkit_history_inspect(state: State<'_, AppState>, reference: String) -> AppResult<serde_json::Value> {
    let out = run_cli(&state, &["buildx", "history", "inspect", &reference, "--format", "json"]).await?;
    Ok(serde_json::from_str(&out)?)
}

#[tauri::command]
pub async fn buildkit_history_logs(state: State<'_, AppState>, reference: String) -> AppResult<String> {
    run_cli(&state, &["buildx", "history", "logs", &reference]).await
}

#[tauri::command]
pub async fn buildkit_history_remove(state: State<'_, AppState>, references: Vec<String>) -> AppResult<()> {
    let mut args = vec!["buildx", "history", "rm"];
    args.extend(references.iter().map(String::as_str));
    run_cli(&state, &args).await?;
    Ok(())
}
