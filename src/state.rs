use crate::docker::DockerManager;
use crate::store::Store;
use std::collections::HashMap;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use tokio::io::AsyncWrite;
use tokio_util::sync::CancellationToken;

pub type ExecInput = Arc<tokio::sync::Mutex<Pin<Box<dyn AsyncWrite + Send>>>>;

pub struct ExecSession {
    pub exec_id: String,
    pub input: ExecInput,
    pub cancel: CancellationToken,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchMode {
    /// "normal" | "screenshot" | "selftest" | "verify"
    pub mode: String,
    pub path: Option<String>,
    /// `--verify` only: folder with test Dockerfiles, and a volume name the CLI will create externally.
    pub fixtures: Option<String>,
    pub external: Option<String>,
    /// `--screenshot` only: which section to show (containers by default).
    pub section: Option<String>,
    /// `--context NAME`: Docker context for this run only, instead of the saved preference.
    pub context: Option<String>,
    /// `--background`: start in the menu bar without opening the window (used at login).
    pub background: bool,
}

pub struct AppState {
    pub docker: Arc<DockerManager>,
    pub store: Store,
    pub launch: LaunchMode,
    /// Cancellable background operations (log/stat streams, pulls).
    pub ops: Mutex<HashMap<String, CancellationToken>>,
    pub execs: Mutex<HashMap<String, ExecSession>>,
    /// Running builds: build id -> (child pid, cancel token).
    pub builds: Mutex<HashMap<String, (Option<u32>, CancellationToken)>>,
    /// Volume name -> helper container id used by the file browser.
    pub volume_helpers: tokio::sync::Mutex<HashMap<String, String>>,
}

impl AppState {
    pub fn register_op(&self) -> (String, CancellationToken) {
        let id = uuid::Uuid::new_v4().to_string();
        let token = CancellationToken::new();
        self.ops.lock().unwrap().insert(id.clone(), token.clone());
        (id, token)
    }

    pub fn cancel_op(&self, id: &str) -> bool {
        match self.ops.lock().unwrap().remove(id) {
            Some(t) => {
                t.cancel();
                true
            }
            None => false,
        }
    }
}
