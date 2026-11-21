//! Interactive terminal: `docker exec` with a PTY, bytes streamed both ways.

use crate::error::{other, AppResult};
use crate::state::{AppState, ExecSession};
use base64::Engine;
use bollard::exec::{CreateExecOptions, ResizeExecOptions, StartExecOptions, StartExecResults};
use futures_util::StreamExt;
use serde::Serialize;
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::State;
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ExecEvent {
    /// Base64-encoded terminal output.
    Data { data: String },
    Exit { code: Option<i64>, error: Option<String> },
}

#[tauri::command]
pub async fn exec_open(
    state: State<'_, AppState>,
    container: String,
    command: Option<String>,
    user: Option<String>,
    cols: u16,
    rows: u16,
    channel: Channel<ExecEvent>,
) -> AppResult<String> {
    let d = state.docker.docker()?;
    let cmd: Vec<String> = match command.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(c) => crate::cmd::containers::split_args(c),
        None => vec![
            "/bin/sh".into(),
            "-c".into(),
            "if command -v bash >/dev/null 2>&1; then exec bash -l; elif command -v ash >/dev/null 2>&1; then exec ash -l; else exec sh; fi".into(),
        ],
    };
    let exec = d
        .create_exec(
            &container,
            CreateExecOptions {
                attach_stdin: Some(true),
                attach_stdout: Some(true),
                attach_stderr: Some(true),
                tty: Some(true),
                cmd: Some(cmd),
                user: user.filter(|u| !u.is_empty()),
                env: Some(vec!["TERM=xterm-256color".into(), "COLORTERM=truecolor".into()]),
                ..Default::default()
            },
        )
        .await?;
    let started = d
        .start_exec(&exec.id, Some(StartExecOptions { detach: false, tty: true, output_capacity: Some(64 * 1024) }))
        .await?;
    let StartExecResults::Attached { mut output, input } = started else {
        return Err(other("The engine did not attach to the terminal"));
    };
    let _ = d.resize_exec(&exec.id, ResizeExecOptions { height: rows.max(2), width: cols.max(10) }).await;

    let session_id = uuid::Uuid::new_v4().to_string();
    let cancel = CancellationToken::new();
    state.execs.lock().unwrap().insert(
        session_id.clone(),
        ExecSession {
            exec_id: exec.id.clone(),
            input: Arc::new(tokio::sync::Mutex::new(input)),
            cancel: cancel.clone(),
        },
    );
    let exec_id = exec.id.clone();
    tauri::async_runtime::spawn(async move {
        let b64 = base64::engine::general_purpose::STANDARD;
        let mut error = None;
        loop {
            tokio::select! {
                _ = cancel.cancelled() => break,
                item = output.next() => match item {
                    Some(Ok(out)) => {
                        if channel.send(ExecEvent::Data { data: b64.encode(out.into_bytes()) }).is_err() { break; }
                    }
                    Some(Err(e)) => { error = Some(e.to_string()); break; }
                    None => break,
                }
            }
        }
        let code = d.inspect_exec(&exec_id).await.ok().and_then(|i| i.exit_code);
        let _ = channel.send(ExecEvent::Exit { code, error });
    });
    Ok(session_id)
}

#[tauri::command]
pub async fn exec_write(state: State<'_, AppState>, session: String, data: String) -> AppResult<()> {
    let input = {
        let map = state.execs.lock().unwrap();
        map.get(&session).map(|s| s.input.clone())
    };
    let input = input.ok_or_else(|| other("Terminal session ended"))?;
    let mut w = input.lock().await;
    w.write_all(data.as_bytes()).await?;
    w.flush().await?;
    Ok(())
}

#[tauri::command]
pub async fn exec_resize(state: State<'_, AppState>, session: String, cols: u16, rows: u16) -> AppResult<()> {
    let exec_id = state.execs.lock().unwrap().get(&session).map(|s| s.exec_id.clone());
    if let Some(id) = exec_id {
        let d = state.docker.docker()?;
        d.resize_exec(&id, ResizeExecOptions { height: rows.max(2), width: cols.max(10) }).await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn exec_close(state: State<'_, AppState>, session: String) -> AppResult<()> {
    let s = state.execs.lock().unwrap().remove(&session);
    if let Some(s) = s {
        {
            let mut w = s.input.lock().await;
            let _ = w.shutdown().await;
        }
        s.cancel.cancel();
    }
    Ok(())
}

/// One-shot command (used by the self-test and quick actions).
#[tauri::command]
pub async fn exec_run(state: State<'_, AppState>, container: String, command: String) -> AppResult<(String, i64)> {
    let d = state.docker.docker()?;
    crate::cmd::volumes::exec_collect(&d, &container, crate::cmd::containers::split_args(&command)).await
}
