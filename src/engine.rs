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

/// Steps shown while the engine starts, each with the host agent log message that ends it.
/// The last one ends when Docker answers.
pub const START_STEPS: [(&str, &str); 3] = [
    ("Starting the virtual machine", "vm state change: running"),
    ("Booting Linux", "Guest agent is running"),
    ("Starting Docker", ""),
];

/// What the UI and the menu bar show about the engine.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EngineProgress {
    pub state: EngineState,
    /// While starting: index into `START_STEPS`, and its label.
    pub step: Option<usize>,
    pub step_label: Option<String>,
    /// Labels of all the start steps.
    pub steps: Vec<&'static str>,
    /// While starting: when the start began, in ms since the Unix epoch.
    pub started_at: Option<u64>,
    pub error: Option<String>,
}

pub struct Engine {
    home: PathBuf,
    child: Mutex<Option<Child>>,
    state: Mutex<EngineState>,
    last_error: Mutex<Option<String>>,
    /// While starting: (current step, start time in ms since the epoch).
    progress: Mutex<Option<(usize, u64)>>,
}

impl Engine {
    pub fn new() -> Self {
        let engine = Self {
            home: home(),
            child: Mutex::new(None),
            state: Mutex::new(EngineState::Stopped),
            last_error: Mutex::new(None),
            progress: Mutex::new(None),
        };
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

    /// The engine as `state` (which may be ahead of `self.state()` while a start is being set up).
    pub fn progress(&self, state: EngineState) -> EngineProgress {
        let p = if state == EngineState::Starting { *self.progress.lock().unwrap() } else { None };
        EngineProgress {
            state,
            step: p.map(|(s, _)| s),
            step_label: p.map(|(s, _)| START_STEPS[s].0.to_string()),
            steps: START_STEPS.iter().map(|(label, _)| *label).collect(),
            started_at: p.map(|(_, t)| t),
            error: if state == EngineState::Failed { self.last_error() } else { None },
        }
    }

    /// The start step reached, from the host agent log written since `offset`.
    fn step_from_log(&self, offset: u64) -> usize {
        use std::io::{Seek, SeekFrom};
        let mut text = String::new();
        if let Ok(mut f) = std::fs::File::open(self.ha_log()) {
            if f.seek(SeekFrom::Start(offset)).is_ok() {
                let _ = f.read_to_string(&mut text);
            }
        }
        START_STEPS.iter().take_while(|(_, done)| !done.is_empty() && text.contains(done)).count()
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
        // Only log lines written from now on count towards the start steps.
        let log_offset = std::fs::metadata(self.ha_log()).map(|m| m.len()).unwrap_or(0);
        let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        *self.progress.lock().unwrap() = Some((0, now_ms));
        self.set(EngineState::Starting);
        *self.last_error.lock().unwrap() = None;
        let result = self.boot(log_offset);
        *self.progress.lock().unwrap() = None;
        result
    }

    fn boot(&self, log_offset: u64) -> Result<(), String> {
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
            let lima_running = self.lima_status().as_deref() == Some("Running");
            if lima_running && self.docker_ready() {
                self.set(EngineState::Running);
                return Ok(());
            }
            // An adopted VM that is still booting is at least past its first step.
            let step = self.step_from_log(log_offset).max(lima_running as usize);
            if let Some(p) = self.progress.lock().unwrap().as_mut() {
                p.0 = step.min(START_STEPS.len() - 1);
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    /// Boots the real VM: `cargo test -- --ignored engine_reports_start_steps_in_order`.
    #[test]
    #[ignore]
    fn engine_reports_start_steps_in_order() {
        let engine = Arc::new(Engine::new());
        assert_eq!(engine.refresh(), EngineState::Stopped, "stop the VM before running this test");
        let e = engine.clone();
        let starter = std::thread::spawn(move || e.start());
        let mut seen: Vec<usize> = Vec::new();
        let t0 = Instant::now();
        while !starter.is_finished() {
            if let Some(step) = engine.progress(engine.state()).step {
                if seen.last() != Some(&step) {
                    eprintln!("{:>5} ms  step {step}: {}", t0.elapsed().as_millis(), START_STEPS[step].0);
                    seen.push(step);
                }
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        starter.join().unwrap().unwrap();
        eprintln!("{:>5} ms  running", t0.elapsed().as_millis());
        assert_eq!(engine.state(), EngineState::Running);
        // "Starting Docker" only shows when Docker lags behind the guest agent (e.g. the first boot installs it).
        assert!(seen.starts_with(&[0, 1]) && seen.windows(2).all(|w| w[0] < w[1]), "steps go forward in order: {seen:?}");
        assert!(engine.progress(engine.state()).step.is_none(), "no step once running");
        engine.stop().unwrap();
    }
}
