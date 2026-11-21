//! The menu bar icon and the app's lifecycle. Closing the window only hides it: the engine keeps
//! running and the icon stays. Quit (from the icon, Cmd+Q, or SIGTERM/SIGINT) stops the VM first,
//! so a VM never runs without the icon that shows it.

use crate::engine::{Engine, EngineState};
use crate::login_item;
use crate::state::AppState;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, MenuItemKind, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, Wry};

pub struct Lifecycle {
    engine: Arc<Engine>,
    quitting: AtomicBool,
    status: MenuItem<Wry>,
    toggle: MenuItem<Wry>,
    login: CheckMenuItem<Wry>,
}

pub fn setup(app: &AppHandle, engine: Arc<Engine>) -> tauri::Result<()> {
    let status = MenuItem::with_id(app, "engine-status", "Engine: …", false, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Open Hullport", true, None::<&str>)?;
    let toggle = MenuItem::with_id(app, "engine-toggle", "Start Engine", false, None::<&str>)?;
    let login = CheckMenuItem::with_id(app, "login", "Open at Login", true, login_item::enabled(), None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit Hullport", true, None::<&str>)?;
    let separator = || PredefinedMenuItem::separator(app);
    let menu = Menu::with_items(app, &[&status, &separator()?, &open, &toggle, &login, &separator()?, &quit_item])?;
    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().cloned().expect("the bundle has an icon"))
        .tooltip("Hullport")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .build(app)?;
    use_own_quit_item(app)?;
    // One handler for the tray menu and the app menu.
    app.on_menu_event(on_menu);
    app.manage(Lifecycle { engine: engine.clone(), quitting: AtomicBool::new(false), status, toggle, login });

    // Keep the menu in step with the engine, including changes made outside the app.
    let handle = app.clone();
    std::thread::spawn(move || {
        let mut last = None;
        loop {
            let s = engine.refresh();
            let step = engine.progress(s).step;
            if last != Some((s, step)) {
                if s == EngineState::Running {
                    connect_to_engine(&handle);
                }
                show_state(&handle, s);
                last = Some((s, step));
            }
            // Follow start-up closely; otherwise only notice outside changes.
            std::thread::sleep(Duration::from_millis(if s == EngineState::Starting { 500 } else { 2000 }));
        }
    });

    // SIGTERM (launchd at logout, `kill`) and SIGINT (Ctrl+C in a terminal) quit cleanly too.
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        use tokio::signal::unix::{signal, SignalKind};
        let (Ok(mut term), Ok(mut int)) = (signal(SignalKind::terminate()), signal(SignalKind::interrupt())) else { return };
        tokio::select! {
            _ = term.recv() => {}
            _ = int.recv() => {}
        }
        quit(&handle);
    });

    start_engine(app);
    Ok(())
}

/// The default app menu's Quit terminates the process right away, without stopping the VM.
fn use_own_quit_item(app: &AppHandle) -> tauri::Result<()> {
    let menu = Menu::default(app)?;
    if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.into_iter().next() {
        for item in app_menu.items()? {
            if let MenuItemKind::Predefined(p) = &item {
                if p.text()?.starts_with("Quit") {
                    app_menu.remove(p)?;
                    app_menu.append(&MenuItem::with_id(app, "app-quit", "Quit Hullport", true, Some("CmdOrCtrl+Q"))?)?;
                }
            }
        }
    }
    app.set_menu(menu)?;
    Ok(())
}

fn on_menu(app: &AppHandle, event: MenuEvent) {
    match event.id.as_ref() {
        "open" => show_main(app),
        "engine-toggle" => {
            let Some(lc) = app.try_state::<Lifecycle>() else { return };
            if lc.engine.state() == EngineState::Running {
                stop_engine(app);
            } else {
                start_engine(app);
            }
        }
        "login" => {
            let Some(lc) = app.try_state::<Lifecycle>() else { return };
            let on = lc.login.is_checked().unwrap_or(false);
            if let Err(e) = login_item::set_enabled(on) {
                log::warn!("could not change the login item: {e}");
                let _ = lc.login.set_checked(login_item::enabled());
            }
        }
        "quit" | "app-quit" => quit(app),
        _ => {}
    }
}

