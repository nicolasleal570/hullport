//! Docker adapter: owns the engine connection, reconnects on failure and
//! forwards engine events to the UI so it can refresh without polling.

pub mod cli;
pub mod context;

use crate::error::{AppError, AppResult};
use bollard::query_parameters::EventsOptionsBuilder;
use bollard::{Docker, API_DEFAULT_VERSION};
use futures_util::StreamExt;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, OnceLock, RwLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConnStatus {
    /// "connecting" | "connected" | "disconnected"
    pub state: String,
    pub context: String,
    pub host: String,
    pub error: Option<String>,
    pub server_version: Option<String>,
    pub api_version: Option<String>,
    pub os: Option<String>,
    pub arch: Option<String>,
    pub engine_name: Option<String>,
    pub cpus: Option<i64>,
    pub mem_total: Option<i64>,
    pub containers_running: Option<i64>,
    /// The chosen context, when it didn't answer and another engine is used instead for now.
    pub fallback_from: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EngineEvent {
    pub kind: String,
    pub action: String,
    pub id: String,
    pub name: Option<String>,
    pub time: Option<i64>,
}

struct Inner {
    docker: Option<Docker>,
    status: ConnStatus,
}

pub struct DockerManager {
    inner: RwLock<Inner>,
    preferred: RwLock<Option<String>>,
    wake: Notify,
    app: OnceLock<AppHandle>,
}

impl DockerManager {
    pub fn new(preferred: Option<String>) -> Arc<Self> {
        Arc::new(Self {
            inner: RwLock::new(Inner {
                docker: None,
                status: ConnStatus { state: "connecting".into(), ..Default::default() },
            }),
            preferred: RwLock::new(context::normalize(preferred)),
            wake: Notify::new(),
            app: OnceLock::new(),
        })
    }

    pub fn docker(&self) -> AppResult<Docker> {
        let g = self.inner.read().unwrap();
        match &g.docker {
            Some(d) => Ok(d.clone()),
            None => Err(AppError::NotConnected(
                g.status.error.clone().unwrap_or_else(|| "engine unavailable".into()),
            )),
        }
    }

    pub fn status(&self) -> ConnStatus {
        self.inner.read().unwrap().status.clone()
    }

    pub fn preferred(&self) -> Option<String> {
        self.preferred.read().unwrap().clone()
    }

    /// Context name and host currently in use (or about to be).
    pub fn endpoint(&self) -> (String, String) {
        let st = self.status();
        if !st.host.is_empty() {
            return (st.context, st.host);
        }
        context::resolve(self.preferred().as_deref())
    }

    pub fn set_context(&self, name: Option<String>) {
        *self.preferred.write().unwrap() = context::normalize(name);
        self.wake.notify_one();
    }

    pub fn reconnect(&self) {
        self.wake.notify_one();
    }

    fn set_status(&self, docker: Option<Docker>, status: ConnStatus) {
        {
            let mut g = self.inner.write().unwrap();
            g.docker = docker;
            g.status = status.clone();
        }
        if let Some(app) = self.app.get() {
            let _ = app.emit("docker://status", status);
        }
    }

    /// Connect to the first engine that answers (see `context::candidates`). On failure, report
    /// the first candidate's error: that's the engine the user expects.
    async fn connect_once(&self) -> Result<(Docker, ConnStatus), (String, String, String)> {
        let preferred = self.preferred();
        let mut first_err = None;
        for (ctx, host) in context::candidates(preferred.as_deref()) {
            match Self::connect_to(&ctx, &host).await {
                Ok((docker, mut status)) => {
                    status.fallback_from = preferred.filter(|p| *p != ctx);
                    return Ok((docker, status));
                }
                Err(e) => {
                    first_err.get_or_insert(e);
                }
            }
        }
        Err(first_err.unwrap_or_else(|| ("default".into(), String::new(), "No Docker engine found".into())))
    }

    /// Whether this connection is a stand-in for the chosen context, or "Automatic" isn't on
    /// Hullport's own engine: then a better engine is worth switching to when it comes up.
    pub fn could_do_better(&self) -> bool {
        let st = self.status();
        st.state != "connected" || st.fallback_from.is_some() || (self.preferred().is_none() && st.context != context::HULLPORT)
    }

    async fn connect_to(ctx: &str, host: &str) -> Result<(Docker, ConnStatus), (String, String, String)> {
        let (ctx, host) = (ctx.to_string(), host.to_string());
        let fail = |msg: String| (ctx.clone(), host.clone(), msg);
        let docker = if host.starts_with("unix://") {
            Docker::connect_with_unix(&host, 120, API_DEFAULT_VERSION)
        } else if host.starts_with("tcp://") || host.starts_with("http://") {
            Docker::connect_with_http(&host, 120, API_DEFAULT_VERSION)
        } else {
            return Err(fail(format!(
                "Endpoint type not supported yet: {host}. Use a unix socket or tcp context."
            )));
        }
        .map_err(|e| fail(e.to_string()))?;

        let docker = tokio::time::timeout(Duration::from_secs(5), docker.negotiate_version())
            .await
            .map_err(|_| fail("Timed out talking to the Docker engine".into()))?
            .map_err(|e| fail(friendly(&e.to_string(), &host)))?;

        let version = docker.version().await.map_err(|e| fail(e.to_string()))?;
        let info = docker.info().await.ok();
        let status = ConnStatus {
            state: "connected".into(),
            context: ctx.clone(),
            host: host.clone(),
            error: None,
            server_version: version.version.clone(),
            api_version: version.api_version.clone(),
            os: info.as_ref().and_then(|i| i.operating_system.clone()),
            arch: version.arch.clone(),
            engine_name: info.as_ref().and_then(|i| i.name.clone()),
            cpus: info.as_ref().and_then(|i| i.ncpu),
            mem_total: info.as_ref().and_then(|i| i.mem_total),
            containers_running: info.as_ref().and_then(|i| i.containers_running),
            fallback_from: None,
        };
        Ok((docker, status))
    }

    /// Long-running supervisor: connect, stream events, reconnect with backoff.
    pub fn spawn_supervisor(self: &Arc<Self>, app: AppHandle) {
        let _ = self.app.set(app.clone());
        let me = self.clone();
        tauri::async_runtime::spawn(async move {
            let mut backoff = Duration::from_millis(1500);
            loop {
                match me.connect_once().await {
                    Ok((docker, status)) => {
                        backoff = Duration::from_millis(1500);
                        me.set_status(Some(docker.clone()), status.clone());
                        let reason = me.watch_events(&app, docker).await;
                        let switched = reason.is_none();
                        let (ctx, host) = context::resolve(me.preferred().as_deref());
                        me.set_status(
                            None,
                            ConnStatus {
                                state: if switched { "connecting".into() } else { "disconnected".into() },
                                context: ctx,
                                host,
                                error: reason,
                                ..Default::default()
                            },
                        );
                        if switched {
                            continue;
                        }
                    }
                    Err((ctx, host, msg)) => {
                        me.set_status(
                            None,
                            ConnStatus {
                                state: "disconnected".into(),
                                context: ctx,
                                host,
                                error: Some(msg),
                                ..Default::default()
                            },
                        );
                    }
                }
                tokio::select! {
                    _ = tokio::time::sleep(backoff) => {}
                    _ = me.wake.notified() => {}
                }
                backoff = (backoff * 2).min(Duration::from_secs(8));
            }
        });
    }

    /// Returns `None` when interrupted by a context switch, `Some(reason)` when the engine went away.
    async fn watch_events(&self, app: &AppHandle, docker: Docker) -> Option<String> {
        let mut filters: HashMap<String, Vec<String>> = HashMap::new();
        filters.insert(
            "type".into(),
            vec!["container".into(), "image".into(), "volume".into(), "network".into()],
        );
        let mut events = docker.events(Some(EventsOptionsBuilder::default().filters(&filters).build()));
        let mut ping = tokio::time::interval(Duration::from_secs(15));
        ping.tick().await;
        loop {
            tokio::select! {
                msg = events.next() => match msg {
                    Some(Ok(m)) => {
                        let attrs = m.actor.as_ref().and_then(|a| a.attributes.clone()).unwrap_or_default();
                        let ev = EngineEvent {
                            kind: m.typ.map(|t| t.to_string()).unwrap_or_default(),
                            action: m.action.clone().unwrap_or_default(),
                            id: m.actor.as_ref().and_then(|a| a.id.clone()).unwrap_or_default(),
                            name: attrs.get("name").cloned(),
                            time: m.time,
                        };
                        let _ = app.emit("docker://event", ev);
                    }
                    Some(Err(e)) => return Some(format!("Lost connection to the engine: {e}")),
                    None => return Some("The engine closed the connection".into()),
                },
                _ = ping.tick() => {
                    if tokio::time::timeout(Duration::from_secs(5), docker.ping()).await.map(|r| r.is_err()).unwrap_or(true) {
                        return Some("The engine stopped responding".into());
                    }
                }
                _ = self.wake.notified() => return None,
            }
        }
    }
}

fn friendly(err: &str, host: &str) -> String {
    if err.contains("No such file") || err.contains("os error 2") {
        format!("No Docker engine socket at {host}. Is the engine running?")
    } else if err.contains("Connection refused") || err.contains("os error 61") {
        format!("The engine at {host} refused the connection. Is it running?")
    } else {
        err.to_string()
    }
}
