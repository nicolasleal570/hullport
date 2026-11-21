//! Hullport's own Docker engine: a Lima VM under ~/.hullport (see engine/hullport.yaml).
//!
//! The app owns the VM. With vmType vz the VM runs inside Lima's host agent process, and
//! `limactl start --foreground` turns itself into that host agent, so the VM is a child of
//! this app. A VM already running when the app starts (after a crash, or started by
//! scripts/engine.sh) is adopted, and Quit stops it the same way.

use serde::Serialize;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const INSTANCE: &str = "hullport";
/// The disk with Docker's data (see engine/hullport.yaml).
const DATA_DISK: &str = "hullport-data";
const START_TIMEOUT: Duration = Duration::from_secs(300);
const EXIT_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum EngineState {
    NotInstalled,
    Stopped,
    Starting,
    Running,
    Stopping,
    Failed,
}

impl EngineState {
    pub fn label(self) -> &'static str {
        match self {
            EngineState::NotInstalled => "Not installed",
            EngineState::Stopped => "Stopped",
            EngineState::Starting => "Starting…",
            EngineState::Running => "Running",
            EngineState::Stopping => "Stopping…",
            EngineState::Failed => "Failed",
        }
    }
}

pub struct Engine {
    home: PathBuf,
    child: Mutex<Option<Child>>,
    state: Mutex<EngineState>,
    last_error: Mutex<Option<String>>,
}

impl Engine {
    pub fn new() -> Self {
        let engine = Self { home: home(), child: Mutex::new(None), state: Mutex::new(EngineState::Stopped), last_error: Mutex::new(None) };
        engine.refresh();
        engine
    }

    pub fn socket(&self) -> PathBuf {
        self.home.join("run/docker.sock")
    }

    fn limactl(&self) -> PathBuf {
        self.home.join("lima/bin/limactl")
    }

    fn lima_home(&self) -> PathBuf {
        self.home.join("vm")
    }

    fn command(&self) -> Command {
        let mut c = Command::new(self.limactl());
        c.env("LIMA_HOME", self.lima_home()).arg("--tty=false").stdin(Stdio::null());
        c
    }

    /// The VM was installed and created once with scripts/engine.sh.
    pub fn installed(&self) -> bool {
        self.limactl().exists() && self.lima_home().join(INSTANCE).join("lima.yaml").exists()
    }

    /// What Lima reports for the VM ("Running", "Stopped", "Broken"), if it can be asked.
    fn lima_status(&self) -> Option<String> {
        let out = self.command().args(["list", "--json", INSTANCE]).stderr(Stdio::null()).output().ok()?;
        let v: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
        v.get("status").and_then(|s| s.as_str()).map(String::from)
    }

    pub fn state(&self) -> EngineState {
        *self.state.lock().unwrap()
    }

    pub fn last_error(&self) -> Option<String> {
        self.last_error.lock().unwrap().clone()
    }

    fn set(&self, s: EngineState) {
        *self.state.lock().unwrap() = s;
    }

    fn fail(&self, msg: String) -> String {
        *self.last_error.lock().unwrap() = Some(msg.clone());
        self.set(EngineState::Failed);
        msg
    }

    /// Re-read the state from Lima, unless a start or stop is in progress.
    pub fn refresh(&self) -> EngineState {
        let current = self.state();
        if matches!(current, EngineState::Starting | EngineState::Stopping) {
            return current;
        }
        // Reap our host agent if it exited on its own.
        {
            let mut child = self.child.lock().unwrap();
            if matches!(child.as_mut().map(|c| c.try_wait()), Some(Ok(Some(_)))) {
                *child = None;
            }
        }
        let next = if !self.installed() {
            EngineState::NotInstalled
        } else {
            match self.lima_status().as_deref() {
                Some("Running") if self.docker_ready() => EngineState::Running,
                Some("Running") => EngineState::Starting,
                Some("Stopped") => EngineState::Stopped,
                _ if current == EngineState::Failed => EngineState::Failed,
                _ => EngineState::Stopped,
            }
        };
        self.set(next);
        next
    }

