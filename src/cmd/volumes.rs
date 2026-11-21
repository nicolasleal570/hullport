//! Volumes, plus a read-only file browser. Volume data lives inside the
//! engine's Linux VM, so files are reached through a short-lived helper
//! container that mounts the volume read-only (labelled so it is ours).

use crate::cmd::images::pull_quiet;
use crate::error::{other, AppError, AppResult};
use crate::state::AppState;
use bollard::exec::{CreateExecOptions, StartExecResults};
use bollard::models::{
    ContainerCreateBody, HostConfig, Mount, MountType, Volume, VolumeCreateRequest,
};
use bollard::query_parameters::{
    CreateContainerOptionsBuilder, DownloadFromContainerOptionsBuilder, ListContainersOptionsBuilder,
    ListImagesOptionsBuilder, RemoveContainerOptionsBuilder, RemoveVolumeOptionsBuilder,
};
use bollard::Docker;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Read;
use tauri::State;

pub const HELPER_LABEL: &str = "dev.hullport.helper";
/// Label used before the rename to Hullport; still cleaned up so old helpers don't linger.
const LEGACY_HELPER_LABEL: &str = "dev.berth.helper";

#[tauri::command]
pub async fn list_volumes(state: State<'_, AppState>) -> AppResult<Vec<Volume>> {
    let d = state.docker.docker()?;
    let res = d.list_volumes(None::<bollard::query_parameters::ListVolumesOptions>).await?;
    Ok(res.volumes.unwrap_or_default())
}

