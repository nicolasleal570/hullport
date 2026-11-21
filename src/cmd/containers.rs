use crate::cmd::images::{normalize_ref, pull_quiet};
use crate::error::{other, AppError, AppResult};
use crate::state::AppState;
use bollard::models::{
    ContainerCreateBody, ContainerInspectResponse, ContainerSummary, EndpointSettings, HostConfig,
    NetworkingConfig, PortBinding, RestartPolicy, RestartPolicyNameEnum,
};
use bollard::query_parameters::{
    CreateContainerOptionsBuilder, ListContainersOptionsBuilder, LogsOptionsBuilder,
    RemoveContainerOptionsBuilder, StatsOptionsBuilder,
};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::ipc::Channel;
use tauri::State;

#[tauri::command]
pub async fn list_containers(state: State<'_, AppState>) -> AppResult<Vec<ContainerSummary>> {
    let d = state.docker.docker()?;
    Ok(d.list_containers(Some(ListContainersOptionsBuilder::default().all(true).build())).await?)
}

#[tauri::command]
pub async fn inspect_container(state: State<'_, AppState>, id: String) -> AppResult<ContainerInspectResponse> {
    let d = state.docker.docker()?;
    Ok(d.inspect_container(&id, None).await?)
}

#[tauri::command]
pub async fn container_action(state: State<'_, AppState>, id: String, action: String) -> AppResult<()> {
    let d = state.docker.docker()?;
    match action.as_str() {
        "start" => d.start_container(&id, None).await?,
        "stop" => d.stop_container(&id, None).await?,
        "restart" => d.restart_container(&id, None).await?,
        "kill" => d.kill_container(&id, None).await?,
        "pause" => d.pause_container(&id).await?,
        "unpause" => d.unpause_container(&id).await?,
        other_action => return Err(other(format!("Unknown action: {other_action}"))),
    }
    Ok(())
}