    /// Docker answers `GET /_ping` on the socket. Lima creates the socket before dockerd is up.
    fn docker_ready(&self) -> bool {
        let Ok(mut s) = UnixStream::connect(self.socket()) else { return false };
        let _ = s.set_read_timeout(Some(Duration::from_secs(2)));
        if s.write_all(b"GET /_ping HTTP/1.0\r\nHost: docker\r\n\r\n").is_err() {
            return false;
        }
        let mut buf = [0u8; 64];
        matches!(s.read(&mut buf), Ok(n) if n > 0 && buf[..n].windows(6).any(|w| w == b"200 OK"))
    }

    /// Start the VM and wait until Docker answers. Blocks, so call it off the main thread.
    pub fn start(&self) -> Result<(), String> {
        if !self.installed() {
            self.set(EngineState::NotInstalled);
            return Err(format!("the engine isn't installed in {} (run scripts/engine.sh install && scripts/engine.sh start)", self.home.display()));
        }
        if self.refresh() == EngineState::Running {
            return Ok(());
        }
        self.set(EngineState::Starting);
        *self.last_error.lock().unwrap() = None;
        if self.lima_status().as_deref() != Some("Running") {
            let child = self
                .command()
                .args(["start", "--foreground", INSTANCE])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|e| self.fail(format!("could not run limactl: {e}")))?;
            *self.child.lock().unwrap() = Some(child);
        }
        let deadline = Instant::now() + START_TIMEOUT;
        while Instant::now() < deadline {
            if let Some(child) = self.child.lock().unwrap().as_mut() {
                if let Ok(Some(status)) = child.try_wait() {
                    return Err(self.fail(format!("the host agent exited ({status}); see {}", self.ha_log().display())));
                }
            }
            if self.lima_status().as_deref() == Some("Running") && self.docker_ready() {
                self.set(EngineState::Running);
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        Err(self.fail(format!("Docker didn't answer within {} s; see {}", START_TIMEOUT.as_secs(), self.ha_log().display())))
    }

    /// Shut the VM down cleanly (Lima asks the guest to power off) and wait for the host agent.
    /// Blocks for up to a few seconds; safe to call when the VM isn't running.
    pub fn stop(&self) -> Result<(), String> {
        if !self.installed() || self.lima_status().as_deref() != Some("Running") {
            self.refresh();
            return Ok(());
        }
        self.set(EngineState::Stopping);
        let out = self.command().args(["stop", INSTANCE]).output().map_err(|e| self.fail(format!("could not run limactl: {e}")))?;
        if !out.status.success() {
            return Err(self.fail(format!("limactl stop failed: {}", String::from_utf8_lossy(&out.stderr).trim())));
        }
        if let Some(mut child) = self.child.lock().unwrap().take() {
            let deadline = Instant::now() + EXIT_TIMEOUT;
            while Instant::now() < deadline && matches!(child.try_wait(), Ok(None)) {
                std::thread::sleep(Duration::from_millis(200));
            }
        }
        self.set(EngineState::Stopped);
        Ok(())
    }

    /// CPUs and memory from the VM's config, and the size of the disk that holds Docker's data,
    /// e.g. ("4", "8GiB", "60GiB").
    pub fn resources(&self) -> Option<(String, String, String)> {
        let yaml = std::fs::read_to_string(self.lima_home().join(INSTANCE).join("lima.yaml")).ok()?;
        let top = |key: &str| {
            yaml.lines()
                .find_map(|l| l.strip_prefix(key).and_then(|v| v.strip_prefix(':')))
                .map(|v| v.split('#').next().unwrap_or("").trim().trim_matches('"').to_string())
                .filter(|v| !v.is_empty())
        };
        // A sparse file: its length is the disk's size, not the space it takes on the Mac.
        let data = std::fs::metadata(self.lima_home().join("_disks").join(DATA_DISK).join("datadisk")).ok()?;
        Some((top("cpus")?, top("memory")?, format!("{}GiB", data.len() >> 30)))
    }

    fn ha_log(&self) -> PathBuf {
        self.lima_home().join(INSTANCE).join("ha.stderr.log")
    }
}

/// `$HULLPORT_HOME`, or ~/.hullport.
pub fn home() -> PathBuf {
    std::env::var_os("HULLPORT_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| PathBuf::from("/")).join(".hullport"))
}
