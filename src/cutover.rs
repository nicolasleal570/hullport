//! Switching the terminal's Docker over to Hullport ("cutover"), and back.
//!
//! What changes: the `hullport` Docker context becomes the current one (`orbstack` is kept), and
//! the `docker` CLI, its compose/buildx plugins, the keychain credential helper and the system
//! socket `/var/run/docker.sock` point at Hullport's. Before anything changes, what each path held
//! is recorded in ~/.hullport/cutover.json, so `revert` restores exactly that. The paths owned by
//! root are changed first, with a single administrator prompt: if it's canceled, nothing changed.

use crate::engine;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;

const CONTEXT: &str = "hullport";

struct Link {
    path: PathBuf,
    target: PathBuf,
    admin: bool,
}

fn links() -> Vec<Link> {
    let home = dirs::home_dir().unwrap_or_default();
    let h = engine::home();
    let user = |path: PathBuf, target: PathBuf| Link { path, target, admin: false };
    let admin = |path: &str, target: PathBuf| Link { path: PathBuf::from(path), target, admin: true };
    vec![
        admin("/var/run/docker.sock", h.join("run/docker.sock")),
        admin("/usr/local/bin/docker", h.join("bin/docker")),
        admin("/usr/local/bin/docker-credential-osxkeychain", h.join("bin/docker-credential-osxkeychain")),
        user(home.join(".local/bin/docker"), h.join("bin/docker")),
        user(home.join(".local/bin/docker-credential-osxkeychain"), h.join("bin/docker-credential-osxkeychain")),
        user(home.join(".docker/cli-plugins/docker-buildx"), h.join("docker/cli-plugins/docker-buildx")),
        user(home.join(".docker/cli-plugins/docker-compose"), h.join("docker/cli-plugins/docker-compose")),
    ]
}

/// What a path held before the cutover.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Before {
    Missing,
    Symlink { target: String },
    /// A regular file, moved aside to `backup`.
    File { backup: String },
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub path: String,
    pub admin: bool,
    pub before: Before,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub applied_at: String,
    pub previous_context: String,
    pub entries: Vec<Entry>,
}

fn manifest_path() -> PathBuf {
    engine::home().join("cutover.json")
}

fn backup_dir() -> PathBuf {
    engine::home().join("backup")
}

fn read_manifest() -> Option<Manifest> {
    serde_json::from_str(&std::fs::read_to_string(manifest_path()).ok()?).ok()
}

