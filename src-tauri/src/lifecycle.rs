use crate::{
    error::{AppError, AppResult},
    execution::Executions,
};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WebviewWindow, WindowEvent};
#[cfg(not(target_os = "macos"))]
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

#[derive(Default)]
pub struct Lifecycle {
    ready: AtomicBool,
    pending: AtomicBool,
    allowed: AtomicBool,
}
#[cfg(not(target_os = "macos"))]
pub fn window_flags() -> StateFlags {
    StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED
}
#[tauri::command]
pub async fn start_titlebar_drag(window: WebviewWindow) -> AppResult<()> {
    main_only(&window)?;
    #[cfg(target_os = "macos")]
    {
        let target = window.clone();
        let (send, receive) = tokio::sync::oneshot::channel();
        window
            .run_on_main_thread(move || {
                let _ = send.send(crate::macos_input::drag(&target));
            })
            .map_err(|_| AppError::new("WINDOW_ERROR", "Could not start dragging."))?;
        receive
            .await
            .map_err(|_| AppError::new("WINDOW_ERROR", "Window closed before dragging."))?
    }
    #[cfg(not(target_os = "macos"))]
    window
        .start_dragging()
        .map_err(|_| AppError::new("WINDOW_ERROR", "Could not start dragging."))
}
pub fn request_quit(app: &AppHandle) {
    let state = app.state::<Lifecycle>();
    state.pending.store(true, Ordering::SeqCst);
    if state.ready.load(Ordering::SeqCst) {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
        if app.emit_to("main", "shell-action", "request-quit").is_err() {
            eprintln!("Could not deliver close confirmation. Application remains open.");
        }
    }
}
fn main_only(window: &WebviewWindow) -> AppResult<()> {
    if window.label() != "main" {
        return Err(AppError::new(
            "FORBIDDEN",
            "Only the main window may close the application.",
        ));
    }
    Ok(())
}
#[tauri::command]
pub fn close_guard_ready(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, Lifecycle>,
) -> AppResult<()> {
    main_only(&window)?;
    state.ready.store(true, Ordering::SeqCst);
    if state.pending.load(Ordering::SeqCst) {
        request_quit(&app);
    }
    Ok(())
}
#[tauri::command]
pub fn cancel_quit(window: WebviewWindow, state: State<'_, Lifecycle>) -> AppResult<()> {
    main_only(&window)?;
    state.pending.store(false, Ordering::SeqCst);
    Ok(())
}
#[tauri::command]
pub async fn finish_quit(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, Lifecycle>,
    executions: State<'_, Executions>,
    discard_window_state: bool,
) -> AppResult<()> {
    main_only(&window)?;
    if !state.pending.load(Ordering::SeqCst) {
        return Err(AppError::new(
            "CONFLICT",
            "No native close request is pending.",
        ));
    }
    if executions.active_count() != 0 {
        return Err(AppError::new(
            "BUSY",
            "Wait for active requests to finish cancelling before quitting.",
        ));
    }
    let copy = app.clone();
    #[cfg(not(target_os = "macos"))]
    let saved =
        tauri::async_runtime::spawn_blocking(move || copy.save_window_state(window_flags())).await;
    #[cfg(target_os = "macos")]
    let saved =
        tauri::async_runtime::spawn_blocking(move || crate::macos_window_state::save(&copy)).await;
    if !discard_window_state && !matches!(saved, Ok(Ok(()))) {
        return Err(AppError::new("WINDOW_STATE_ERROR","Window state could not be saved. Retry or explicitly quit without saving session/window state."));
    }
    state.allowed.store(true, Ordering::SeqCst);
    app.exit(0);
    Ok(())
}
pub fn on_event(app: &AppHandle, event: RunEvent) {
    match event {
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::CloseRequested { api, .. },
            ..
        } if label == "main" => {
            if !app.state::<Lifecycle>().allowed.load(Ordering::SeqCst) {
                api.prevent_close();
                request_quit(app);
            }
        }
        RunEvent::ExitRequested { api, code, .. } => {
            // The opt-in QA harness owns programmatic test termination. Ordinary
            // native/user close paths always pass through confirmation.
            #[cfg(all(feature = "native-smoke", target_os = "macos"))]
            if code.is_some() {
                return;
            }
            let _ = code;
            if !app.state::<Lifecycle>().allowed.load(Ordering::SeqCst) {
                api.prevent_exit();
                request_quit(app);
            }
        }
        RunEvent::Exit => {
            #[cfg(target_os = "macos")]
            crate::macos_input::shutdown();
            app.state::<Executions>().cancel_all();
        }
        _ => {}
    }
}
