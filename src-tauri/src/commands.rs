use crate::{
    collection_import::{Commit, Imports, Mode, Outcome, Preview},
    db::{repository as repo, Database},
    error::{AppError, AppResult},
    execution::{
        models::{ExecutionResult, HistoryItem, HistoryQuery, PrepareExecution},
        Executions,
    },
    models::*,
};
use serde::Serialize;
use tauri::{Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

fn main_only(window: &WebviewWindow) -> AppResult<()> {
    if window.label() != "main" {
        return Err(AppError::new(
            "FORBIDDEN",
            "This operation is only available in the main window.",
        ));
    }
    Ok(())
}
async fn work<T: Send + 'static>(
    window: WebviewWindow,
    db: Database,
    f: impl FnOnce(&mut rusqlite::Connection) -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    main_only(&window)?;
    tauri::async_runtime::spawn_blocking(move || db.run(f))
        .await
        .map_err(|_| {
            AppError::new(
                "INTERNAL_ERROR",
                "Storage worker stopped unexpectedly. Your unsaved draft has not been discarded.",
            )
        })?
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapInfo {
    schema_version: u8,
    name: &'static str,
    version: &'static str,
    platform: &'static str,
    milestone: &'static str,
    database_ready: bool,
    http_ready: bool,
}
#[tauri::command]
pub async fn bootstrap_app(
    window: WebviewWindow,
    db: State<'_, Database>,
) -> AppResult<BootstrapInfo> {
    list_workspaces(window.clone()).await?;
    work(window, db.inner().clone(), |_| Ok(())).await?;
    Ok(BootstrapInfo {
        schema_version: 5,
        name: "PostMen",
        version: env!("CARGO_PKG_VERSION"),
        platform: std::env::consts::OS,
        milestone: "M4",
        database_ready: true,
        http_ready: true,
    })
}
#[tauri::command]
pub async fn list_workspaces(window: WebviewWindow) -> AppResult<crate::workspaces::Catalog> {
    main_only(&window)?;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<crate::workspaces::Registry>()
            .initialize(&app.state::<Database>())
    })
    .await
    .map_err(|_| AppError::database())?
}
async fn activate_workspace(
    window: WebviewWindow,
    id: Option<String>,
    name: Option<String>,
) -> AppResult<crate::workspaces::Activation> {
    main_only(&window)?;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if app.state::<Executions>().active_count() != 0 {
            return Err(AppError::new(
                "BUSY",
                "Wait for running requests to finish before changing workspaces.",
            ));
        }
        let result = app.state::<crate::workspaces::Registry>().activate(
            &app.state::<Database>(),
            id,
            name,
        )?;
        // Preview tokens must not be reused against another workspace.
        app.state::<Imports>().clear();
        app.state::<crate::collection_export::Exports>().clear();
        Ok(result)
    })
    .await
    .map_err(|_| AppError::database())?
}
#[tauri::command]
pub async fn create_workspace(
    window: WebviewWindow,
    name: String,
) -> AppResult<crate::workspaces::Activation> {
    activate_workspace(window, None, Some(name)).await
}
#[tauri::command]
pub async fn select_workspace(
    window: WebviewWindow,
    id: String,
) -> AppResult<crate::workspaces::Activation> {
    activate_workspace(window, Some(id), None).await
}
#[tauri::command]
pub async fn load_workspace(
    window: WebviewWindow,
    db: State<'_, Database>,
) -> AppResult<Workspace> {
    work(window, db.inner().clone(), repo::workspace).await
}
#[tauri::command]
pub async fn set_default_workspace(
    window: WebviewWindow,
    id: String,
) -> AppResult<crate::workspaces::Catalog> {
    main_only(&window)?;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<crate::workspaces::Registry>().set_default(&id)
    })
    .await
    .map_err(|_| AppError::database())?
}
#[tauri::command]
pub async fn delete_workspace(
    window: WebviewWindow,
    id: String,
) -> AppResult<crate::workspaces::Removal> {
    main_only(&window)?;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if app.state::<Executions>().active_count() != 0 {
            return Err(AppError::new(
                "BUSY",
                "Wait for running requests to finish before deleting a workspace.",
            ));
        }
        let result = app
            .state::<crate::workspaces::Registry>()
            .remove(&app.state::<Database>(), &id)?;
        if result.activation.is_some() {
            app.state::<Imports>().clear();
            app.state::<crate::collection_export::Exports>().clear();
        }
        Ok(result)
    })
    .await
    .map_err(|_| AppError::database())?
}
#[tauri::command]
pub async fn create_collection(
    window: WebviewWindow,
    db: State<'_, Database>,
    input: CreateCollection,
) -> AppResult<Collection> {
    work(window, db.inner().clone(), move |c| {
        repo::create_collection(c, input)
    })
    .await
}
#[tauri::command]
pub async fn rename_collection(
    window: WebviewWindow,
    db: State<'_, Database>,
    input: Rename,
) -> AppResult<Collection> {
    work(window, db.inner().clone(), move |c| {
        repo::rename_collection(c, input)
    })
    .await
}
#[tauri::command]
pub async fn create_folder(
    window: WebviewWindow,
    db: State<'_, Database>,
    input: CreateFolder,
) -> AppResult<Folder> {
    work(window, db.inner().clone(), move |c| {
        repo::create_folder(c, input)
    })
    .await
}
#[tauri::command]
pub async fn update_folder(
    window: WebviewWindow,
    db: State<'_, Database>,
    input: UpdateFolder,
) -> AppResult<Folder> {
    work(window, db.inner().clone(), move |c| {
        repo::update_folder(c, input)
    })
    .await
}
#[tauri::command]
pub async fn create_request(
    window: WebviewWindow,
    db: State<'_, Database>,
    input: CreateRequest,
) -> AppResult<RequestDoc> {
    work(window, db.inner().clone(), move |c| {
        repo::create_request(c, input)
    })
    .await
}
#[tauri::command]
pub async fn get_request(
    window: WebviewWindow,
    db: State<'_, Database>,
    id: String,
) -> AppResult<RequestDoc> {
    work(window, db.inner().clone(), move |c| {
        repo::get_request(c, &id)
    })
    .await
}
#[tauri::command]
pub async fn save_request(
    window: WebviewWindow,
    db: State<'_, Database>,
    input: RequestDoc,
) -> AppResult<RequestDoc> {
    work(window, db.inner().clone(), move |c| {
        repo::save_request(c, input)
    })
    .await
}
#[tauri::command]
pub async fn reorder_items(
    window: WebviewWindow,
    db: State<'_, Database>,
    input: Reorder,
) -> AppResult<()> {
    work(window, db.inner().clone(), move |c| repo::reorder(c, input)).await
}
#[tauri::command]
pub async fn save_environment(
    window: WebviewWindow,
    db: State<'_, Database>,
    input: SaveEnvironment,
) -> AppResult<Environment> {
    work(window, db.inner().clone(), move |c| {
        crate::db::environments::save(c, input)
    })
    .await
}
#[tauri::command]
pub async fn save_session(
    window: WebviewWindow,
    db: State<'_, Database>,
    input: Session,
) -> AppResult<Session> {
    work(window, db.inner().clone(), move |c| {
        repo::save_session(c, input)
    })
    .await
}
#[tauri::command]
pub async fn delete_collection(
    window: WebviewWindow,
    db: State<'_, Database>,
    id: String,
) -> AppResult<()> {
    work(window, db.inner().clone(), move |c| {
        repo::delete_item(c, "collection", &id)
    })
    .await
}
#[tauri::command]
pub async fn delete_folder(
    window: WebviewWindow,
    db: State<'_, Database>,
    id: String,
) -> AppResult<()> {
    work(window, db.inner().clone(), move |c| {
        repo::delete_item(c, "folder", &id)
    })
    .await
}
#[tauri::command]
pub async fn delete_request(
    window: WebviewWindow,
    db: State<'_, Database>,
    id: String,
) -> AppResult<()> {
    work(window, db.inner().clone(), move |c| {
        repo::delete_item(c, "request", &id)
    })
    .await
}
#[tauri::command]
pub async fn delete_environment(
    window: WebviewWindow,
    db: State<'_, Database>,
    id: String,
) -> AppResult<()> {
    work(window, db.inner().clone(), move |c| {
        crate::db::environments::delete(c, &id)
    })
    .await
}
#[tauri::command]
pub async fn pick_attachment(
    window: WebviewWindow,
    db: State<'_, Database>,
    app: tauri::AppHandle,
) -> AppResult<Option<Attachment>> {
    main_only(&window)?;
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let selected = app
            .dialog()
            .file()
            .set_title("Choose a multipart file")
            .set_parent(&window)
            .blocking_pick_file();
        if let Some(file) = selected {
            let path = file
                .into_path()
                .map_err(|_| AppError::invalid("Choose a local file."))?;
            db.run(|c| repo::register_attachment(c, &path)).map(Some)
        } else {
            Ok(None)
        }
    })
    .await
    .map_err(|_| {
        AppError::new(
            "FILE_UNAVAILABLE",
            "The native file picker could not be opened.",
        )
    })?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bootstrap_contract_has_explicit_readiness() {
        let value = serde_json::to_value(BootstrapInfo {
            schema_version: 5,
            name: "PostMen",
            version: "0.2.0",
            platform: "macos",
            milestone: "M4",
            database_ready: true,
            http_ready: true,
        })
        .unwrap();
        assert_eq!(value["schemaVersion"], 5);
        assert_eq!(value["databaseReady"], true);
        assert_eq!(value["httpReady"], true);
        assert!(value.get("schema_version").is_none());
    }
}

