use serde::{Serialize, Serializer};

/// Errors returned to the frontend. Serialized as a plain message string.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("Docker is not connected: {0}")]
    NotConnected(String),
    #[error("{0}")]
    Docker(String),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Other(String),
}

impl From<bollard::errors::Error> for AppError {
    fn from(e: bollard::errors::Error) -> Self {
        use bollard::errors::Error as E;
        match e {
            E::DockerResponseServerError { status_code, message } => {
                AppError::Docker(format!("{} (HTTP {status_code})", message.trim()))
            }
            other => AppError::Docker(other.to_string()),
        }
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::Other(e.to_string())
    }
}

impl From<tauri::Error> for AppError {
    fn from(e: tauri::Error) -> Self {
        AppError::Other(e.to_string())
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;

pub fn other(msg: impl Into<String>) -> AppError {
    AppError::Other(msg.into())
}