fn show_state(app: &AppHandle, s: EngineState) {
    let Some(lc) = app.try_state::<Lifecycle>() else { return };
    if lc.quitting.load(Ordering::SeqCst) {
        return;
    }
    let progress = lc.engine.progress(s);
    let _ = lc.status.set_text(match &progress.step_label {
        Some(step) => format!("Engine: {step}…"),
        None => format!("Engine: {}", s.label()),
    });
    let (text, enabled) = match s {
        EngineState::Running => ("Stop Engine", true),
        EngineState::Stopped | EngineState::Failed => ("Start Engine", true),
        EngineState::NotInstalled => ("Start Engine", false),
        EngineState::Starting | EngineState::Stopping => (if s == EngineState::Starting { "Stop Engine" } else { "Start Engine" }, false),
    };
    let _ = lc.toggle.set_text(text);
    let _ = lc.toggle.set_enabled(enabled);
    if let Some(tray) = app.tray_by_id("main") {
        let tip = match (s, lc.engine.last_error()) {
            (EngineState::Failed, Some(e)) => format!("Hullport: engine failed: {e}"),
            _ => format!("Hullport: engine {}", s.label().to_lowercase()),
        };
        let _ = tray.set_tooltip(Some(tip));
    }
    let _ = app.emit("engine-state", progress);
}

/// The engine, when this run has the menu bar lifecycle (not in launch modes like --verify).
pub fn engine(app: &AppHandle) -> Option<Arc<Engine>> {
    app.try_state::<Lifecycle>().map(|lc| lc.engine.clone())
}

pub fn start_engine(app: &AppHandle) {
    let Some(lc) = app.try_state::<Lifecycle>() else { return };
    let engine = lc.engine.clone();
    let handle = app.clone();
    std::thread::spawn(move || {
        show_state(&handle, EngineState::Starting);
        match engine.start() {
            Ok(()) => connect_to_engine(&handle),
            Err(e) => log::warn!("engine start failed: {e}"),
        }
        show_state(&handle, engine.state());
    });
}

/// The engine just came up: move the app onto it if it's disconnected or on a stand-in, and
/// wait (briefly) for that connection, so "Running" never shows next to "Docker unavailable".
fn connect_to_engine(app: &AppHandle) {
    let Some(st) = app.try_state::<AppState>() else { return };
    if !st.docker.could_do_better() {
        return;
    }
    st.docker.reconnect();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while std::time::Instant::now() < deadline && st.docker.status().state != "connected" {
        std::thread::sleep(Duration::from_millis(100));
    }
}

pub fn stop_engine(app: &AppHandle) {
    let Some(lc) = app.try_state::<Lifecycle>() else { return };
    let engine = lc.engine.clone();
    let handle = app.clone();
    std::thread::spawn(move || {
        show_state(&handle, EngineState::Stopping);
        if let Err(e) = engine.stop() {
            log::warn!("engine stop failed: {e}");
        }
        show_state(&handle, engine.state());
    });
}

/// Stop the VM, then exit. Safe to call more than once.
pub fn quit(app: &AppHandle) {
    let Some(lc) = app.try_state::<Lifecycle>() else {
        app.exit(0);
        return;
    };
    if lc.quitting.swap(true, Ordering::SeqCst) {
        return;
    }
    let _ = lc.status.set_text("Stopping the engine…");
    let _ = lc.toggle.set_enabled(false);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
    let engine = lc.engine.clone();
    let handle = app.clone();
    std::thread::spawn(move || {
        if let Err(e) = engine.stop() {
            log::warn!("engine stop failed while quitting: {e}");
        }
        handle.exit(0);
    });
}

pub fn quitting(app: &AppHandle) -> bool {
    app.try_state::<Lifecycle>().is_some_and(|lc| lc.quitting.load(Ordering::SeqCst))
}

/// Last chance when the process ends some other way (e.g. a logout that terminates the app).
pub fn on_exit(app: &AppHandle) {
    if let Some(lc) = app.try_state::<Lifecycle>() {
        if lc.engine.refresh() == EngineState::Running {
            let _ = lc.engine.stop();
        }
    }
}

pub fn show_main(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Hide the window and the Dock icon; the menu bar icon stays.
pub fn hide_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
}