#[tauri::command]
pub async fn prepare_execution(
    window: WebviewWindow,
    db: State<'_, Database>,
    executions: State<'_, Executions>,
    mut input: PrepareExecution,
) -> AppResult<()> {
    main_only(&window)?;
    input.request = work(window, db.inner().clone(), move |conn| {
        crate::db::environments::resolve_request(conn, input.request)
    })
    .await?;
    executions.prepare(input)
}
#[tauri::command]
pub async fn select_environment(
    window: WebviewWindow,
    db: State<'_, Database>,
    input: EnvironmentSelection,
) -> AppResult<EnvironmentSelection> {
    work(window, db.inner().clone(), move |conn| {
        crate::db::environments::select(conn, input)
    })
    .await
}
#[tauri::command]
pub async fn execute_request(
    window: WebviewWindow,
    db: State<'_, Database>,
    executions: State<'_, Executions>,
    execution_id: String,
) -> AppResult<ExecutionResult> {
    main_only(&window)?;
    executions.execute(execution_id, db.inner().clone()).await
}
#[tauri::command]
pub fn cancel_request(
    window: WebviewWindow,
    executions: State<'_, Executions>,
    execution_id: String,
) -> AppResult<()> {
    main_only(&window)?;
    executions.cancel(&execution_id)
}
#[tauri::command]
pub async fn list_history(
    window: WebviewWindow,
    db: State<'_, Database>,
    input: HistoryQuery,
) -> AppResult<Vec<HistoryItem>> {
    work(window, db.inner().clone(), move |c| {
        crate::db::repository::list_history(c, input)
    })
    .await
}

