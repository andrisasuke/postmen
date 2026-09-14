pub mod environments;
pub mod repository;
#[cfg(test)]
mod tests;
pub(crate) mod validation;

use crate::error::{AppError, AppResult};
use rusqlite::Connection;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

const APPLICATION_ID: i64 = 0x504d454e;

#[derive(Clone)]
struct Target {
    path: PathBuf,
    connection: Arc<Mutex<Option<Connection>>>,
}
pub struct Database {
    target: Mutex<Target>,
}
// Each command captures its database before spawning a worker. A workspace
// switch replaces only the managed root handle, never an in-flight command's DB.
impl Clone for Database {
    fn clone(&self) -> Self {
        Self {
            target: Mutex::new(
                self.target
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .clone(),
            ),
        }
    }
}
impl Database {
    pub fn new(path: PathBuf) -> Self {
        Self {
            target: Mutex::new(Target {
                path,
                connection: Arc::new(Mutex::new(None)),
            }),
        }
    }
    pub(crate) fn replace_after(
        &self,
        next: &Database,
        persist: impl FnOnce() -> AppResult<()>,
    ) -> AppResult<()> {
        let next = next
            .target
            .lock()
            .map_err(|_| AppError::database())?
            .clone();
        let mut target = self.target.lock().map_err(|_| AppError::database())?;
        persist()?;
        *target = next;
        Ok(())
    }
    // Called on spawn_blocking workers, never on the WebView/UI thread.
    pub fn run<T>(&self, operation: impl FnOnce(&mut Connection) -> AppResult<T>) -> AppResult<T> {
        let target = self
            .target
            .lock()
            .map_err(|_| AppError::database())?
            .clone();
        let mut state = target.connection.lock().map_err(|_| {
            AppError::new(
                "INTERNAL_ERROR",
                "Storage worker could not be acquired. Restart the application.",
            )
        })?;
        if state.is_none() {
            *state = Some(Self::connect(&target.path)?);
        }
        operation(state.as_mut().ok_or_else(AppError::database)?)
    }
    fn connect(path: &std::path::Path) -> AppResult<Connection> {
        let parent = path.parent().ok_or_else(AppError::database)?;
        std::fs::create_dir_all(parent).map_err(|_| AppError::database())?;
        let mut conn = Connection::open(path)?;
        conn.busy_timeout(Duration::from_secs(5))?;
        conn.pragma_update(None, "foreign_keys", true)?;
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let version: i64 = tx.pragma_query_value(None, "user_version", |r| r.get(0))?;
        let app_id: i64 = tx.pragma_query_value(None, "application_id", |r| r.get(0))?;
        if version == 0 && app_id == 0 {
            let tables: i64 = tx.query_row(
                "SELECT count(*) FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
                [],
                |r| r.get(0),
            )?;
            if tables != 0 {
                return Err(AppError::new("UNSUPPORTED_SCHEMA", "The new storage location contains an unrecognized database. No data was changed."));
            }
            tx.execute_batch(include_str!("schema.sql"))?;
            tx.execute_batch(include_str!("environments.sql"))?;
            tx.pragma_update(None, "application_id", APPLICATION_ID)?;
            tx.pragma_update(None, "user_version", 2)?;
        } else if version == 1 && app_id == APPLICATION_ID {
            // Retire Base URL only; retain collections, requests, rows and session.
            tx.execute_batch(
                "ALTER TABLE requests DROP COLUMN hostname_id; DROP TABLE hostnames;",
            )?;
            tx.execute_batch(include_str!("environments.sql"))?;
            tx.pragma_update(None, "user_version", 2)?;
        } else if version != 2 || app_id != APPLICATION_ID {
            return Err(AppError::new("UNSUPPORTED_SCHEMA", "This database was created by an incompatible application version. No migration was attempted."));
        }
        tx.commit()?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        Ok(conn)
    }
}