fn before(path: &Path) -> Before {
    match std::fs::symlink_metadata(path) {
        Err(_) => Before::Missing,
        Ok(m) if m.file_type().is_symlink() => Before::Symlink { target: std::fs::read_link(path).map(|t| t.display().to_string()).unwrap_or_default() },
        // Named after the whole path: /usr/local/bin/docker and ~/.local/bin/docker mustn't collide.
        Ok(_) => Before::File { backup: backup_dir().join(path.display().to_string().trim_start_matches('/').replace('/', "_")).display().to_string() },
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathStatus {
    pub path: String,
    /// Where the path leads now, if it's a symlink.
    pub points_to: Option<String>,
    pub exists: bool,
    pub is_hullport: bool,
    pub admin: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CutoverStatus {
    pub applied: bool,
    pub applied_at: Option<String>,
    pub current_context: String,
    pub paths: Vec<PathStatus>,
    /// Everything points at Hullport.
    pub complete: bool,
}

pub fn status() -> CutoverStatus {
    let manifest = read_manifest();
    let paths: Vec<PathStatus> = links()
        .into_iter()
        .map(|l| {
            let points_to = std::fs::read_link(&l.path).ok();
            PathStatus {
                path: l.path.display().to_string(),
                exists: std::fs::symlink_metadata(&l.path).is_ok(),
                is_hullport: points_to.as_deref() == Some(l.target.as_path()),
                points_to: points_to.map(|p| p.display().to_string()),
                admin: l.admin,
            }
        })
        .collect();
    let current_context = crate::docker::context::cli_current_context_in(&home_docker_config());
    let complete = current_context == CONTEXT && paths.iter().all(|p| p.is_hullport);
    CutoverStatus { applied: manifest.is_some(), applied_at: manifest.map(|m| m.applied_at), current_context, paths, complete }
}

/// The user's own Docker config folder, whatever DOCKER_CONFIG this process runs with.
fn home_docker_config() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".docker")
}

/// Hullport's CLI working on the user's own ~/.docker (not Hullport's private config).
fn user_cli() -> Command {
    let mut c = Command::new(engine::home().join("bin/docker"));
    c.env("DOCKER_CONFIG", home_docker_config()).env_remove("DOCKER_HOST").env_remove("DOCKER_CONTEXT");
    c
}

fn run(mut c: Command, what: &str) -> Result<(), String> {
    let out = c.output().map_err(|e| format!("{what}: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!("{what}: {}", String::from_utf8_lossy(&out.stderr).trim()))
    }
}

fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Run a shell script as root, behind one macOS administrator prompt.
fn run_as_admin(script: &str, prompt: &str) -> Result<(), String> {
    let esc = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
    let apple = format!("do shell script \"{}\" with prompt \"{}\" with administrator privileges", esc(script), esc(prompt));
    let out = Command::new("/usr/bin/osascript").arg("-e").arg(apple).output().map_err(|e| e.to_string())?;
    if out.status.success() {
        return Ok(());
    }
    let err = String::from_utf8_lossy(&out.stderr);
    Err(if err.contains("-128") { "canceled at the administrator prompt; nothing was changed".into() } else { err.trim().to_string() })
}

/// Shell commands that put `path` in place as a symlink to `target`, moving a regular file aside.
fn link_commands(path: &str, target: &str, before: &Before) -> String {
    let (p, t) = (sh_quote(path), sh_quote(target));
    let dir = sh_quote(&Path::new(path).parent().unwrap_or(Path::new("/")).display().to_string());
    let aside = match before {
        Before::File { backup } => format!("mkdir -p {} && mv -f {p} {} && ", sh_quote(&backup_dir().display().to_string()), sh_quote(backup)),
        _ => String::new(),
    };
    format!("{aside}mkdir -p {dir} && ln -sfn {t} {p}")
}

/// Shell commands that put back what `path` held before the cutover.
fn restore_commands(path: &str, before: &Before) -> String {
    let p = sh_quote(path);
    match before {
        Before::Missing => format!("rm -f {p}"),
        Before::Symlink { target } => format!("ln -sfn {} {p}", sh_quote(target)),
        Before::File { backup } => format!("rm -f {p} && mv -f {} {p}", sh_quote(backup)),
    }
}

fn run_user(script: &str) -> Result<(), String> {
    let out = Command::new("/bin/sh").arg("-c").arg(script).output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

pub fn apply() -> Result<CutoverStatus, String> {
    if read_manifest().is_some() {
        return Err("the terminal already uses Hullport; undo it first to apply it again".into());
    }
    let h = engine::home();
    for bin in ["bin/docker", "bin/docker-credential-osxkeychain", "docker/cli-plugins/docker-compose", "docker/cli-plugins/docker-buildx"] {
        if !h.join(bin).exists() {
            return Err(format!("{} is missing; install the engine first (scripts/engine.sh install)", h.join(bin).display()));
        }
    }
    let previous_context = crate::docker::context::cli_current_context_in(&home_docker_config());
    let plan: Vec<(Link, Before)> = links().into_iter().map(|l| { let b = before(&l.path); (l, b) }).collect();
    let entries: Vec<Entry> = plan.iter().map(|(l, b)| Entry { path: l.path.display().to_string(), admin: l.admin, before: b.clone() }).collect();

    // Root-owned paths first: a canceled prompt leaves everything as it was.
    let admin: Vec<String> = plan.iter().filter(|(l, _)| l.admin).map(|(l, b)| link_commands(&l.path.display().to_string(), &l.target.display().to_string(), b)).collect();
    run_as_admin(&admin.join(" && "), "Hullport wants to point the system Docker socket and command line at its own engine.")?;

    let manifest = Manifest { applied_at: chrono::Local::now().to_rfc3339(), previous_context, entries };
    std::fs::write(manifest_path(), serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;

    let user: Vec<String> = plan.iter().filter(|(l, _)| !l.admin).map(|(l, b)| link_commands(&l.path.display().to_string(), &l.target.display().to_string(), b)).collect();
    run_user(&user.join(" && "))?;

    let host = format!("host=unix://{}", h.join("run/docker.sock").display());
    let mut inspect = user_cli();
    inspect.args(["context", "inspect", CONTEXT]);
    if !inspect.output().map(|o| o.status.success()).unwrap_or(false) {
        let mut create = user_cli();
        create.args(["context", "create", CONTEXT, "--description", "Hullport", "--docker", &host]);
        run(create, "creating the hullport context")?;
    }
    let mut use_it = user_cli();
    use_it.args(["context", "use", CONTEXT]);
    run(use_it, "switching to the hullport context")?;
    Ok(status())
}

pub fn revert() -> Result<CutoverStatus, String> {
    let manifest = read_manifest().ok_or("the terminal doesn't use Hullport (no cutover to undo)")?;
    let admin: Vec<String> = manifest.entries.iter().filter(|e| e.admin).map(|e| restore_commands(&e.path, &e.before)).collect();
    if !admin.is_empty() {
        run_as_admin(&admin.join(" && "), "Hullport wants to put back the system Docker socket and command line as they were.")?;
    }
    let user: Vec<String> = manifest.entries.iter().filter(|e| !e.admin).map(|e| restore_commands(&e.path, &e.before)).collect();
    run_user(&user.join(" && "))?;
    let mut use_prev = user_cli();
    use_prev.args(["context", "use", &manifest.previous_context]);
    run(use_prev, "switching back to the previous context")?;
    std::fs::remove_file(manifest_path()).map_err(|e| e.to_string())?;
    Ok(status())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("hullport-cutover-test-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn link_and_restore_round_trip_for_every_kind_of_path() {
        let root = temp_dir();
        let target = root.join("hullport-docker");
        std::fs::write(&target, "new").unwrap();
        let old = root.join("orbstack-docker");
        std::fs::write(&old, "old").unwrap();

        let missing = root.join("bin/missing");
        let symlink = root.join("bin/symlink");
        let file = root.join("bin/file");
        std::fs::create_dir_all(root.join("bin")).unwrap();
        std::os::unix::fs::symlink(&old, &symlink).unwrap();
        std::fs::write(&file, "a regular file").unwrap();

        for path in [&missing, &symlink, &file] {
            let mut b = before(path);
            if let Before::File { backup } = &mut b {
                *backup = root.join("backup-file").display().to_string();
            }
            let p = path.display().to_string();
            run_user(&link_commands(&p, &target.display().to_string(), &b)).unwrap();
            assert_eq!(std::fs::read_link(path).unwrap(), target, "{p} points at Hullport");
            run_user(&restore_commands(&p, &b)).unwrap();
            assert_eq!(before(path) == Before::Missing, b == Before::Missing, "{p} back to how it was");
        }
        assert_eq!(std::fs::read_link(&symlink).unwrap(), old);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "a regular file");
        assert!(std::fs::symlink_metadata(&missing).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn quoting_survives_spaces_and_quotes() {
        assert_eq!(sh_quote("/a b/it's"), r"'/a b/it'\''s'");
    }
}