#[tauri::command]
pub async fn pick_collection_import(
    window: WebviewWindow,
    app: tauri::AppHandle,
    imports: State<'_, Imports>,
) -> AppResult<Option<Preview>> {
    main_only(&window)?;
    let imports = imports.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let selected = app
            .dialog()
            .file()
            .set_title("Import Postman collection")
            .add_filter("Postman collection JSON", &["json"])
            .set_parent(&window)
            .blocking_pick_file();
        selected
            .map(|file| {
                let path = file
                    .into_path()
                    .map_err(|_| AppError::invalid("Choose a local JSON file."))?;
                imports.stage_file(&path)
            })
            .transpose()
    })
    .await
    .map_err(|_| {
        AppError::new(
            "FILE_UNAVAILABLE",
            "The collection file picker could not be opened.",
        )
    })?
}
#[tauri::command]
pub async fn preview_collection_import(
    window: WebviewWindow,
    imports: State<'_, Imports>,
    content: String,
) -> AppResult<Preview> {
    main_only(&window)?;
    let imports = imports.inner().clone();
    tauri::async_runtime::spawn_blocking(move || imports.stage(content.as_bytes()))
        .await
        .map_err(|_| AppError::new("INVALID_INPUT", "The collection could not be validated."))?
}
#[tauri::command]
pub async fn commit_collection_import(
    window: WebviewWindow,
    db: State<'_, Database>,
    imports: State<'_, Imports>,
    executions: State<'_, Executions>,
    input: Commit,
) -> AppResult<Outcome> {
    main_only(&window)?;
    if matches!(input.mode, Mode::Overwrite) && executions.active_count() != 0 {
        return Err(AppError::new(
            "BUSY",
            "Wait for running requests to finish before overwriting a collection.",
        ));
    }
    let imports = imports.inner().clone();
    work(window, db.inner().clone(), move |conn| {
        imports.commit(conn, input)
    })
    .await
}
#[tauri::command]
pub fn discard_collection_import(
    window: WebviewWindow,
    imports: State<'_, Imports>,
    token: String,
) -> AppResult<()> {
    main_only(&window)?;
    imports.discard(&token)
}

