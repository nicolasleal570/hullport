// Hullport: a lightweight Docker manager for macOS.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cmd;
mod docker;
mod error;
mod state;
mod store;

use state::{AppState, LaunchMode};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

fn parse_launch() -> LaunchMode {
    let args: Vec<String> = std::env::args().collect();
    let mut mode = LaunchMode { mode: "normal".into(), path: None, fixtures: None, external: None, section: None };
    let mut i = 1;
    while i < args.len() {
        let flag = args[i].as_str();
        let value = args.get(i + 1).cloned();
        match flag {
            "--screenshot" => {
                mode.mode = "screenshot".into();
                mode.path = value.map(absolute);
                i += 1;
            }
            "--self-test" => {
                mode.mode = "selftest".into();
                mode.path = value.map(absolute);
                i += 1;
            }
            "--verify" => {
                mode.mode = "verify".into();
                mode.path = value.map(absolute);
                i += 1;
            }
            "--fixtures" => {
                mode.fixtures = value.map(absolute);
                i += 1;
            }
            "--section" => {
                mode.section = value;
                i += 1;
            }
            "--external" => {
                mode.external = value;
                i += 1;
            }
            _ => {}
        }
        i += 1;
    }
    mode
}

fn absolute(p: String) -> String {
    let path = std::path::PathBuf::from(&p);
    if path.is_absolute() {
        p
    } else {
        std::env::current_dir().map(|d| d.join(path).display().to_string()).unwrap_or(p)
    }
}

fn main() {
    let launch = parse_launch();
    let quiet = launch.mode != "normal";

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            if quiet {
                // Never steal focus while a check mode runs.
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }
            let data_dir = app.path().app_data_dir().unwrap_or_else(|_| std::env::temp_dir().join("hullport"));
            // Bring over prefs and build history saved before the rename (dev.berth.app), once.
            if let Some(parent) = data_dir.parent() {
                if let Err(e) = store::import_legacy(&data_dir, &parent.join(store::LEGACY_DIR)) {
                    log::warn!("could not import data from {}: {e}", store::LEGACY_DIR);
                }
            }
            let store = store::Store::new(data_dir);
            let prefs = store.prefs();
            let manager = docker::DockerManager::new(prefs.context.clone());
            manager.spawn_supervisor(app.handle().clone());

            // Clear helper containers a previous run may have left behind.
            let m2 = manager.clone();
            tauri::async_runtime::spawn(async move {
                for _ in 0..20 {
                    if let Ok(d) = m2.docker() {
                        cmd::volumes::cleanup_stale_helpers(&d).await;
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                }
            });

            app.manage(AppState {
                docker: manager,
                store,
                launch: launch.clone(),
                ops: Mutex::new(HashMap::new()),
                execs: Mutex::new(HashMap::new()),
                builds: Mutex::new(HashMap::new()),
                volume_helpers: tokio::sync::Mutex::new(HashMap::new()),
            });

            let mut win = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Hullport")
                .inner_size(1280.0, 820.0)
                .min_inner_size(920.0, 560.0)
                .focused(!quiet)
                .visible(true);
            #[cfg(target_os = "macos")]
            {
                use tauri::utils::config::WindowEffectsConfig;
                use tauri::window::{Effect, EffectState};
                win = win
                    .title_bar_style(tauri::TitleBarStyle::Overlay)
                    .hidden_title(true)
                    .traffic_light_position(tauri::LogicalPosition::new(16.0, 20.0));
                if !quiet {
                    win = win.transparent(true).effects(WindowEffectsConfig {
                        effects: vec![Effect::Sidebar],
                        state: Some(EffectState::FollowsWindowActiveState),
                        radius: None,
                        color: None,
                        interactive: false,
                    });
                }
            }
            win.build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            cmd::system::get_status,
            cmd::system::list_contexts,
            cmd::system::set_context,
            cmd::system::reconnect,
            cmd::system::disk_usage,
            cmd::system::cancel_op,
            cmd::system::launch_mode,
            cmd::system::write_launch_output_b64,
            cmd::system::write_launch_output_text,
            cmd::system::exit_app,
            cmd::system::docker_cli_path,
            cmd::engines::engines_overview,
            cmd::engines::engine_task,
            cmd::containers::list_containers,
            cmd::containers::inspect_container,
            cmd::containers::container_action,
            cmd::containers::remove_container,
            cmd::containers::rename_container,
            cmd::containers::create_container,
            cmd::containers::stream_logs,
            cmd::containers::stream_stats,
            cmd::containers::container_top,
            cmd::exec::exec_open,
            cmd::exec::exec_write,
            cmd::exec::exec_resize,
            cmd::exec::exec_close,
            cmd::exec::exec_run,
            cmd::images::list_images,
            cmd::images::inspect_image,
            cmd::images::image_history,
            cmd::images::tag_image,
            cmd::images::remove_image,
            cmd::images::prune_images,
            cmd::images::pull_image,
            cmd::volumes::list_volumes,
            cmd::volumes::inspect_volume,
            cmd::volumes::create_volume,
            cmd::volumes::remove_volume,
            cmd::volumes::volume_list_dir,
            cmd::volumes::volume_read_file,
            cmd::volumes::volume_export,
            cmd::volumes::volume_browse_close,
            cmd::networks::list_networks,
            cmd::networks::inspect_network,
            cmd::networks::create_network,
            cmd::networks::remove_network,
            cmd::networks::connect_network,
            cmd::networks::disconnect_network,
            cmd::builds::build_start,
            cmd::builds::build_cancel,
            cmd::builds::build_records,
            cmd::builds::delete_build_records,
            cmd::builds::build_configs,
            cmd::builds::save_build_config,
            cmd::builds::delete_build_config,
            cmd::builds::buildkit_history,
            cmd::builds::buildkit_history_inspect,
            cmd::builds::buildkit_history_logs,
            cmd::builds::buildkit_history_remove,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Hullport")
        .run(|app, event| {
            if let RunEvent::ExitRequested { .. } = event {
                let state = app.state::<AppState>();
                tauri::async_runtime::block_on(cmd::volumes::close_all_helpers(&state));
            }
        });
}
