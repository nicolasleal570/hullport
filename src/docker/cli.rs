//! Locating and invoking the Docker CLI (used for BuildKit/buildx features
//! and registry pulls that need the user's credential helpers).

use std::path::PathBuf;

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

fn candidate_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    let h = home();
    for d in [
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        h.join(".orbstack/bin"),
        h.join(".docker/bin"),
        h.join(".local/bin"),
        PathBuf::from("/Applications/OrbStack.app/Contents/MacOS/xbin"),
        PathBuf::from("/Applications/Docker.app/Contents/Resources/bin"),
        h.join(".rd/bin"),
    ] {
        if !dirs.contains(&d) {
            dirs.push(d);
        }
    }
    dirs
}

pub fn find_docker() -> Option<PathBuf> {
    candidate_dirs()
        .into_iter()
        .map(|d| d.join("docker"))
        .find(|p| p.is_file())
}

/// A `docker` command bound to the given context/endpoint.
pub fn command(context: &str, host: &str) -> Result<tokio::process::Command, String> {
    let bin = find_docker().ok_or_else(|| {
        "The Docker CLI was not found (looked in PATH, ~/.orbstack/bin, /usr/local/bin, /opt/homebrew/bin)."
            .to_string()
    })?;
    let mut cmd = tokio::process::Command::new(bin);
    let path = std::env::join_paths(candidate_dirs()).unwrap_or_default();
    cmd.env("PATH", path);
    cmd.env_remove("DOCKER_CONTEXT");
    cmd.env_remove("DOCKER_HOST");
    // Discovered sockets (Hullport's engine among them) aren't CLI contexts: point at the socket.
    if context.starts_with("socket:") || context == "default" || context == super::context::HULLPORT {
        cmd.env("DOCKER_HOST", host);
    } else {
        cmd.arg("--context").arg(context);
    }
    cmd.kill_on_drop(true);
    Ok(cmd)
}