#[tauri::command]
pub async fn remove_container(
    state: State<'_, AppState>,
    id: String,
    force: bool,
    volumes: bool,
) -> AppResult<()> {
    let d = state.docker.docker()?;
    d.remove_container(&id, Some(RemoveContainerOptionsBuilder::default().force(force).v(volumes).build()))
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn rename_container(state: State<'_, AppState>, id: String, name: String) -> AppResult<()> {
    let d = state.docker.docker()?;
    d.rename_container(&id, bollard::query_parameters::RenameContainerOptionsBuilder::default().name(&name).build())
        .await?;
    Ok(())
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct KV {
    pub key: String,
    pub value: String,
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct PortSpec {
    pub host_ip: Option<String>,
    pub host_port: String,
    pub container_port: String,
    pub protocol: Option<String>,
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct MountSpec {
    /// Volume name or absolute host path.
    pub source: String,
    pub target: String,
    #[serde(default)]
    pub read_only: bool,
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct CreateContainerSpec {
    pub image: String,
    pub name: Option<String>,
    pub command: Option<String>,
    #[serde(default)]
    pub env: Vec<KV>,
    #[serde(default)]
    pub ports: Vec<PortSpec>,
    #[serde(default)]
    pub mounts: Vec<MountSpec>,
    #[serde(default)]
    pub labels: Vec<KV>,
    pub network: Option<String>,
    pub restart_policy: Option<String>,
    #[serde(default)]
    pub auto_remove: bool,
    #[serde(default)]
    pub start: bool,
    pub platform: Option<String>,
}

/// Split a command line into arguments, honouring single/double quotes and backslashes.
pub fn split_args(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_word = false;
    let mut quote: Option<char> = None;
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some('"'), '\\') => {
                if let Some(n) = chars.next() {
                    cur.push(n);
                }
            }
            (Some(_), c) => cur.push(c),
            (None, '\'') | (None, '"') => {
                quote = Some(c);
                in_word = true;
            }
            (None, '\\') => {
                if let Some(n) = chars.next() {
                    cur.push(n);
                    in_word = true;
                }
            }
            (None, c) if c.is_whitespace() => {
                if in_word {
                    out.push(std::mem::take(&mut cur));
                    in_word = false;
                }
            }
            (None, c) => {
                cur.push(c);
                in_word = true;
            }
        }
    }
    if in_word {
        out.push(cur);
    }
    out
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedContainer {
    pub id: String,
    pub warnings: Vec<String>,
    pub started: bool,
}

#[tauri::command]
pub async fn create_container(state: State<'_, AppState>, spec: CreateContainerSpec) -> AppResult<CreatedContainer> {
    let d = state.docker.docker()?;
    if spec.image.trim().is_empty() {
        return Err(other("An image is required"));
    }
    let image = normalize_ref(spec.image.trim());

    let mut exposed: Vec<String> = Vec::new();
    let mut bindings: HashMap<String, Option<Vec<PortBinding>>> = HashMap::new();
    for p in &spec.ports {
        if p.container_port.trim().is_empty() {
            continue;
        }
        let proto = p.protocol.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| "tcp".into());
        let key = format!("{}/{}", p.container_port.trim(), proto);
        if !exposed.contains(&key) {
            exposed.push(key.clone());
        }
        bindings.entry(key).or_insert_with(|| Some(vec![])).as_mut().unwrap().push(PortBinding {
            host_ip: p.host_ip.clone().filter(|s| !s.is_empty()),
            host_port: Some(p.host_port.trim().to_string()),
        });
    }
    let binds: Vec<String> = spec
        .mounts
        .iter()
        .filter(|m| !m.source.trim().is_empty() && !m.target.trim().is_empty())
        .map(|m| {
            format!("{}:{}{}", m.source.trim(), m.target.trim(), if m.read_only { ":ro" } else { "" })
        })
        .collect();
    let restart = match spec.restart_policy.as_deref().unwrap_or("no") {
        "always" => Some(RestartPolicyNameEnum::ALWAYS),
        "unless-stopped" => Some(RestartPolicyNameEnum::UNLESS_STOPPED),
        "on-failure" => Some(RestartPolicyNameEnum::ON_FAILURE),
        _ => Some(RestartPolicyNameEnum::NO),
    };
    let network = spec.network.clone().filter(|s| !s.is_empty());
    let networking_config = network.as_ref().filter(|n| !["bridge", "host", "none"].contains(&n.as_str())).map(|n| {
        let mut m = HashMap::new();
        m.insert(n.clone(), EndpointSettings::default());
        NetworkingConfig { endpoints_config: Some(m) }
    });
    let cmd = spec.command.as_deref().map(split_args).filter(|v| !v.is_empty());
    let labels: HashMap<String, String> = spec
        .labels
        .iter()
        .filter(|kv| !kv.key.trim().is_empty())
        .map(|kv| (kv.key.trim().to_string(), kv.value.clone()))
        .collect();

    let body = ContainerCreateBody {
        image: Some(image.clone()),
        cmd,
        env: Some(
            spec.env
                .iter()
                .filter(|kv| !kv.key.trim().is_empty())
                .map(|kv| format!("{}={}", kv.key.trim(), kv.value))
                .collect(),
        ),
        exposed_ports: if exposed.is_empty() { None } else { Some(exposed) },
        labels: if labels.is_empty() { None } else { Some(labels) },
        host_config: Some(HostConfig {
            port_bindings: if bindings.is_empty() { None } else { Some(bindings) },
            binds: if binds.is_empty() { None } else { Some(binds) },
            restart_policy: Some(RestartPolicy { name: restart, maximum_retry_count: None }),
            auto_remove: Some(spec.auto_remove),
            network_mode: network.clone(),
            ..Default::default()
        }),
        networking_config,
        ..Default::default()
    };

    let mut opts = CreateContainerOptionsBuilder::default();
    if let Some(n) = spec.name.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        opts = opts.name(n);
    }
    if let Some(p) = spec.platform.as_deref().filter(|s| !s.is_empty()) {
        opts = opts.platform(p);
    }
    let opts = opts.build();

    let created = match d.create_container(Some(opts.clone()), body.clone()).await {
        Ok(c) => c,
        Err(bollard::errors::Error::DockerResponseServerError { status_code: 404, message })
            if message.contains("No such image") =>
        {
            pull_quiet(&d, &image, spec.platform.as_deref()).await?;
            d.create_container(Some(opts), body).await?
        }
        Err(e) => return Err(e.into()),
    };
    let mut started = false;
    if spec.start {
        d.start_container(&created.id, None).await.map_err(|e| {
            AppError::Docker(format!("Container created ({}), but it failed to start: {}", &created.id[..12.min(created.id.len())], AppError::from(e)))
        })?;
        started = true;
    }
    Ok(CreatedContainer { id: created.id, warnings: created.warnings, started })
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    pub ts: String,
    pub stream: &'static str,
    pub text: String,
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum LogEvent {
    Lines { lines: Vec<LogLine> },
    End { error: Option<String> },
}

fn split_ts(line: &str) -> (String, String) {
    // Docker prefixes each line with an RFC3339Nano timestamp and a space.
    match line.split_once(' ') {
        Some((ts, rest)) if ts.len() >= 20 && ts.as_bytes()[4] == b'-' && ts.contains('T') => {
            (ts.to_string(), rest.to_string())
        }
        _ => (String::new(), line.to_string()),
    }
}

/// Follow a container's logs. Returns an op id for `cancel_op`.
#[tauri::command]
pub async fn stream_logs(
    state: State<'_, AppState>,
    id: String,
    tail: Option<u32>,
    since: Option<String>,
    channel: Channel<LogEvent>,
) -> AppResult<String> {
    let d = state.docker.docker()?;
    let (op, token) = state.register_op();
    let tail = tail.map(|t| t.to_string()).unwrap_or_else(|| "1000".into());
    let mut b = LogsOptionsBuilder::default().follow(true).stdout(true).stderr(true).timestamps(true);
    // Resume after a restart from the last timestamp seen (`--since=<ISO8601>`).
    // The Engine API takes whole seconds, so the UI drops lines at or before the exact timestamp.
    match since.as_deref().and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok()) {
        Some(t) => b = b.since(t.timestamp() as i32).tail("all"),
        None => b = b.tail(&tail),
    }
    let opts = b.build();
    tauri::async_runtime::spawn(async move {
        let stream = d.logs(&id, Some(opts)).ready_chunks(512);
        tokio::pin!(stream);
        let mut partial: HashMap<&'static str, String> = HashMap::new();
        let mut end_error = None;
        loop {
            tokio::select! {
                _ = token.cancelled() => break,
                batch = stream.next() => {
                    let Some(batch) = batch else { break };
                    let mut lines = Vec::new();
                    for item in batch {
                        match item {
                            Ok(out) => {
                                let kind: &'static str = match out {
                                    bollard::container::LogOutput::StdErr { .. } => "err",
                                    _ => "out",
                                };
                                let text = String::from_utf8_lossy(&out.into_bytes()).to_string();
                                let buf = partial.entry(kind).or_default();
                                buf.push_str(&text);
                                while let Some(pos) = buf.find('\n') {
                                    let line: String = buf.drain(..=pos).collect();
                                    let line = line.trim_end_matches(['\n', '\r']);
                                    let (ts, text) = split_ts(line);
                                    lines.push(LogLine { ts, stream: kind, text });
                                }
                            }
                            Err(e) => end_error = Some(AppError::from(e).to_string()),
                        }
                    }
                    if !lines.is_empty() && channel.send(LogEvent::Lines { lines }).is_err() {
                        break;
                    }
                    if end_error.is_some() { break; }
                }
            }
        }
        let rest: Vec<LogLine> = partial
            .into_iter()
            .filter(|(_, v)| !v.is_empty())
            .map(|(k, v)| {
                let (ts, text) = split_ts(&v);
                LogLine { ts, stream: k, text }
            })
            .collect();
        if !rest.is_empty() {
            let _ = channel.send(LogEvent::Lines { lines: rest });
        }
        let _ = channel.send(LogEvent::End { error: end_error });
    });
    Ok(op)
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct StatsSample {
    pub cpu_percent: f64,
    pub mem_used: u64,
    pub mem_limit: u64,
    pub net_rx: u64,
    pub net_tx: u64,
    pub blk_read: u64,
    pub blk_write: u64,
    pub pids: u64,
    pub online_cpus: u64,
}

fn u(v: &serde_json::Value, p: &str) -> u64 {
    v.pointer(p).and_then(|x| x.as_u64()).unwrap_or(0)
}

pub fn compute_stats(v: &serde_json::Value) -> StatsSample {
    let cpu_total = u(v, "/cpu_stats/cpu_usage/total_usage");
    let pre_total = u(v, "/precpu_stats/cpu_usage/total_usage");
    let sys = u(v, "/cpu_stats/system_cpu_usage");
    let pre_sys = u(v, "/precpu_stats/system_cpu_usage");
    let mut cpus = u(v, "/cpu_stats/online_cpus");
    if cpus == 0 {
        cpus = v
            .pointer("/cpu_stats/cpu_usage/percpu_usage")
            .and_then(|a| a.as_array())
            .map(|a| a.len() as u64)
            .unwrap_or(1);
    }
    let cpu_delta = cpu_total.saturating_sub(pre_total) as f64;
    let sys_delta = sys.saturating_sub(pre_sys) as f64;
    let cpu_percent = if sys_delta > 0.0 { cpu_delta / sys_delta * cpus as f64 * 100.0 } else { 0.0 };
    let usage = u(v, "/memory_stats/usage");
    let inactive = {
        let a = u(v, "/memory_stats/stats/inactive_file");
        if a > 0 { a } else { u(v, "/memory_stats/stats/total_inactive_file") }
    };
    let (mut rx, mut tx) = (0, 0);
    if let Some(nets) = v.get("networks").and_then(|n| n.as_object()) {
        for n in nets.values() {
            rx += n.get("rx_bytes").and_then(|x| x.as_u64()).unwrap_or(0);
            tx += n.get("tx_bytes").and_then(|x| x.as_u64()).unwrap_or(0);
        }
    }
    let (mut br, mut bw) = (0, 0);
    if let Some(arr) = v.pointer("/blkio_stats/io_service_bytes_recursive").and_then(|a| a.as_array()) {
        for e in arr {
            let val = e.get("value").and_then(|x| x.as_u64()).unwrap_or(0);
            match e.get("op").and_then(|x| x.as_str()).map(|s| s.to_ascii_lowercase()).as_deref() {
                Some("read") => br += val,
                Some("write") => bw += val,
                _ => {}
            }
        }
    }
    StatsSample {
        cpu_percent,
        mem_used: usage.saturating_sub(inactive),
        mem_limit: u(v, "/memory_stats/limit"),
        net_rx: rx,
        net_tx: tx,
        blk_read: br,
        blk_write: bw,
        pids: u(v, "/pids_stats/current"),
        online_cpus: cpus,
    }
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum StatsEvent {
    Sample { sample: StatsSample },
    End { error: Option<String> },
}

#[tauri::command]
pub async fn stream_stats(state: State<'_, AppState>, id: String, channel: Channel<StatsEvent>) -> AppResult<String> {
    let d = state.docker.docker()?;
    let (op, token) = state.register_op();
    tauri::async_runtime::spawn(async move {
        let stream = d.stats(&id, Some(StatsOptionsBuilder::default().stream(true).build()));
        tokio::pin!(stream);
        let mut err = None;
        loop {
            tokio::select! {
                _ = token.cancelled() => break,
                item = stream.next() => match item {
                    Some(Ok(s)) => {
                        let v = serde_json::to_value(&s).unwrap_or_default();
                        if channel.send(StatsEvent::Sample { sample: compute_stats(&v) }).is_err() { break; }
                    }
                    Some(Err(e)) => { err = Some(AppError::from(e).to_string()); break; }
                    None => break,
                }
            }
        }
        let _ = channel.send(StatsEvent::End { error: err });
    });
    Ok(op)
}

#[tauri::command]
pub async fn container_top(state: State<'_, AppState>, id: String) -> AppResult<serde_json::Value> {
    let d = state.docker.docker()?;
    let top = d.top_processes(&id, None::<bollard::query_parameters::TopOptions>).await?;
    Ok(serde_json::to_value(top)?)
}
