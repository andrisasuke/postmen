mod collection_export;
mod collection_import;
mod commands;
mod db;
mod error;
mod execution;
mod lifecycle;
#[cfg(target_os = "macos")]
mod macos_input;
#[cfg(target_os = "macos")]
mod macos_window_state;
mod models;
#[cfg(all(feature = "native-smoke", target_os = "macos"))]
mod native_smoke;
mod storage_profile;
mod workspaces;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    Emitter, Manager,
};

pub fn run() {
    let mut context = tauri::generate_context!();
    storage_profile::prepare(context.config_mut())
        .expect("could not configure isolated development storage");
    #[cfg(all(feature = "native-smoke", target_os = "macos"))]
    let window_state_file = native_smoke::prepare()
        .expect("Invalid QA directories")
        .join("window-state-v1.json")
        .to_string_lossy()
        .into_owned();
    #[cfg(not(all(feature = "native-smoke", target_os = "macos")))]
    let window_state_file = "window-state-v1.json".to_string();
    let builder = tauri::Builder::default().plugin(tauri_plugin_dialog::init());
    #[cfg(not(target_os = "macos"))]
    let builder = builder.plugin(
        tauri_plugin_window_state::Builder::default()
            .with_filename(window_state_file.clone())
            .with_state_flags(lifecycle::window_flags())
            .build(),
    );
    builder
        .manage(lifecycle::Lifecycle::default())
        .manage(collection_import::Imports::default())
        .manage(collection_export::Exports::default())
        .setup(move |app| {
            #[cfg(all(feature = "native-smoke", target_os = "macos"))]
            let data_dir =
                native_smoke::prepare().map_err(|error| -> Box<dyn std::error::Error> { error })?;
            #[cfg(not(all(feature = "native-smoke", target_os = "macos")))]
            let data_dir = app.path().app_data_dir()?;
            app.manage(workspaces::Registry::new(data_dir.clone()));
            app.manage(db::Database::new(data_dir.join("postmen.sqlite3")));
            app.manage(execution::Executions::new()?);
            let handle = app.handle();
            let about = MenuItem::with_id(handle, "about", "About PostMen", true, None::<&str>)?;
            let application = Submenu::with_items(
                handle,
                "PostMen",
                true,
                &[
                    &about,
                    &PredefinedMenuItem::separator(handle)?,
                    &PredefinedMenuItem::hide(handle, None)?,
                    &PredefinedMenuItem::hide_others(handle, None)?,
                    &PredefinedMenuItem::show_all(handle, None)?,
                    &PredefinedMenuItem::separator(handle)?,
                    &MenuItem::with_id(
                        handle,
                        "request-quit",
                        "Quit PostMen",
                        true,
                        Some("CmdOrCtrl+Q"),
                    )?,
                ],
            )?;
            let edit = Submenu::with_items(
                handle,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(handle, None)?,
                    &PredefinedMenuItem::redo(handle, None)?,
                    &PredefinedMenuItem::separator(handle)?,
                    &PredefinedMenuItem::cut(handle, None)?,
                    &PredefinedMenuItem::copy(handle, None)?,
                    &PredefinedMenuItem::paste(handle, None)?,
                    &PredefinedMenuItem::select_all(handle, None)?,
                ],
            )?;
            let view = Submenu::with_items(
                handle,
                "View",
                true,
                &[
                    &MenuItem::with_id(
                        handle,
                        "send-request",
                        "Send Request",
                        true,
                        Some("CmdOrCtrl+Enter"),
                    )?,
                    &MenuItem::with_id(
                        handle,
                        "toggle-sidebar",
                        "Toggle Sidebar",
                        true,
                        Some("CmdOrCtrl+B"),
                    )?,
                    &MenuItem::with_id(
                        handle,
                        "toggle-layout",
                        "Toggle Response Layout",
                        true,
                        Some("CmdOrCtrl+Shift+L"),
                    )?,
                    &MenuItem::with_id(handle, "reset-layout", "Reset Layout", true, None::<&str>)?,
                ],
            )?;
            let request = Submenu::with_items(
                handle,
                "Request",
                true,
                &[
                    &MenuItem::with_id(
                        handle,
                        "save-request",
                        "Save Request",
                        true,
                        Some("CmdOrCtrl+S"),
                    )?,
                    &MenuItem::with_id(
                        handle,
                        "close-request",
                        "Close Request Tab",
                        true,
                        Some("CmdOrCtrl+W"),
                    )?,
                    &MenuItem::with_id(
                        handle,
                        "next-request",
                        "Next Request Tab",
                        true,
                        Some("Ctrl+Tab"),
                    )?,
                    &MenuItem::with_id(
                        handle,
                        "previous-request",
                        "Previous Request Tab",
                        true,
                        Some("Ctrl+Shift+Tab"),
                    )?,
                ],
            )?;
            #[cfg(target_os = "macos")]
            let zoom = MenuItem::with_id(handle, "zoom-window", "Zoom", true, None::<&str>)?;
            #[cfg(not(target_os = "macos"))]
            let zoom = PredefinedMenuItem::maximize(handle, None)?;
            let window = Submenu::with_items(
                handle,
                "Window",
                true,
                &[&PredefinedMenuItem::minimize(handle, None)?, &zoom],
            )?;
            app.set_menu(Menu::with_items(
                handle,
                &[&application, &edit, &request, &view, &window],
            )?)?;
            #[cfg(all(feature = "native-smoke", target_os = "macos"))]
            if let Ok(id) = std::env::var("POSTMEN_SMOKE_DATA_STORE_ID") {
                let identifier = uuid::Uuid::parse_str(&id)?;
                let config = app
                    .config()
                    .app
                    .windows
                    .iter()
                    .find(|w| w.label == "main")
                    .ok_or("No QA window config")?;
                // Work around tauri-utils 2.9.3 array-token generation for
                // dataStoreIdentifier; this QA-only builder accepts [u8;16].
                tauri::WebviewWindowBuilder::from_config(app, config)?
                    .incognito(false)
                    .data_store_identifier(*identifier.as_bytes())
                    .build()?;
            }
            // macOS Overlay initially reports content height +1 CSS px.
            // Normalize only a fresh window within 1px of configured bounds;
            // never replace restored/user-sized/maximized or display-clamped bounds.
            #[cfg(target_os = "macos")]
            if !app
                .path()
                .app_config_dir()?
                .join(&window_state_file)
                .exists()
            {
                if let (Some(window), Some(config)) = (
                    app.get_webview_window("main"),
                    app.config().app.windows.iter().find(|w| w.label == "main"),
                ) {
                    let size = window
                        .inner_size()?
                        .to_logical::<f64>(window.scale_factor()?);
                    if !window.is_maximized()?
                        && (size.width - config.width).abs() <= 1.0
                        && (size.height - config.height).abs() <= 1.0
                        && (size.width != config.width || size.height != config.height)
                    {
                        window.set_size(tauri::LogicalSize::new(config.width, config.height))?;
                    }
                }
            }
            #[cfg(target_os = "macos")]
            {
                macos_window_state::install(
                    app.handle(),
                    app.path().app_config_dir()?.join(&window_state_file),
                )?;
                macos_input::install(app.handle())?;
            }
            // Restore saved state first. On a fresh profile, maximize only
            // after normal bounds have been captured so Unmaximize can restore
            // them. Never force fullscreen or override an existing preference.
            // Native QA keeps its explicit window geometry for archived checks.
            #[cfg(not(all(feature = "native-smoke", target_os = "macos")))]
            if !app
                .path()
                .app_config_dir()?
                .join(&window_state_file)
                .try_exists()?
            {
                app.get_webview_window("main")
                    .ok_or("No main window")?
                    .maximize()?;
            }
            #[cfg(all(feature = "native-smoke", target_os = "macos"))]
            native_smoke::start(app.handle().clone())
                .map_err(|error| -> Box<dyn std::error::Error> { error })?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            let action = event.id().as_ref();
            #[cfg(target_os = "macos")]
            if action == "zoom-window" {
                macos_window_state::toggle_zoom(app);
                return;
            }
            if action == "request-quit" {
                lifecycle::request_quit(app);
                return;
            }
            if matches!(
                action,
                "about"
                    | "toggle-sidebar"
                    | "toggle-layout"
                    | "reset-layout"
                    | "save-request"
                    | "send-request"
                    | "close-request"
                    | "next-request"
                    | "previous-request"
            ) {
                if let Err(error) = app.emit_to("main", "shell-action", action) {
                    eprintln!("Could not deliver shell menu action: {error}");
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::bootstrap_app,
            commands::load_workspace,
            commands::list_workspaces,
            commands::create_workspace,
            commands::select_workspace,
            commands::set_default_workspace,
            commands::delete_workspace,
            commands::create_collection,
            commands::rename_collection,
            commands::delete_collection,
            commands::create_folder,
            commands::update_folder,
            commands::delete_folder,
            commands::create_request,
            commands::get_request,
            commands::save_request,
            commands::delete_request,
            commands::reorder_items,
            commands::save_environment,
            commands::delete_environment,
            commands::select_environment,
            commands::save_session,
            commands::pick_attachment,
            commands::pick_collection_import,
            commands::preview_collection_import,
            commands::commit_collection_import,
            commands::discard_collection_import,
            commands::prepare_collection_export,
            commands::pick_collection_export_directory,
            commands::commit_collection_export,
            commands::discard_collection_export,
            commands::prepare_execution,
            commands::execute_request,
            commands::cancel_request,
            commands::list_history,
            lifecycle::close_guard_ready,
            lifecycle::cancel_quit,
            lifecycle::finish_quit,
            lifecycle::start_titlebar_drag
        ])
        .build(context)
        .expect("failed to build PostMen")
        .run(lifecycle::on_event);
}
