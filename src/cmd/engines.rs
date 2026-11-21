//! Docker engines Berth can use. Berth is a client: on macOS the containers run in a
//! Linux VM provided by an engine (OrbStack, Colima, Docker Desktop...). This module
//! detects engines and can install / start / stop Colima, the open-source option,
//! so OrbStack can be replaced.

use crate::error::AppResult;
use crate::state::AppState;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::ipc::Channel;
use tauri::{Manager, State};
use tokio::io::{AsyncBufReadExt, BufReader};

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

fn tool_dirs() -> Vec<PathBuf> {
    vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        home().join(".local/bin"),
        PathBuf::from("/usr/bin"),
        PathBuf::from("/bin"),
        PathBuf::from("/usr/sbin"),
        PathBuf::from("/sbin"),
    ]
}

fn find_tool(name: &str) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    dirs.extend(tool_dirs());
    dirs.into_iter().map(|d| d.join(name)).find(|p| p.is_file())
}

fn tool_path_env() -> std::ffi::OsString {
    let mut dirs = tool_dirs();
    if let Some(p) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&p));
    }
    std::env::join_paths(dirs).unwrap_or_default()
}

fn socket_alive(path: &Path) -> bool {
    std::os::unix::net::UnixStream::connect(path).is_ok()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    pub id: String,
    pub name: String,
    pub installed: bool,
    pub running: bool,
    pub socket: String,
    /// Docker context Berth switches to for this engine.
    pub context: String,
    pub open_source: bool,
    pub note: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnginesOverview {
    pub engines: Vec<EngineInfo>,
    pub brew: Option<String>,
    pub docker_cli: Option<String>,
    /// The `docker` command (or its buildx/compose plugins) lives inside OrbStack and stops working without it.
    pub cli_depends_on_orbstack: bool,
    pub buildx_available: bool,
}

fn resolves_into_orbstack(p: &Path) -> bool {
    std::fs::canonicalize(p)
        .map(|c| c.to_string_lossy().contains("OrbStack.app") || c.to_string_lossy().contains("/.orbstack/"))
        .unwrap_or(false)
        || p.to_string_lossy().contains(".orbstack")
}

#[tauri::command]
pub fn engines_overview() -> EnginesOverview {
    let h = home();
    let orb_sock = h.join(".orbstack/run/docker.sock");
    let colima_sock = h.join(".colima/default/docker.sock");
    let desktop_sock = h.join(".docker/run/docker.sock");
    let engines = vec![
        EngineInfo {
            id: "colima".into(),
            name: "Colima".into(),
            installed: find_tool("colima").is_some(),
            running: socket_alive(&colima_sock),
            socket: colima_sock.display().to_string(),
            context: "colima".into(),
            open_source: true,
            note: "Free and open source. Runs Docker in a lightweight Linux VM (Apple Virtualization). Berth can install, start and stop it.".into(),
        },
        EngineInfo {
            id: "orbstack".into(),
            name: "OrbStack".into(),
            installed: Path::new("/Applications/OrbStack.app").exists(),
            running: socket_alive(&orb_sock),
            socket: orb_sock.display().to_string(),
            context: "orbstack".into(),
            open_source: false,
            note: "Commercial app with its own UI. Started and stopped from OrbStack itself.".into(),
        },
        EngineInfo {
            id: "desktop".into(),
            name: "Docker Desktop".into(),
            installed: Path::new("/Applications/Docker.app").exists(),
            running: socket_alive(&desktop_sock),
            socket: desktop_sock.display().to_string(),
            context: "desktop-linux".into(),
            open_source: false,
            note: "Docker's own app; needs a paid plan in larger companies.".into(),
        },
    ];
    let docker = crate::docker::cli::find_docker();
    let plugin_links = [h.join(".docker/cli-plugins/docker-buildx"), h.join(".docker/cli-plugins/docker-compose")];
    let cli_depends = docker.as_deref().map(resolves_into_orbstack).unwrap_or(false)
        || plugin_links.iter().any(|p| p.exists() && resolves_into_orbstack(p));
    let buildx = plugin_links[0].exists()
        || find_tool("docker-buildx").is_some()
        || Path::new("/opt/homebrew/lib/docker/cli-plugins/docker-buildx").exists()
        || Path::new("/usr/local/lib/docker/cli-plugins/docker-buildx").exists();
    EnginesOverview {
        engines,
        brew: find_tool("brew").map(|p| p.display().to_string()),
        docker_cli: docker.map(|p| p.display().to_string()),
        cli_depends_on_orbstack: cli_depends,
        buildx_available: buildx,
    }
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum EngineEvent {
    Line { line: String },
    Done { ok: bool, error: Option<String> },
}

/// Make the Homebrew Docker CLI find Homebrew's buildx/compose plugins (Homebrew's own instruction),
/// keeping a backup of the user's Docker config.
fn ensure_plugin_dir(brew_prefix: &str) -> Result<String, String> {
    let dir = format!("{brew_prefix}/lib/docker/cli-plugins");
    let cfg_path = crate::docker::context::config_dir().join("config.json");
    let mut cfg: serde_json::Value = std::fs::read_to_string(&cfg_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    let list = cfg.get("cliPluginsExtraDirs").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    if list.iter().any(|v| v.as_str() == Some(&dir)) {
        return Ok(format!("Docker already looks for plugins in {dir}"));
    }
    if cfg_path.exists() {
        std::fs::copy(&cfg_path, cfg_path.with_extension("json.berth-backup")).map_err(|e| e.to_string())?;
    } else if let Some(parent) = cfg_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut list = list;
    list.insert(0, serde_json::Value::String(dir.clone()));
    cfg["cliPluginsExtraDirs"] = serde_json::Value::Array(list);
    std::fs::write(&cfg_path, serde_json::to_vec_pretty(&cfg).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(format!("Added {dir} to cliPluginsExtraDirs in {} (backup: config.json.berth-backup)", cfg_path.display()))
}

async fn stream_cmd(
    mut cmd: tokio::process::Command,
    channel: &Channel<EngineEvent>,
    token: &tokio_util::sync::CancellationToken,
) -> Result<(), String> {
    cmd.env("PATH", tool_path_env())
        .env("HOMEBREW_NO_ENV_HINTS", "1")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let mut out = BufReader::new(child.stdout.take().unwrap()).lines();
    let mut err = BufReader::new(child.stderr.take().unwrap()).lines();
    let (mut od, mut ed) = (false, false);
    let mut last = String::new();
    while !(od && ed) {
        tokio::select! {
            _ = token.cancelled() => { let _ = child.start_kill(); return Err("Canceled".into()); }
            l = out.next_line(), if !od => match l { Ok(Some(l)) => { let _ = channel.send(EngineEvent::Line { line: l }); } _ => od = true },
            l = err.next_line(), if !ed => match l { Ok(Some(l)) => { last = l.clone(); let _ = channel.send(EngineEvent::Line { line: l }); } _ => ed = true },
        }
    }
    let status = child.wait().await.map_err(|e| e.to_string())?;
    if status.success() { Ok(()) } else { Err(if last.is_empty() { format!("exited with {status}") } else { last }) }
}

/// `task`: "install-colima" | "start-colima" | "stop-colima". Returns an op id for `cancel_op`.
#[tauri::command]
pub async fn engine_task(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    task: String,
    cpus: Option<u32>,
    memory_gb: Option<u32>,
    disk_gb: Option<u32>,
    channel: Channel<EngineEvent>,
) -> AppResult<String> {
    let (op, token) = state.register_op();
    let task_name = task.clone();
    tauri::async_runtime::spawn(async move {
        let result: Result<(), String> = async {
            match task_name.as_str() {
                "install-colima" => {
                    let brew = find_tool("brew").ok_or("Homebrew isn't installed. Get it from https://brew.sh, then try again.")?;
                    let mut cmd = tokio::process::Command::new(&brew);
                    cmd.args(["install", "colima", "docker", "docker-buildx", "docker-compose"]);
                    let _ = channel.send(EngineEvent::Line { line: "$ brew install colima docker docker-buildx docker-compose".into() });
                    stream_cmd(cmd, &channel, &token).await?;
                    let prefix = brew.parent().and_then(|p| p.parent()).map(|p| p.display().to_string()).unwrap_or_else(|| "/opt/homebrew".into());
                    let msg = ensure_plugin_dir(&prefix)?;
                    let _ = channel.send(EngineEvent::Line { line: msg });
                    Ok(())
                }
                "start-colima" => {
                    let colima = find_tool("colima").ok_or("Colima isn't installed yet.")?;
                    let mut cmd = tokio::process::Command::new(colima);
                    let args = vec![
                        "start".to_string(),
                        "--cpu".into(), cpus.unwrap_or(4).to_string(),
                        "--memory".into(), memory_gb.unwrap_or(8).to_string(),
                        "--disk".into(), disk_gb.unwrap_or(60).to_string(),
                        "--vm-type".into(), "vz".into(),
                        "--mount-type".into(), "virtiofs".into(),
                    ];
                    let _ = channel.send(EngineEvent::Line { line: format!("$ colima {}", args.join(" ")) });
                    cmd.args(&args);
                    stream_cmd(cmd, &channel, &token).await
                }
                "stop-colima" => {
                    let colima = find_tool("colima").ok_or("Colima isn't installed.")?;
                    let mut cmd = tokio::process::Command::new(colima);
                    cmd.arg("stop");
                    let _ = channel.send(EngineEvent::Line { line: "$ colima stop".into() });
                    stream_cmd(cmd, &channel, &token).await
                }
                t => Err(format!("Unknown task {t}")),
            }
        }
        .await;
        // Switch Berth to Colima once it runs.
        if result.is_ok() && task_name == "start-colima" {
            let st = app.state::<AppState>();
            let mut prefs = st.store.prefs();
            prefs.context = Some("colima".into());
            let _ = st.store.set_prefs(&prefs);
            st.docker.set_context(Some("colima".into()));
        }
        let _ = channel.send(EngineEvent::Done { ok: result.is_ok(), error: result.err() });
    });
    Ok(op)
}