#[tauri::command]
pub async fn inspect_volume(state: State<'_, AppState>, name: String) -> AppResult<Volume> {
    let d = state.docker.docker()?;
    Ok(d.inspect_volume(&name).await?)
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct CreateVolumeSpec {
    pub name: String,
    pub driver: Option<String>,
    #[serde(default)]
    pub labels: Vec<crate::cmd::containers::KV>,
    #[serde(default)]
    pub driver_opts: Vec<crate::cmd::containers::KV>,
}

#[tauri::command]
pub async fn create_volume(state: State<'_, AppState>, spec: CreateVolumeSpec) -> AppResult<Volume> {
    let d = state.docker.docker()?;
    let to_map = |kvs: &Vec<crate::cmd::containers::KV>| -> Option<HashMap<String, String>> {
        let m: HashMap<String, String> = kvs
            .iter()
            .filter(|k| !k.key.trim().is_empty())
            .map(|k| (k.key.trim().to_string(), k.value.clone()))
            .collect();
        if m.is_empty() { None } else { Some(m) }
    };
    let req = VolumeCreateRequest {
        name: Some(spec.name.trim().to_string()).filter(|s| !s.is_empty()),
        driver: spec.driver.clone().filter(|s| !s.is_empty()),
        labels: to_map(&spec.labels),
        driver_opts: to_map(&spec.driver_opts),
        ..Default::default()
    };
    Ok(d.create_volume(req).await?)
}

#[tauri::command]
pub async fn remove_volume(state: State<'_, AppState>, name: String, force: bool) -> AppResult<()> {
    let d = state.docker.docker()?;
    close_helper(&state, &d, &name).await;
    d.remove_volume(&name, Some(RemoveVolumeOptionsBuilder::default().force(force).build())).await?;
    Ok(())
}

/// Remove helper containers left behind by a previous run (only ones carrying our label).
pub async fn cleanup_stale_helpers(d: &Docker) {
    for label in [HELPER_LABEL, LEGACY_HELPER_LABEL] {
        let f = crate::cmd::filters(&[("label", label)]);
        if let Ok(list) = d.list_containers(Some(ListContainersOptionsBuilder::default().all(true).filters(&f).build())).await {
            for c in list {
                if let Some(id) = c.id {
                    let _ = d.remove_container(&id, Some(RemoveContainerOptionsBuilder::default().force(true).build())).await;
                }
            }
        }
    }
}

async fn helper_image(d: &Docker) -> AppResult<String> {
    let list = d.list_images(Some(ListImagesOptionsBuilder::default().build())).await?;
    for candidate in ["alpine:latest", "busybox:latest"] {
        let found = list.iter().any(|i| i.repo_tags.iter().any(|t| t == candidate));
        if found {
            return Ok(candidate.to_string());
        }
    }
    pull_quiet(d, "alpine:latest", None).await?;
    Ok("alpine:latest".into())
}

async fn ensure_helper(state: &AppState, d: &Docker, volume: &str) -> AppResult<String> {
    let mut helpers = state.volume_helpers.lock().await;
    if let Some(id) = helpers.get(volume) {
        if let Ok(info) = d.inspect_container(id, None).await {
            if info.state.and_then(|s| s.running).unwrap_or(false) {
                return Ok(id.clone());
            }
        }
        helpers.remove(volume);
    }
    let image = helper_image(d).await?;
    let mut labels = HashMap::new();
    labels.insert(HELPER_LABEL.to_string(), "volume-browser".to_string());
    labels.insert("dev.hullport.volume".to_string(), volume.to_string());
    let body = ContainerCreateBody {
        image: Some(image),
        cmd: Some(vec!["sleep".into(), "3600".into()]),
        labels: Some(labels),
        host_config: Some(HostConfig {
            mounts: Some(vec![Mount {
                typ: Some(MountType::VOLUME),
                source: Some(volume.to_string()),
                target: Some("/vol".into()),
                read_only: Some(true),
                ..Default::default()
            }]),
            auto_remove: Some(true),
            network_mode: Some("none".into()),
            ..Default::default()
        }),
        ..Default::default()
    };
    let name = format!("hullport-volume-browser-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
    let created = d
        .create_container(Some(CreateContainerOptionsBuilder::default().name(&name).build()), body)
        .await?;
    d.start_container(&created.id, None).await?;
    helpers.insert(volume.to_string(), created.id.clone());
    Ok(created.id)
}

async fn close_helper(state: &AppState, d: &Docker, volume: &str) {
    let id = state.volume_helpers.lock().await.remove(volume);
    if let Some(id) = id {
        let _ = d.remove_container(&id, Some(RemoveContainerOptionsBuilder::default().force(true).build())).await;
    }
}

pub async fn close_all_helpers(state: &AppState) {
    let Ok(d) = state.docker.docker() else { return };
    let ids: Vec<String> = state.volume_helpers.lock().await.drain().map(|(_, v)| v).collect();
    for id in ids {
        let _ = d.remove_container(&id, Some(RemoveContainerOptionsBuilder::default().force(true).build())).await;
    }
}

/// Run a command in a container and collect its output and exit code.
pub async fn exec_collect(d: &Docker, container: &str, cmd: Vec<String>) -> AppResult<(String, i64)> {
    let exec = d
        .create_exec(
            container,
            CreateExecOptions {
                attach_stdout: Some(true),
                attach_stderr: Some(true),
                cmd: Some(cmd),
                ..Default::default()
            },
        )
        .await?;
    let mut text = String::new();
    if let StartExecResults::Attached { mut output, .. } = d.start_exec(&exec.id, None).await? {
        while let Some(item) = output.next().await {
            text.push_str(&String::from_utf8_lossy(&item?.into_bytes()));
        }
    }
    let code = d.inspect_exec(&exec.id).await?.exit_code.unwrap_or(0);
    Ok((text, code))
}

fn safe_path(p: &str) -> AppResult<String> {
    let mut parts = Vec::new();
    for seg in p.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    Ok(format!("/vol/{}", parts.join("/")).trim_end_matches('/').to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub kind: String,
    pub size: u64,
    pub modified: i64,
    pub mode: String,
}

#[tauri::command]
pub async fn volume_list_dir(state: State<'_, AppState>, volume: String, path: String) -> AppResult<Vec<FileEntry>> {
    let d = state.docker.docker()?;
    let helper = ensure_helper(&state, &d, &volume).await?;
    let dir = safe_path(&path)?;
    let script = r#"cd -- "$1" || exit 3; for f in .* *; do [ "$f" = . ] || [ "$f" = .. ] || { [ -e "$f" ] || [ -L "$f" ]; } && stat -c '%F|%s|%Y|%A|%n' -- "$f"; done; exit 0"#;
    let (out, code) = exec_collect(
        &d,
        &helper,
        vec!["sh".into(), "-c".into(), script.into(), "sh".into(), dir.clone()],
    )
    .await?;
    if code == 3 {
        return Err(other(format!("Cannot open {}", dir.trim_start_matches("/vol"))));
    }
    let mut entries: Vec<FileEntry> = out
        .lines()
        .filter_map(|l| {
            let mut it = l.splitn(5, '|');
            let kind = it.next()?;
            let size = it.next()?.parse().unwrap_or(0);
            let modified = it.next()?.parse().unwrap_or(0);
            let mode = it.next()?.to_string();
            let name = it.next()?.to_string();
            let kind = match kind {
                "directory" => "dir",
                "symbolic link" => "link",
                k if k.contains("regular") => "file",
                _ => "other",
            };
            Some(FileEntry { name, kind: kind.into(), size, modified, mode })
        })
        .collect();
    entries.sort_by(|a, b| (a.kind != "dir").cmp(&(b.kind != "dir")).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(entries)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub text: Option<String>,
    pub binary: bool,
    pub truncated: bool,
    pub size: u64,
}

async fn download_tar(d: &Docker, container: &str, path: &str, limit: usize) -> AppResult<(Vec<u8>, bool)> {
    let mut s = d.download_from_container(container, Some(DownloadFromContainerOptionsBuilder::default().path(path).build()));
    let mut buf = Vec::new();
    let mut truncated = false;
    while let Some(chunk) = s.next().await {
        buf.extend_from_slice(&chunk?);
        if buf.len() > limit {
            truncated = true;
            break;
        }
    }
    Ok((buf, truncated))
}

#[tauri::command]
pub async fn volume_read_file(state: State<'_, AppState>, volume: String, path: String) -> AppResult<FileContent> {
    const MAX: usize = 1024 * 1024;
    let d = state.docker.docker()?;
    let helper = ensure_helper(&state, &d, &volume).await?;
    let full = safe_path(&path)?;
    let (tarball, cut) = download_tar(&d, &helper, &full, MAX + 1024).await?;
    // Parse just the first header by hand: a truncated archive can't go through the tar reader safely.
    if tarball.len() < 512 {
        return Err(other("Empty response from engine"));
    }
    let header = tar::Header::from_byte_slice(&tarball[..512]);
    let size = header.size().unwrap_or(0);
    if header.entry_type().is_dir() {
        return Err(other("That is a folder"));
    }
    let data_end = (512 + size as usize).min(tarball.len());
    let mut data = tarball[512..data_end].to_vec();
    let truncated = cut || data.len() as u64 > MAX as u64 || (data.len() as u64) < size;
    data.truncate(MAX);
    let binary = data.iter().take(8192).any(|b| *b == 0);
    Ok(FileContent {
        text: if binary { None } else { Some(String::from_utf8_lossy(&data).to_string()) },
        binary,
        truncated,
        size,
    })
}

/// Save a file (its bytes) or a folder (as a .tar archive) from the volume to the Mac.
#[tauri::command]
pub async fn volume_export(state: State<'_, AppState>, volume: String, path: String, dest: String) -> AppResult<u64> {
    let d = state.docker.docker()?;
    let helper = ensure_helper(&state, &d, &volume).await?;
    let full = safe_path(&path)?;
    let (tarball, _) = download_tar(&d, &helper, &full, usize::MAX).await?;
    let mut archive = tar::Archive::new(std::io::Cursor::new(&tarball));
    let first_is_file = archive
        .entries()
        .map_err(|e| other(e.to_string()))?
        .next()
        .and_then(|e| e.ok())
        .map(|e| e.header().entry_type().is_file())
        .unwrap_or(false);
    if first_is_file {
        let mut archive = tar::Archive::new(std::io::Cursor::new(&tarball));
        let mut entry = archive.entries().map_err(|e| other(e.to_string()))?.next().ok_or_else(|| other("empty archive"))?.map_err(|e| other(e.to_string()))?;
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes)?;
        std::fs::write(&dest, &bytes)?;
        Ok(bytes.len() as u64)
    } else {
        std::fs::write(&dest, &tarball)?;
        Ok(tarball.len() as u64)
    }
}

#[tauri::command]
pub async fn volume_browse_close(state: State<'_, AppState>, volume: String) -> AppResult<()> {
    let d = state.docker.docker().map_err(|e: AppError| e)?;
    close_helper(&state, &d, &volume).await;
    Ok(())
}
