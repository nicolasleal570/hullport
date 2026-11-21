//! Discovery of Docker CLI contexts and well-known engine sockets.
//!
//! Mirrors how the Docker CLI resolves its endpoint: `DOCKER_HOST`, then
//! `DOCKER_CONTEXT`, then `currentContext` in `~/.docker/config.json`, with
//! context endpoints stored under `~/.docker/contexts/meta/<sha256>/meta.json`.

use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DockerContext {
    pub name: String,
    pub description: String,
    pub host: String,
    /// The context the Docker CLI would use right now.
    pub is_cli_current: bool,
    /// For unix sockets: whether the socket file exists.
    pub available: bool,
    /// "context" for CLI contexts, "socket" for auto-discovered sockets.
    pub source: String,
}

pub fn config_dir() -> PathBuf {
    std::env::var_os("DOCKER_CONFIG")
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(".docker"))
}

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

fn env_nonempty(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|s| !s.trim().is_empty())
}

fn default_host() -> String {
    env_nonempty("DOCKER_HOST").unwrap_or_else(|| "unix:///var/run/docker.sock".into())
}

/// The context name the Docker CLI would pick.
pub fn cli_current_context() -> String {
    if let Some(c) = env_nonempty("DOCKER_CONTEXT") {
        return c;
    }
    if env_nonempty("DOCKER_HOST").is_some() {
        return "default".into();
    }
    let cfg = config_dir().join("config.json");
    std::fs::read_to_string(cfg)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("currentContext").and_then(|c| c.as_str()).map(String::from))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "default".into())
}

fn socket_available(host: &str) -> bool {
    match host.strip_prefix("unix://") {
        Some(p) => Path::new(p).exists(),
        None => true,
    }
}

/// Well-known engine sockets on macOS (Hullport, OrbStack, Docker Desktop, Colima, Rancher, Podman).
fn well_known_sockets() -> Vec<(String, String, PathBuf)> {
    let h = home();
    vec![
        ("hullport".into(), "Hullport engine socket".into(), crate::engine::home().join("run/docker.sock")),
        ("orbstack".into(), "OrbStack engine socket".into(), h.join(".orbstack/run/docker.sock")),
        ("desktop".into(), "Docker Desktop engine socket".into(), h.join(".docker/run/docker.sock")),
        ("colima".into(), "Colima engine socket".into(), h.join(".colima/default/docker.sock")),
        ("rancher".into(), "Rancher Desktop engine socket".into(), h.join(".rd/docker.sock")),
        ("system".into(), "System engine socket".into(), PathBuf::from("/var/run/docker.sock")),
    ]
}

pub fn list_contexts() -> Vec<DockerContext> {
    let current = cli_current_context();
    let mut out = vec![DockerContext {
        name: "default".into(),
        description: "Current DOCKER_HOST based configuration".into(),
        host: default_host(),
        is_cli_current: false,
        available: false,
        source: "context".into(),
    }];

    let meta_dir = config_dir().join("contexts").join("meta");
    let mut found: Vec<DockerContext> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&meta_dir) {
        for entry in rd.flatten() {
            let file = entry.path().join("meta.json");
            let Ok(text) = std::fs::read_to_string(&file) else { continue };
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
            let Some(name) = v.get("Name").and_then(|n| n.as_str()) else { continue };
            let host = v
                .pointer("/Endpoints/docker/Host")
                .and_then(|h| h.as_str())
                .unwrap_or_default()
                .to_string();
            if host.is_empty() {
                continue;
            }
            let description = v
                .pointer("/Metadata/Description")
                .and_then(|d| d.as_str())
                .unwrap_or_default()
                .to_string();
            found.push(DockerContext {
                name: name.to_string(),
                description,
                host,
                is_cli_current: false,
                available: false,
                source: "context".into(),
            });
        }
    }
    found.sort_by(|a, b| a.name.cmp(&b.name));
    out.extend(found);

    // Sockets that exist but no context points at.
    for (key, desc, path) in well_known_sockets() {
        let host = format!("unix://{}", path.display());
        if path.exists() && !out.iter().any(|c| same_host(&c.host, &host)) {
            out.push(DockerContext {
                name: format!("socket:{key}"),
                description: desc,
                host,
                is_cli_current: false,
                available: true,
                source: "socket".into(),
            });
        }
    }

    for c in out.iter_mut() {
        c.is_cli_current = c.name == current;
        c.available = socket_available(&c.host);
    }
    out
}

fn same_host(a: &str, b: &str) -> bool {
    let canon = |h: &str| -> String {
        match h.strip_prefix("unix://") {
            Some(p) => std::fs::canonicalize(p)
                .map(|x| x.display().to_string())
                .unwrap_or_else(|_| p.to_string()),
            None => h.to_string(),
        }
    };
    canon(a) == canon(b)
}

/// Resolve a context name to its endpoint. Falls back to the CLI's current context.
pub fn resolve(preferred: Option<&str>) -> (String, String) {
    let contexts = list_contexts();
    let wanted = preferred
        .map(String::from)
        .unwrap_or_else(cli_current_context);
    if let Some(c) = contexts.iter().find(|c| c.name == wanted) {
        return (c.name.clone(), c.host.clone());
    }
    let cur = cli_current_context();
    if let Some(c) = contexts.iter().find(|c| c.name == cur) {
        return (c.name.clone(), c.host.clone());
    }
    ("default".into(), default_host())
}
