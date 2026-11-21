use crate::error::AppResult;
use crate::state::AppState;
use bollard::models::{
    EndpointSettings, Ipam, IpamConfig, Network, NetworkConnectRequest, NetworkCreateRequest,
    NetworkDisconnectRequest, NetworkInspect,
};
use serde::Deserialize;
use std::collections::HashMap;
use tauri::State;

#[tauri::command]
pub async fn list_networks(state: State<'_, AppState>) -> AppResult<Vec<Network>> {
    let d = state.docker.docker()?;
    Ok(d.list_networks(None).await?)
}

#[tauri::command]
pub async fn inspect_network(state: State<'_, AppState>, id: String) -> AppResult<NetworkInspect> {
    let d = state.docker.docker()?;
    Ok(d.inspect_network(&id, None).await?)
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct CreateNetworkSpec {
    pub name: String,
    pub driver: Option<String>,
    pub subnet: Option<String>,
    pub gateway: Option<String>,
    pub ip_range: Option<String>,
    #[serde(default)]
    pub internal: bool,
    #[serde(default)]
    pub attachable: bool,
    #[serde(default)]
    pub ipv6: bool,
    #[serde(default)]
    pub labels: Vec<crate::cmd::containers::KV>,
}

#[tauri::command]
pub async fn create_network(state: State<'_, AppState>, spec: CreateNetworkSpec) -> AppResult<String> {
    let d = state.docker.docker()?;
    let nz = |s: &Option<String>| s.clone().map(|x| x.trim().to_string()).filter(|x| !x.is_empty());
    let ipam = if nz(&spec.subnet).is_some() || nz(&spec.gateway).is_some() || nz(&spec.ip_range).is_some() {
        Some(Ipam {
            driver: Some("default".into()),
            config: Some(vec![IpamConfig {
                subnet: nz(&spec.subnet),
                gateway: nz(&spec.gateway),
                ip_range: nz(&spec.ip_range),
                ..Default::default()
            }]),
            options: None,
        })
    } else {
        None
    };
    let labels: HashMap<String, String> = spec
        .labels
        .iter()
        .filter(|k| !k.key.trim().is_empty())
        .map(|k| (k.key.trim().to_string(), k.value.clone()))
        .collect();
    let req = NetworkCreateRequest {
        name: spec.name.trim().to_string(),
        driver: nz(&spec.driver),
        internal: Some(spec.internal),
        attachable: Some(spec.attachable),
        enable_ipv6: Some(spec.ipv6),
        ipam,
        labels: if labels.is_empty() { None } else { Some(labels) },
        ..Default::default()
    };
    let res = d.create_network(req).await?;
    Ok(res.id)
}

#[tauri::command]
pub async fn remove_network(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let d = state.docker.docker()?;
    d.remove_network(&id).await?;
    Ok(())
}

#[tauri::command]
pub async fn connect_network(
    state: State<'_, AppState>,
    network: String,
    container: String,
    aliases: Option<Vec<String>>,
    ipv4: Option<String>,
) -> AppResult<()> {
    let d = state.docker.docker()?;
    let aliases = aliases.map(|a| a.into_iter().filter(|s| !s.trim().is_empty()).collect::<Vec<_>>()).filter(|a| !a.is_empty());
    let ipam_config = ipv4.filter(|s| !s.trim().is_empty()).map(|ip| bollard::models::EndpointIpamConfig {
        ipv4_address: Some(ip.trim().to_string()),
        ..Default::default()
    });
    d.connect_network(
        &network,
        NetworkConnectRequest {
            container,
            endpoint_config: Some(EndpointSettings { aliases, ipam_config, ..Default::default() }),
        },
    )
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn disconnect_network(state: State<'_, AppState>, network: String, container: String, force: bool) -> AppResult<()> {
    let d = state.docker.docker()?;
    d.disconnect_network(&network, NetworkDisconnectRequest { container, force: Some(force) }).await?;
    Ok(())
}
