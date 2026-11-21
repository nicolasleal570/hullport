//! Migration from OrbStack into Hullport's own engine, read-only on OrbStack's side.
//!
//! - Images stream from OrbStack's `docker save` straight into Hullport's `docker load`.
//! - Volumes stream as a tar through two never-started helper containers named
//!   `hullport-migrate-*`: OrbStack's mounts the volume read-only. Docker reads and writes
//!   files of created containers without running them, so nothing runs in OrbStack.
//! - Compose containers are not recreated (`docker compose up` does that); loose ones are
//!   recreated stopped from their `inspect`.
//! Nothing that exists in Hullport is overwritten unless the user asks for that volume.

use crate::cmd::images::pull_quiet;
use crate::docker::context;
use crate::error::{other, AppResult};
use crate::state::AppState;
use bollard::models::{ContainerCreateBody, EndpointSettings, HostConfig, NetworkCreateRequest, NetworkingConfig, VolumeCreateRequest};
use bollard::query_parameters::{
    CreateContainerOptionsBuilder, DataUsageOptions, DownloadFromContainerOptionsBuilder, ImportImageOptionsBuilder,
    ListContainersOptionsBuilder, ListImagesOptionsBuilder, RemoveContainerOptionsBuilder, RemoveVolumeOptionsBuilder,
    UploadToContainerOptionsBuilder,
};
use bollard::{Docker, API_DEFAULT_VERSION};
use futures_util::{StreamExt, TryStreamExt};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::State;
use tokio_util::sync::CancellationToken;

