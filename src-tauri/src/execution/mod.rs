pub mod http;
pub mod models;
#[cfg(test)]
mod tests;
use crate::{
    db::{repository as repo, validation, Database},
    error::{AppError, AppResult},
};
use models::{ExecutionResult, PrepareExecution};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

struct Entry {
    input: Option<PrepareExecution>,
    token: CancellationToken,
    created: Instant,
}
#[derive(Clone)]
pub struct Executions {
    entries: Arc<Mutex<HashMap<String, Entry>>>,
    client: reqwest::Client,
}
// Also runs if the future is dropped or unwinds before a result is returned.
struct Registration {
    entries: Arc<Mutex<HashMap<String, Entry>>>,
    id: String,
}
impl Drop for Registration {
    fn drop(&mut self) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.remove(&self.id);
        }
    }
}
impl Executions {
    pub fn new() -> AppResult<Self> {
        Ok(Self {
            entries: Default::default(),
            client: http::client()?,
        })
    }
    pub fn prepare(&self, input: PrepareExecution) -> AppResult<()> {
        validation::id(&input.execution_id)?;
        validation::request(&input.request)?;
        if !(100..=120000).contains(&input.timeout_ms) {
            return Err(AppError::invalid(
                "Timeout must be between 100 ms and 120 seconds.",
            ));
        }
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| AppError::new("INTERNAL_ERROR", "Execution registry unavailable."))?;
        entries.retain(|_, entry| {
            entry.input.is_none() || entry.created.elapsed() < Duration::from_secs(120)
        });
        if entries.contains_key(&input.execution_id) {
            return Err(AppError::new(
                "CONFLICT",
                "This execution ID is already registered.",
            ));
        }
        if entries.len() >= 32 {
            return Err(AppError::new(
                "BUSY",
                "At most 32 executions can be active. Cancel or wait for another request.",
            ));
        }
        entries.insert(
            input.execution_id.clone(),
            Entry {
                input: Some(input),
                token: CancellationToken::new(),
                created: Instant::now(),
            },
        );
        Ok(())
    }
    pub fn cancel(&self, id: &str) -> AppResult<()> {
        validation::id(id)?;
        if let Some(entry) = self
            .entries
            .lock()
            .map_err(|_| AppError::new("INTERNAL_ERROR", "Execution registry unavailable."))?
            .get(id)
        {
            entry.token.cancel();
        }
        Ok(()) // idempotent after completion, without unbounded tombstones
    }
    pub fn cancel_all(&self) {
        if let Ok(entries) = self.entries.lock() {
            for entry in entries.values() {
                entry.token.cancel();
            }
        }
    }
    pub fn active_count(&self) -> usize {
        self.entries.lock().map_or(usize::MAX, |entries| {
            entries
                .values()
                .filter(|entry| entry.input.is_none() || !entry.token.is_cancelled())
                .count()
        })
    }
    pub async fn execute(&self, id: String, db: Database) -> AppResult<ExecutionResult> {
        let (input, token) = {
            let mut entries = self
                .entries
                .lock()
                .map_err(|_| AppError::new("INTERNAL_ERROR", "Execution registry unavailable."))?;
            let entry = entries.get_mut(&id).ok_or_else(|| {
                AppError::new(
                    "NOT_FOUND",
                    "Execution was not prepared or its reservation expired.",
                )
            })?;
            (
                entry
                    .input
                    .take()
                    .ok_or_else(|| AppError::new("CONFLICT", "Execution already started."))?,
                entry.token.clone(),
            )
        };
        let _registration = Registration {
            entries: self.entries.clone(),
            id: id.clone(),
        };
        let started = Instant::now();
        let request_id = input.request.id.clone();
        let method = input.request.method.clone();
        let result = tokio::select! {biased;
            _=token.cancelled()=>Err(AppError::new("CANCELLED","Client request cancelled. The server may already have processed it.")),
            value=tokio::time::timeout(Duration::from_millis(input.timeout_ms),http::send(self.client.clone(),db.clone(),&id,input.request))=> match value {Ok(result)=>result,Err(_)=>Err(AppError::new("TIMEOUT","The request exceeded its total timeout."))}
        };
        let mut result = result
            .unwrap_or_else(|e| ExecutionResult::failure(&id, &request_id, e.code, &e.message));
        result.duration_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
        let history = result.clone();
        if !matches!(
            tokio::task::spawn_blocking(
                move || db.run(|c| repo::record_execution(c, &history, &method))
            )
            .await,
            Ok(Ok(()))
        ) {
            result.history_warning =
                Some("The response is available, but execution history could not be saved.".into());
        }
        Ok(result)
    }
}