#[tauri::command]
pub async fn prepare_collection_export(
    window: WebviewWindow,
    db: State<'_, Database>,
    exports: State<'_, crate::collection_export::Exports>,
    input: crate::collection_export::Prepare,
) -> AppResult<crate::collection_export::Preview> {
    let exports = exports.inner().clone();
    work(window, db.inner().clone(), move |conn| {
        exports.prepare(conn, input)
    })
    .await
}

#[tauri::command]
pub async fn pick_collection_export_directory(
    window: WebviewWindow,
    app: tauri::AppHandle,
    exports: State<'_, crate::collection_export::Exports>,
    token: String,
) -> AppResult<Option<String>> {
    main_only(&window)?;
    let exports = exports.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        exports.validate_token(&token)?;
        let selected = app
            .dialog()
            .file()
            .set_title("Choose export location")
            .set_parent(&window)
            .blocking_pick_folder();
        selected
            .map(|folder| {
                let path = folder
                    .into_path()
                    .map_err(|_| AppError::invalid("Choose a local folder."))?;
                exports.set_directory(&token, &path)
            })
            .transpose()
    })
    .await
    .map_err(|_| {
        AppError::new(
            "EXPORT_UNAVAILABLE",
            "The export folder picker could not be opened.",
        )
    })?
}

#[tauri::command]
pub async fn commit_collection_export(
    window: WebviewWindow,
    exports: State<'_, crate::collection_export::Exports>,
    input: crate::collection_export::Commit,
) -> AppResult<crate::collection_export::Outcome> {
    main_only(&window)?;
    let exports = exports.inner().clone();
    tauri::async_runtime::spawn_blocking(move || exports.commit(input))
        .await
        .map_err(|_| {
            AppError::new(
                "EXPORT_UNAVAILABLE",
                "The export worker stopped. Check the destination folder before retrying.",
            )
        })?
}

#[tauri::command]
pub fn discard_collection_export(
    window: WebviewWindow,
    exports: State<'_, crate::collection_export::Exports>,
    token: String,
) -> AppResult<()> {
    main_only(&window)?;
    exports.discard(&token)
}