const HELPER_LABEL: &str = "dev.hullport.migrate";
const COMPOSE_PROJECT: &str = "com.docker.compose.project";
const COMPOSE_DIR: &str = "com.docker.compose.project.working_dir";

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Side {
    pub available: bool,
    pub host: String,
    pub version: Option<String>,
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageItem {
    pub id: String,
    pub tags: Vec<String>,
    pub size: i64,
    pub platform: String,
    /// Why it won't be copied, if it won't.
    pub skip: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeItem {
    pub name: String,
    pub size: Option<i64>,
    /// Running OrbStack containers using it: they must be stopped first.
    pub in_use_by: Vec<String>,
    /// Size of the volume with the same name already in Hullport, if there is one.
    pub target_size: Option<i64>,
    pub skip: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerItem {
    pub name: String,
    pub image: String,
    pub state: String,
    pub compose_project: Option<String>,
    pub compose_dir: Option<String>,
    /// Loose containers only: files changed in its writable layer (`docker diff`), which aren't copied.
    pub changes: Option<usize>,
    pub in_target: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationPlan {
    pub source: Side,
    pub target: Side,
    pub images: Vec<ImageItem>,
    pub volumes: Vec<VolumeItem>,
    pub containers: Vec<ContainerItem>,
    /// Bytes the selected-by-default items need in Hullport.
    pub needed_bytes: i64,
    pub mac_free_bytes: Option<u64>,
}

async fn connect(host: &str) -> Result<(Docker, Option<String>), String> {
    let d = Docker::connect_with_unix(host, 600, API_DEFAULT_VERSION).map_err(|e| e.to_string())?;
    let d = tokio::time::timeout(Duration::from_secs(5), d.negotiate_version())
        .await
        .map_err(|_| "timed out".to_string())?
        .map_err(|e| e.to_string())?;
    let version = d.version().await.ok().and_then(|v| v.version);
    Ok((d, version))
}

/// OrbStack's engine: its context if there is one, else its well-known socket.
fn source_host() -> String {
    context::list_contexts()
        .into_iter()
        .find(|c| c.name == "orbstack")
        .map(|c| c.host)
        .unwrap_or_else(|| format!("unix://{}/.orbstack/run/docker.sock", dirs::home_dir().unwrap_or_default().display()))
}

fn target_host() -> String {
    format!("unix://{}", crate::engine::home().join("run/docker.sock").display())
}

async fn side(host: String) -> (Side, Option<Docker>) {
    match connect(&host).await {
        Ok((d, version)) => (Side { available: true, host, version, error: None }, Some(d)),
        Err(e) => (Side { available: false, host, version: None, error: Some(e) }, None),
    }
}

async fn volume_sizes(d: &Docker) -> HashMap<String, i64> {
    let opts = DataUsageOptions { _type: Some(vec!["volume".into()]), verbose: true };
    let Ok(df) = d.df(Some(opts)).await else { return HashMap::new() };
    df.volume_usage
        .and_then(|v| v.items)
        .unwrap_or_default()
        .iter()
        .filter_map(|v| Some((v.get("Name")?.as_str()?.to_string(), v.pointer("/UsageData/Size")?.as_i64()?)))
        .collect()
}

fn mac_free_bytes() -> Option<u64> {
    let home = std::ffi::CString::new(dirs::home_dir()?.to_string_lossy().as_bytes()).ok()?;
    let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
    (unsafe { libc::statvfs(home.as_ptr(), &mut s) } == 0).then(|| s.f_bavail as u64 * s.f_frsize as u64)
}

/// Running containers that mount each volume, by volume name.
async fn volume_users(d: &Docker, running_only: bool) -> HashMap<String, Vec<String>> {
    let mut out: HashMap<String, Vec<String>> = HashMap::new();
    let list = d.list_containers(Some(ListContainersOptionsBuilder::default().all(!running_only).build())).await.unwrap_or_default();
    for c in list {
        let name = c.names.unwrap_or_default().first().map(|n| n.trim_start_matches('/').to_string()).unwrap_or_default();
        for m in c.mounts.unwrap_or_default() {
            if let Some(v) = m.name {
                out.entry(v).or_default().push(name.clone());
            }
        }
    }
    out
}

/// What would be migrated. Read-only on both engines.
#[tauri::command]
pub async fn migration_plan() -> AppResult<MigrationPlan> {
    let (source, src) = side(source_host()).await;
    let (target, dst) = side(target_host()).await;
    let mut plan = MigrationPlan { source, target, images: vec![], volumes: vec![], containers: vec![], needed_bytes: 0, mac_free_bytes: mac_free_bytes() };
    let (Some(src), Some(dst)) = (src, dst) else { return Ok(plan) };
    let host_arch = if cfg!(target_arch = "aarch64") { "arm64" } else { "amd64" };

    for img in src.list_images(Some(ListImagesOptionsBuilder::default().build())).await? {
        let tags: Vec<String> = img.repo_tags.into_iter().filter(|t| t != "<none>:<none>").collect();
        let info = src.inspect_image(&img.id).await.ok();
        let arch = info.as_ref().and_then(|i| i.architecture.clone()).unwrap_or_default();
        let os = info.as_ref().and_then(|i| i.os.clone()).unwrap_or_else(|| "linux".into());
        let skip = if tags.is_empty() {
            Some("untagged".into())
        } else if !arch.is_empty() && arch != host_arch {
            Some(format!("{arch} image: needs Rosetta, which is out of scope"))
        } else if dst.inspect_image(&img.id).await.is_ok() {
            Some("already in Hullport".into())
        } else {
            None
        };
        if skip.is_none() {
            plan.needed_bytes += img.size;
        }
        plan.images.push(ImageItem { id: img.id, tags, size: img.size, platform: format!("{os}/{arch}"), skip });
    }

    let src_sizes = volume_sizes(&src).await;
    let dst_sizes = volume_sizes(&dst).await;
    let running = volume_users(&src, true).await;
    let dst_names: HashSet<String> = dst.list_volumes(None::<bollard::query_parameters::ListVolumesOptions>).await?.volumes.unwrap_or_default().into_iter().map(|v| v.name).collect();
    for v in src.list_volumes(None::<bollard::query_parameters::ListVolumesOptions>).await?.volumes.unwrap_or_default() {
        let size = src_sizes.get(&v.name).copied();
        let in_target = dst_names.contains(&v.name);
        let skip = if v.driver != "local" {
            Some(format!("{} driver: only local volumes are copied", v.driver))
        } else if v.options.contains_key("device") {
            Some("backed by a folder or device on the host, not by data in the engine".into())
        } else if in_target {
            Some("a volume with this name is already in Hullport".into())
        } else {
            None
        };
        if skip.is_none() {
            plan.needed_bytes += size.unwrap_or(0);
        }
        plan.volumes.push(VolumeItem {
            in_use_by: running.get(&v.name).cloned().unwrap_or_default(),
            target_size: in_target.then(|| dst_sizes.get(&v.name).copied().unwrap_or(0)),
            name: v.name,
            size,
            skip,
        });
    }

    for c in src.list_containers(Some(ListContainersOptionsBuilder::default().all(true).build())).await? {
        let id = c.id.clone().unwrap_or_default();
        let name = c.names.clone().unwrap_or_default().first().map(|n| n.trim_start_matches('/').to_string()).unwrap_or_default();
        if name.starts_with("hullport-") {
            continue;
        }
        let labels = c.labels.clone().unwrap_or_default();
        let compose_project = labels.get(COMPOSE_PROJECT).cloned();
        let changes = if compose_project.is_none() {
            src.container_changes(&id).await.ok().flatten().map(|v| v.len()).or(Some(0))
        } else {
            None
        };
        plan.containers.push(ContainerItem {
            in_target: dst.inspect_container(&name, None).await.is_ok(),
            image: c.image.unwrap_or_default(),
            state: c.state.map(|s| s.to_string()).unwrap_or_default(),
            compose_dir: labels.get(COMPOSE_DIR).cloned(),
            compose_project,
            changes,
            name,
        });
    }
    Ok(plan)
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MigrationSelection {
    /// Image IDs.
    pub images: Vec<String>,
    pub volumes: Vec<String>,
    /// Volumes whose copy in Hullport may be replaced with OrbStack's.
    #[serde(default)]
    pub replace_volumes: Vec<String>,
    /// Loose containers to recreate (stopped).
    pub containers: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ItemResult {
    pub kind: String,
    pub name: String,
    /// "copying" | "done" | "skipped" | "failed"
    pub status: String,
    pub detail: Option<String>,
    pub bytes: Option<u64>,
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum MigrationEvent {
    Item(ItemResult),
    Done { results: Vec<ItemResult>, canceled: bool },
}

/// Copy the selection from OrbStack into Hullport. Returns an op id for `cancel_op`.
#[tauri::command]
pub async fn migration_run(state: State<'_, AppState>, selection: MigrationSelection, channel: Channel<MigrationEvent>) -> AppResult<String> {
    let (src, _) = connect(&source_host()).await.map_err(|e| other(format!("OrbStack isn't answering: {e}. Start OrbStack and try again.")))?;
    let (dst, _) = connect(&target_host()).await.map_err(|e| other(format!("Hullport's engine isn't answering: {e}")))?;
    let (op, token) = state.register_op();
    tauri::async_runtime::spawn(async move {
        let mut results = vec![];
        let mut report = |r: ItemResult, channel: &Channel<MigrationEvent>| {
            let _ = channel.send(MigrationEvent::Item(r.clone()));
            if r.status != "copying" {
                results.push(r);
            }
        };
        let images = src.list_images(Some(ListImagesOptionsBuilder::default().build())).await.unwrap_or_default();
        for id in &selection.images {
            if token.is_cancelled() {
                break;
            }
            let tags: Vec<String> = images.iter().find(|i| &i.id == id).map(|i| i.repo_tags.iter().filter(|t| *t != "<none>:<none>").cloned().collect()).unwrap_or_default();
            let name = tags.first().cloned().unwrap_or_else(|| id.clone());
            let r = copy_image(&src, &dst, &tags, &name, &token, &channel).await;
            report(r, &channel);
        }
        for name in &selection.volumes {
            if token.is_cancelled() {
                break;
            }
            let replace = selection.replace_volumes.contains(name);
            let r = copy_volume(&src, &dst, name, replace, &token, &channel).await;
            report(r, &channel);
        }
        for name in &selection.containers {
            if token.is_cancelled() {
                break;
            }
            let r = recreate_container(&src, &dst, name).await;
            report(r, &channel);
        }
        let _ = channel.send(MigrationEvent::Done { results, canceled: token.is_cancelled() });
    });
    Ok(op)
}

fn result(kind: &str, name: &str, status: &str, detail: Option<String>, bytes: Option<u64>) -> ItemResult {
    ItemResult { kind: kind.into(), name: name.into(), status: status.into(), detail, bytes }
}

/// Report how many bytes went through, every half second, until `done`.
fn progress_ticker(kind: &'static str, name: String, bytes: Arc<AtomicU64>, channel: Channel<MigrationEvent>) -> CancellationToken {
    let done = CancellationToken::new();
    let stop = done.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                _ = stop.cancelled() => break,
                _ = tokio::time::sleep(Duration::from_millis(500)) => {
                    let _ = channel.send(MigrationEvent::Item(result(kind, &name, "copying", None, Some(bytes.load(Ordering::Relaxed)))));
                }
            }
        }
    });
    done
}

async fn copy_image(src: &Docker, dst: &Docker, tags: &[String], name: &str, token: &CancellationToken, channel: &Channel<MigrationEvent>) -> ItemResult {
    if tags.is_empty() {
        return result("image", name, "skipped", Some("untagged".into()), None);
    }
    let bytes = Arc::new(AtomicU64::new(0));
    let ticker = progress_ticker("image", name.to_string(), bytes.clone(), channel.clone());
    let refs: Vec<&str> = tags.iter().map(String::as_str).collect();
    let counter = bytes.clone();
    let cancel = token.clone();
    // `docker save` of every tag, so they all come across.
    let tar = src
        .export_images(&refs)
        .inspect_ok(move |b| {
            counter.fetch_add(b.len() as u64, Ordering::Relaxed);
        })
        .take_until(async move { cancel.cancelled().await });
    let mut load = dst.import_image_stream(ImportImageOptionsBuilder::default().quiet(true).build(), tar, None);
    let mut error = None;
    while let Some(item) = load.next().await {
        if let Err(e) = item {
            error = Some(e.to_string());
            break;
        }
    }
    ticker.cancel();
    let copied = Some(bytes.load(Ordering::Relaxed));
    match (error, token.is_cancelled()) {
        (_, true) => result("image", name, "failed", Some("canceled".into()), copied),
        (Some(e), _) => result("image", name, "failed", Some(e), copied),
        (None, _) => result("image", name, "done", Some(format!("{} tag(s)", tags.len())), copied),
    }
}

/// A container that is created and never started, with `volume` mounted at /v.
async fn helper(d: &Docker, image: &str, volume: &str, read_only: bool) -> Result<String, String> {
    let name = format!("hullport-migrate-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
    let body = ContainerCreateBody {
        image: Some(image.to_string()),
        cmd: Some(vec!["true".into()]),
        labels: Some(HashMap::from([(HELPER_LABEL.to_string(), volume.to_string())])),
        host_config: Some(HostConfig {
            binds: Some(vec![format!("{volume}:/v{}", if read_only { ":ro" } else { "" })]),
            network_mode: Some("none".into()),
            ..Default::default()
        }),
        ..Default::default()
    };
    d.create_container(Some(CreateContainerOptionsBuilder::default().name(&name).build()), body)
        .await
        .map(|c| c.id)
        .map_err(|e| e.to_string())
}

async fn remove_helper(d: &Docker, id: &str) {
    let _ = d.remove_container(id, Some(RemoveContainerOptionsBuilder::default().force(true).build())).await;
}

/// Any image OrbStack already has: the helper never runs, so which one doesn't matter, and
/// pulling one into OrbStack would change it.
async fn any_source_image(src: &Docker) -> Option<String> {
    let images = src.list_images(Some(ListImagesOptionsBuilder::default().build())).await.ok()?;
    images
        .iter()
        .find(|i| i.repo_tags.iter().any(|t| t == "alpine:latest"))
        .or_else(|| images.first())
        .map(|i| i.id.clone())
}

async fn copy_volume(src: &Docker, dst: &Docker, name: &str, replace: bool, token: &CancellationToken, channel: &Channel<MigrationEvent>) -> ItemResult {
    let fail = |e: String| result("volume", name, "failed", Some(e), None);
    let Ok(vol) = src.inspect_volume(name).await else { return fail("not found in OrbStack".into()) };
    if vol.driver != "local" || vol.options.contains_key("device") {
        return result("volume", name, "skipped", Some("not a plain local volume".into()), None);
    }
    // Copying a volume a running container writes to would give a torn copy (e.g. a database).
    if let Some(users) = volume_users(src, true).await.get(name) {
        return result("volume", name, "skipped", Some(format!("in use by {}: stop it in OrbStack first", users.join(", "))), None);
    }
    if dst.inspect_volume(name).await.is_ok() {
        if !replace {
            return result("volume", name, "skipped", Some("already in Hullport".into()), None);
        }
        if let Some(users) = volume_users(dst, false).await.get(name) {
            return fail(format!("Hullport's copy is used by {}: remove those containers first", users.join(", ")));
        }
        if let Err(e) = dst.remove_volume(name, Some(RemoveVolumeOptionsBuilder::default().build())).await {
            return fail(format!("could not remove Hullport's copy: {e}"));
        }
    }
    let req = VolumeCreateRequest { name: Some(name.to_string()), driver: Some("local".into()), labels: vol.labels.clone().into(), ..Default::default() };
    if let Err(e) = dst.create_volume(req).await {
        return fail(format!("could not create it in Hullport: {e}"));
    }
    let Some(src_image) = any_source_image(src).await else { return fail("OrbStack has no image to base the helper on".into()) };
    if dst.inspect_image("alpine:latest").await.is_err() {
        if let Err(e) = pull_quiet(dst, "alpine:latest", None).await {
            return fail(format!("could not get alpine for the helper in Hullport: {e}"));
        }
    }
    let src_helper = match helper(src, &src_image, name, true).await {
        Ok(id) => id,
        Err(e) => return fail(format!("could not create the read-only helper in OrbStack: {e}")),
    };
    let dst_helper = match helper(dst, "alpine:latest", name, false).await {
        Ok(id) => id,
        Err(e) => {
            remove_helper(src, &src_helper).await;
            return fail(format!("could not create the helper in Hullport: {e}"));
        }
    };
    let bytes = Arc::new(AtomicU64::new(0));
    let ticker = progress_ticker("volume", name.to_string(), bytes.clone(), channel.clone());
    let counter = bytes.clone();
    let cancel = token.clone();
    // The archive of /v holds "v/...": unpacking it at / fills the new volume, keeping owners and modes.
    let tar = src
        .download_from_container(&src_helper, Some(DownloadFromContainerOptionsBuilder::default().path("/v").build()))
        .inspect_ok(move |b| {
            counter.fetch_add(b.len() as u64, Ordering::Relaxed);
        })
        .map_err(std::io::Error::other)
        .take_until(async move { cancel.cancelled().await });
    let upload = dst
        .upload_to_container(&dst_helper, Some(UploadToContainerOptionsBuilder::default().path("/").build()), bollard::body_try_stream(tar))
        .await;
    ticker.cancel();
    remove_helper(src, &src_helper).await;
    remove_helper(dst, &dst_helper).await;
    let copied = Some(bytes.load(Ordering::Relaxed));
    match (upload, token.is_cancelled()) {
        (_, true) => result("volume", name, "failed", Some("canceled; the partial copy stays in Hullport".into()), copied),
        (Err(e), _) => result("volume", name, "failed", Some(e.to_string()), copied),
        (Ok(()), _) => result("volume", name, "done", None, copied),
    }
}

/// Recreate a loose container in Hullport, stopped, from its `inspect` in OrbStack.
async fn recreate_container(src: &Docker, dst: &Docker, name: &str) -> ItemResult {
    let fail = |e: String| result("container", name, "failed", Some(e), None);
    let Ok(info) = src.inspect_container(name, None).await else { return fail("not found in OrbStack".into()) };
    if dst.inspect_container(name, None).await.is_ok() {
        return result("container", name, "skipped", Some("already in Hullport".into()), None);
    }
    let Some(cfg) = info.config else { return fail("OrbStack returned no config".into()) };
    let image = cfg.image.clone().unwrap_or_default();
    if dst.inspect_image(&image).await.is_err() {
        return fail(format!("its image {image} isn't in Hullport: migrate the image first"));
    }
    // User-defined networks must exist before the container can join them.
    let networks = info.network_settings.and_then(|n| n.networks).unwrap_or_default();
    let mut endpoints: HashMap<String, EndpointSettings> = HashMap::new();
    for (net, ep) in networks {
        if !["bridge", "host", "none"].contains(&net.as_str()) && dst.inspect_network(&net, None).await.is_err() {
            let driver = src.inspect_network(&net, None).await.ok().and_then(|n| n.driver);
            let req = NetworkCreateRequest { name: net.clone(), driver, ..Default::default() };
            if let Err(e) = dst.create_network(req).await {
                return fail(format!("could not create network {net}: {e}"));
            }
        }
        endpoints.insert(net, EndpointSettings { aliases: ep.aliases, ..Default::default() });
    }
    let body = ContainerCreateBody {
        image: Some(image),
        cmd: cfg.cmd,
        entrypoint: cfg.entrypoint,
        env: cfg.env,
        labels: cfg.labels,
        exposed_ports: cfg.exposed_ports,
        working_dir: cfg.working_dir,
        user: cfg.user,
        tty: cfg.tty,
        open_stdin: cfg.open_stdin,
        stdin_once: cfg.stdin_once,
        volumes: cfg.volumes,
        stop_signal: cfg.stop_signal,
        healthcheck: cfg.healthcheck,
        host_config: info.host_config,
        networking_config: Some(NetworkingConfig { endpoints_config: Some(endpoints) }),
        ..Default::default()
    };
    match dst.create_container(Some(CreateContainerOptionsBuilder::default().name(name).build()), body).await {
        Ok(_) => result("container", name, "done", Some("created stopped; its writable layer wasn't copied".into()), None),
        Err(e) => fail(e.to_string()),
    }
}

/// Run against the real engines, with OrbStack and Hullport's engine both up:
/// `cargo test migration -- --ignored --test-threads=1`. They only create and remove
/// `hullport-verify-*` resources, in both engines.
#[cfg(test)]
mod tests {
    use super::*;
    use bollard::models::PortBinding;
    use bollard::query_parameters::{RemoveImageOptionsBuilder, TagImageOptionsBuilder};

    async fn engines() -> (Docker, Docker) {
        let (src, _) = connect(&source_host()).await.expect("OrbStack must be running");
        let (dst, _) = connect(&target_host()).await.expect("Hullport's engine must be running");
        (src, dst)
    }

    fn channel() -> Channel<MigrationEvent> {
        Channel::new(|_| Ok(()))
    }

    fn tag() -> String {
        uuid::Uuid::new_v4().simple().to_string()[..6].to_string()
    }

    /// Run a throwaway command in a container (used to fill and read test volumes).
    async fn run(d: &Docker, name: &str, binds: Vec<String>, cmd: &str) -> String {
        let body = ContainerCreateBody {
            image: Some("alpine:latest".into()),
            cmd: Some(vec!["sh".into(), "-c".into(), cmd.into()]),
            host_config: Some(HostConfig { binds: Some(binds), network_mode: Some("none".into()), ..Default::default() }),
            ..Default::default()
        };
        let id = d.create_container(Some(CreateContainerOptionsBuilder::default().name(name).build()), body).await.unwrap().id;
        d.start_container(&id, None).await.unwrap();
        let mut wait = d.wait_container(&id, None);
        while wait.next().await.is_some() {}
        let logs: Vec<_> = d
            .logs(&id, Some(bollard::query_parameters::LogsOptionsBuilder::default().stdout(true).stderr(true).build()))
            .filter_map(|l| async { l.ok().map(|l| l.to_string()) })
            .collect()
            .await;
        remove_helper(d, &id).await;
        logs.concat()
    }

    async fn snapshot(d: &Docker) -> (Vec<String>, Vec<String>, Vec<String>) {
        let mut images: Vec<String> = d.list_images(Some(ListImagesOptionsBuilder::default().build())).await.unwrap().into_iter().map(|i| i.id).collect();
        let mut volumes: Vec<String> = d.list_volumes(None::<bollard::query_parameters::ListVolumesOptions>).await.unwrap().volumes.unwrap_or_default().into_iter().map(|v| v.name).collect();
        let mut containers: Vec<String> = d
            .list_containers(Some(ListContainersOptionsBuilder::default().all(true).build()))
            .await
            .unwrap()
            .into_iter()
            .map(|c| format!("{:?} {:?}", c.names, c.state))
            .collect();
        images.sort();
        volumes.sort();
        containers.sort();
        (images, volumes, containers)
    }

    #[tokio::test]
    #[ignore]
    async fn migration_plan_leaves_orbstack_unchanged() {
        let (src, _) = engines().await;
        let before = snapshot(&src).await;
        let plan = migration_plan().await.unwrap();
        assert!(plan.source.available && plan.target.available);
        assert!(!plan.images.is_empty());
        assert_eq!(snapshot(&src).await, before);
    }

    #[tokio::test]
    #[ignore]
    async fn migration_copies_a_volume_with_owners_and_modes() {
        let (src, dst) = engines().await;
        let t = tag();
        let vol = format!("hullport-verify-vol-{t}");
        src.create_volume(VolumeCreateRequest { name: Some(vol.clone()), ..Default::default() }).await.unwrap();
        run(&src, &format!("hullport-verify-fill-{t}"), vec![format!("{vol}:/v")], "mkdir /v/pg && echo secret > /v/pg/data && chown -R 70:70 /v/pg && chmod 700 /v/pg").await;

        let r = copy_volume(&src, &dst, &vol, false, &CancellationToken::new(), &channel()).await;
        let listing = run(&dst, &format!("hullport-verify-read-{t}"), vec![format!("{vol}:/v:ro")], "stat -c '%u:%g %a %n' /v/pg /v/pg/data; cat /v/pg/data").await;
        let helpers_left = src
            .list_containers(Some(ListContainersOptionsBuilder::default().all(true).filters(&crate::cmd::filters(&[("label", HELPER_LABEL)])).build()))
            .await
            .unwrap()
            .len();

        src.remove_volume(&vol, None::<bollard::query_parameters::RemoveVolumeOptions>).await.unwrap();
        dst.remove_volume(&vol, None::<bollard::query_parameters::RemoveVolumeOptions>).await.unwrap();
        assert_eq!(r.status, "done", "{r:?}");
        assert!(listing.contains("70:70 700 /v/pg"), "{listing}");
        assert!(listing.contains("70:70 644 /v/pg/data"), "{listing}");
        assert!(listing.contains("secret"), "{listing}");
        assert_eq!(helpers_left, 0, "helpers are removed from OrbStack");
    }

    #[tokio::test]
    #[ignore]
    async fn migration_copies_an_image_with_the_same_id() {
        let (src, dst) = engines().await;
        let t = tag();
        let repo = format!("hullport-verify-img-{t}");
        src.tag_image("alpine:latest", Some(TagImageOptionsBuilder::default().repo(&repo).tag("v1").build())).await.unwrap();
        let reference = format!("{repo}:v1");

        let r = copy_image(&src, &dst, &[reference.clone()], &reference, &CancellationToken::new(), &channel()).await;
        let (a, b) = (src.inspect_image(&reference).await.map(|i| i.id), dst.inspect_image(&reference).await.map(|i| i.id));

        let rm = || RemoveImageOptionsBuilder::default().noprune(true).build();
        src.remove_image(&reference, Some(rm()), None).await.unwrap();
        let _ = dst.remove_image(&reference, Some(rm()), None).await;
        assert_eq!(r.status, "done", "{r:?}");
        assert_eq!(a.unwrap(), b.expect("the tag arrived in Hullport"));
    }

    #[tokio::test]
    #[ignore]
    async fn migration_recreates_a_loose_container_stopped() {
        let (src, dst) = engines().await;
        let t = tag();
        let (name, net) = (format!("hullport-verify-loose-{t}"), format!("hullport-verify-net-{t}"));
        src.create_network(NetworkCreateRequest { name: net.clone(), driver: Some("bridge".into()), ..Default::default() }).await.unwrap();
        let body = ContainerCreateBody {
            image: Some("alpine:latest".into()),
            cmd: Some(vec!["sleep".into(), "60".into()]),
            env: Some(vec!["HULLPORT_VERIFY=1".into()]),
            labels: Some(HashMap::from([("dev.hullport.verify".into(), t.clone())])),
            host_config: Some(HostConfig {
                network_mode: Some(net.clone()),
                port_bindings: Some(HashMap::from([("80/tcp".into(), Some(vec![PortBinding { host_ip: Some("127.0.0.1".into()), host_port: Some("18099".into()) }]))])),
                ..Default::default()
            }),
            ..Default::default()
        };
        src.create_container(Some(CreateContainerOptionsBuilder::default().name(&name).build()), body).await.unwrap();

        let r = recreate_container(&src, &dst, &name).await;
        let copy = dst.inspect_container(&name, None).await;

        remove_helper(&src, &name).await;
        let _ = src.remove_network(&net).await;
        remove_helper(&dst, &name).await;
        let _ = dst.remove_network(&net).await;
        assert_eq!(r.status, "done", "{r:?}");
        let copy = copy.expect("created in Hullport");
        let cfg = copy.config.unwrap();
        assert!(cfg.env.unwrap().contains(&"HULLPORT_VERIFY=1".to_string()));
        assert_eq!(cfg.labels.unwrap().get("dev.hullport.verify"), Some(&t));
        assert_eq!(copy.state.and_then(|s| s.running), Some(false), "recreated stopped");
        let ports = copy.host_config.unwrap().port_bindings.unwrap();
        assert_eq!(ports["80/tcp"].as_ref().unwrap()[0].host_port.as_deref(), Some("18099"));
        assert!(copy.network_settings.unwrap().networks.unwrap().contains_key(&net));
    }
}
