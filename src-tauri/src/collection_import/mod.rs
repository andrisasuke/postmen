mod diagnostics;
mod parser;
mod raw_body;
#[cfg(test)]
mod tests;

use crate::{
    db::{environments, repository as repo},
    error::{AppError, AppResult},
    models::Workspace,
};
use rusqlite::{params, Connection, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::{
    fs::File,
    io::Read,
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

#[derive(Clone, Default)]
pub struct Imports(Arc<Mutex<Option<Staged>>>);
struct Staged {
    token: String,
    at: Instant,
    parsed: parser::Parsed,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    token: String,
    name: String,
    request_count: usize,
    folder_count: usize,
    variable_count: usize,
    warnings: Vec<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    id: String,
    name: String,
    request_count: i64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    Create,
    Copy,
    Overwrite,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Commit {
    pub token: String,
    pub mode: Mode,
    pub target_id: Option<String>,
}
#[derive(Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Outcome {
    Conflict {
        conflicts: Vec<Conflict>,
    },
    Imported {
        collection_id: String,
        replaced_id: Option<String>,
        workspace: Box<Workspace>,
    },
}
fn worker_error() -> AppError {
    AppError::new(
        "INTERNAL_ERROR",
        "The collection import worker is unavailable. Please retry.",
    )
}
impl Imports {
    pub(crate) fn clear(&self) {
        *self.0.lock().unwrap_or_else(|error| error.into_inner()) = None;
    }
    pub fn stage_file(&self, path: &Path) -> AppResult<Preview> {
        if !path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("json"))
        {
            return Err(AppError::invalid("Choose a .json collection file."));
        }
        if !std::fs::metadata(path).is_ok_and(|metadata| metadata.is_file()) {
            return Err(AppError::invalid("Choose a regular JSON file."));
        }
        let file = File::open(path).map_err(|_| {
            AppError::new(
                "FILE_UNAVAILABLE",
                "The selected file could not be read. Choose it again.",
            )
        })?;
        let metadata = file.metadata().map_err(|_| worker_error())?;
        if !metadata.is_file() || metadata.len() > parser::MAX_BYTES as u64 {
            return Err(AppError::invalid(
                "Choose a regular JSON file no larger than 10 MiB.",
            ));
        }
        let mut bytes = Vec::new();
        file.take(parser::MAX_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| {
                AppError::new(
                    "FILE_UNAVAILABLE",
                    "The selected collection could not be read.",
                )
            })?;
        self.stage(&bytes)
    }
    pub fn stage(&self, bytes: &[u8]) -> AppResult<Preview> {
        // One bounded preview per main window; parsing never writes to the database.
        let mut slot = self.0.lock().map_err(|_| worker_error())?;
        *slot = None;
        let parsed = parser::parse(bytes)?;
        let token = uuid::Uuid::new_v4().to_string();
        let preview = Preview {
            token: token.clone(),
            name: parsed.name.clone(),
            request_count: parsed.requests.len(),
            folder_count: parsed.folders.len(),
            variable_count: parsed.variables.len(),
            warnings: parsed.warnings.iter().cloned().collect(),
        };
        *slot = Some(Staged {
            token,
            at: Instant::now(),
            parsed,
        });
        Ok(preview)
    }
    pub fn discard(&self, token: &str) -> AppResult<()> {
        let mut slot = self.0.lock().map_err(|_| worker_error())?;
        if slot.as_ref().is_some_and(|stage| stage.token == token) {
            *slot = None;
        }
        Ok(())
    }
    pub fn commit(&self, conn: &mut Connection, input: Commit) -> AppResult<Outcome> {
        let mut slot = self.0.lock().map_err(|_| worker_error())?;
        if slot
            .as_ref()
            .is_some_and(|stage| stage.at.elapsed() > Duration::from_secs(15 * 60))
        {
            *slot = None;
        }
        let staged = slot
            .as_ref()
            .filter(|stage| stage.token == input.token)
            .ok_or_else(|| {
                AppError::new(
                    "IMPORT_EXPIRED",
                    "This import preview expired. Choose the file again.",
                )
            })?;
        let outcome = commit(conn, &staged.parsed, input)?;
        if matches!(outcome, Outcome::Imported { .. }) {
            *slot = None;
        }
        Ok(outcome)
    }
}
fn conflicts(conn: &Connection, name: &str) -> AppResult<Vec<Conflict>> {
    let mut stmt = conn.prepare("SELECT c.id,c.name,(SELECT count(*) FROM requests r WHERE r.collection_id=c.id) FROM collections c WHERE c.name=?1 ORDER BY c.position,c.id")?;
    let result = stmt
        .query_map([name], |row| {
            Ok(Conflict {
                id: row.get(0)?,
                name: row.get(1)?,
                request_count: row.get(2)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(result)
}
fn copy_name(conn: &Connection, base: &str) -> AppResult<String> {
    let mut stmt = conn.prepare("SELECT name FROM collections")?;
    let names = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<std::collections::HashSet<_>, _>>()?;
    for index in 1..=names.len() + 1 {
        let suffix = format!("_{index}");
        let candidate = format!(
            "{}{suffix}",
            base.chars().take(200 - suffix.len()).collect::<String>()
        );
        if !names.contains(&candidate) {
            return Ok(candidate);
        }
    }
    Err(worker_error())
}
fn commit(conn: &mut Connection, parsed: &parser::Parsed, input: Commit) -> AppResult<Outcome> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let collisions = conflicts(&tx, &parsed.name)?;
    if matches!(input.mode, Mode::Create) && !collisions.is_empty() {
        return Ok(Outcome::Conflict {
            conflicts: collisions,
        });
    }
    let replaced_id = if matches!(input.mode, Mode::Overwrite) {
        let target = input
            .target_id
            .filter(|id| collisions.iter().any(|item| &item.id == id))
            .ok_or_else(|| {
                AppError::new(
                    "CONFLICT",
                    "The overwrite target no longer matches. Cancel and import the file again.",
                )
            })?;
        Some(target)
    } else {
        if input.target_id.is_some() {
            return Err(AppError::invalid(
                "Only overwrite accepts a target collection.",
            ));
        }
        None
    };
    let name = if matches!(input.mode, Mode::Copy) {
        copy_name(&tx, &parsed.name)?
    } else {
        parsed.name.clone()
    };
    let collection_id = replaced_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let timestamp = repo::now();
    if replaced_id.is_some() {
        // Preserve the target collection ID/position; replace only its scoped data.
        tx.execute(
            "DELETE FROM requests WHERE collection_id=?1",
            [&collection_id],
        )?;
        tx.execute(
            "DELETE FROM folders WHERE collection_id=?1",
            [&collection_id],
        )?;
        tx.execute(
            "DELETE FROM environment_selections WHERE collection_id=?1",
            [&collection_id],
        )?;
        tx.execute(
            "DELETE FROM environments WHERE collection_id=?1",
            [&collection_id],
        )?;
        tx.execute(
            "UPDATE collections SET updated_at=?1 WHERE id=?2",
            params![timestamp, collection_id],
        )?;
    } else {
        let position: i64 = tx.query_row(
            "SELECT coalesce(max(position),-1)+1 FROM collections",
            [],
            |row| row.get(0),
        )?;
        tx.execute(
            "INSERT INTO collections VALUES (?1,?2,?3,?4,?4)",
            params![collection_id, name, position, timestamp],
        )?;
    }
    for folder in &parsed.folders {
        tx.execute("INSERT INTO folders (id,collection_id,parent_id,name,position) VALUES (?1,?2,?3,?4,?5)",
            params![folder.id, collection_id, folder.parent_id, folder.name, folder.position])?;
    }
    for request in &parsed.requests {
        tx.execute("INSERT INTO requests (id,collection_id,folder_id,name,method,url,body_kind,body,position,revision,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,1,?10,?10)",
            params![request.id, collection_id, request.folder_id, request.name, request.method, request.url, request.body_kind, request.body, request.position, timestamp])?;
        repo::write_request_rows(&tx, request)?;
    }
    if !parsed.variables.is_empty() {
        let count: i64 = tx.query_row("SELECT count(*) FROM environments", [], |row| row.get(0))?;
        if count >= 1000 {
            return Err(AppError::invalid(
                "At most 1000 environments can be saved. No collection changes were applied.",
            ));
        }
        let environment_id = uuid::Uuid::new_v4().to_string();
        tx.execute(
            "INSERT INTO environments VALUES (?1,?2,'Imported',?3,1)",
            params![
                environment_id,
                collection_id,
                environments::validate_variables(&parsed.variables)?
            ],
        )?;
        tx.execute(
            "INSERT INTO environment_selections VALUES (?1,?1,?2)",
            params![collection_id, environment_id],
        )?;
    }
    let workspace = repo::workspace_snapshot(&tx)?;
    // Persist pruning in the same transaction; a restart cannot restore deleted tabs.
    let session = serde_json::to_string(&workspace.session).map_err(|_| worker_error())?;
    tx.execute("INSERT INTO app_settings VALUES ('session.v1',?1) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json", [session])?;
    tx.commit()?;
    Ok(Outcome::Imported {
        collection_id,
        replaced_id,
        workspace: Box::new(workspace),
    })
}
