mod format;
#[cfg(test)]
mod tests;

use crate::error::{AppError, AppResult};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

#[derive(Clone, Default)]
pub struct Exports(Arc<Mutex<Option<Staged>>>);
struct Staged {
    token: String,
    at: Instant,
    documents: Vec<format::Document>,
    directory: Option<PathBuf>,
    conflicts: Vec<(PathBuf, FileStamp)>,
}
#[derive(PartialEq, Eq, Clone)]
struct FileStamp {
    length: u64,
    modified: std::time::SystemTime,
    #[cfg(unix)]
    identity: (u64, u64),
}
fn file_stamp(path: &Path) -> AppResult<Option<FileStamp>> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => {
            return Err(AppError::invalid(
                "The destination cannot be inspected. Choose another folder.",
            ))
        }
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(AppError::invalid("An export destination is a folder, symbolic link or special file. Choose another name."));
    }
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt;
    Ok(Some(FileStamp {
        length: metadata.len(),
        modified: metadata.modified().map_err(|_| unavailable())?,
        #[cfg(unix)]
        identity: (metadata.dev(), metadata.ino()),
    }))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Prepare {
    pub collection_ids: Vec<String>,
    pub include_variables: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub token: String,
    pub files: Vec<PreviewFile>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewFile {
    pub id: String,
    pub name: String,
    pub file_name: String,
    pub request_count: usize,
    pub warnings: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileName {
    pub id: String,
    pub name: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Commit {
    pub token: String,
    pub files: Vec<FileName>,
    pub overwrite: bool,
}
#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Outcome {
    Conflict {
        files: Vec<String>,
    },
    Exported {
        written: Vec<String>,
        failed: Vec<Failed>,
    },
}
#[derive(Serialize)]
pub struct Failed {
    pub id: String,
    pub message: String,
}
fn unavailable() -> AppError {
    AppError::new(
        "EXPORT_UNAVAILABLE",
        "The collection export worker is unavailable. Please retry.",
    )
}
fn staged<'a>(slot: &'a mut Option<Staged>, token: &str) -> AppResult<&'a mut Staged> {
    if slot
        .as_ref()
        .is_some_and(|s| s.at.elapsed() > Duration::from_secs(15 * 60))
    {
        *slot = None;
    }
    slot.as_mut().filter(|s| s.token == token).ok_or_else(|| {
        AppError::new(
            "EXPORT_EXPIRED",
            "This export expired. Go Back and select the collections again.",
        )
    })
}
fn filename(name: &str) -> AppResult<String> {
    let name = name.trim();
    let stem = if name.to_ascii_lowercase().ends_with(".json") {
        &name[..name.len() - 5]
    } else {
        name
    };
    let reserved = stem.split('.').next().unwrap_or("").to_ascii_uppercase();
    if stem.is_empty()
        || stem.len() > 180
        || stem.starts_with('.')
        || stem.ends_with(['.', ' '])
        || stem
            .chars()
            .any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
        || ["CON", "PRN", "AUX", "NUL"].contains(&reserved.as_str())
        || (reserved.len() == 4
            && (reserved.starts_with("COM") || reserved.starts_with("LPT"))
            && matches!(reserved.as_bytes()[3], b'1'..=b'9'))
    {
        return Err(AppError::invalid("Enter a file name up to 180 bytes without path separators, control characters, reserved names or trailing dots/spaces."));
    }
    Ok(format!("{stem}.json"))
}
fn suggested_name(name: &str, used: &mut HashSet<String>) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let mut base: String = cleaned.trim_matches(['.', ' ']).chars().take(80).collect();
    while base.len() > 140 {
        base.pop();
    }
    if filename(&base).is_err() {
        base = "Collection".into();
    }
    for index in 0.. {
        let stem = if index == 0 {
            base.clone()
        } else {
            format!("{base}_{index}")
        };
        let file = filename(&stem).expect("sanitized file name");
        if used.insert(file.to_lowercase()) {
            return file.trim_end_matches(".json").into();
        }
    }
    unreachable!()
}
impl Exports {
    pub(crate) fn clear(&self) {
        *self.0.lock().unwrap_or_else(|error| error.into_inner()) = None;
    }
    pub fn prepare(&self, conn: &mut Connection, input: Prepare) -> AppResult<Preview> {
        let mut slot = self.0.lock().map_err(|_| unavailable())?;
        *slot = None;
        if input.collection_ids.is_empty()
            || input.collection_ids.len() > 50
            || input.collection_ids.iter().collect::<HashSet<_>>().len()
                != input.collection_ids.len()
        {
            return Err(AppError::invalid(
                "Select between 1 and 50 distinct collections.",
            ));
        }
        let tx = conn.transaction()?;
        let mut documents = Vec::new();
        let mut total = 0;
        for id in input.collection_ids {
            let document = format::collection(&tx, &id, input.include_variables)?;
            total += document.bytes.len();
            if total > 64 * 1024 * 1024 {
                return Err(AppError::invalid(
                    "Export is limited to 64 MiB per batch. Select fewer collections.",
                ));
            }
            documents.push(document);
        }
        tx.commit()?;
        let token = uuid::Uuid::new_v4().to_string();
        let mut used = HashSet::new();
        let files = documents
            .iter()
            .map(|doc| PreviewFile {
                id: doc.id.clone(),
                name: doc.name.clone(),
                file_name: suggested_name(&doc.name, &mut used),
                request_count: doc.request_count,
                warnings: doc.warnings.clone(),
            })
            .collect();
        *slot = Some(Staged {
            token: token.clone(),
            at: Instant::now(),
            documents,
            directory: None,
            conflicts: vec![],
        });
        Ok(Preview { token, files })
    }
    pub fn validate_token(&self, token: &str) -> AppResult<()> {
        let mut slot = self.0.lock().map_err(|_| unavailable())?;
        staged(&mut slot, token)?;
        Ok(())
    }
    // Called only with a path returned by the backend's native directory picker.
    pub fn set_directory(&self, token: &str, directory: &Path) -> AppResult<String> {
        let directory = directory
            .canonicalize()
            .map_err(|_| AppError::invalid("The selected folder is unavailable. Browse again."))?;
        if !directory.is_dir() {
            return Err(AppError::invalid("Choose a local folder."));
        }
        let display = directory.to_string_lossy().into_owned();
        let mut slot = self.0.lock().map_err(|_| unavailable())?;
        let stage = staged(&mut slot, token)?;
        stage.directory = Some(directory);
        stage.conflicts.clear();
        Ok(display)
    }
    pub fn discard(&self, token: &str) -> AppResult<()> {
        let mut slot = self.0.lock().map_err(|_| unavailable())?;
        if slot.as_ref().is_some_and(|s| s.token == token) {
            *slot = None;
        }
        Ok(())
    }
    pub fn commit(&self, input: Commit) -> AppResult<Outcome> {
        let mut slot = self.0.lock().map_err(|_| unavailable())?;
        let stage = staged(&mut slot, &input.token)?;
        let directory = stage
            .directory
            .as_ref()
            .ok_or_else(|| AppError::invalid("Choose an export folder using Browse."))?;
        if input.files.len() != stage.documents.len() {
            return Err(AppError::invalid(
                "Export selection changed. Go Back and choose collections again.",
            ));
        }
        let mut names = HashSet::new();
        let mut ids = HashSet::new();
        let mut targets = Vec::new();
        let mut conflicts = Vec::new();
        for file in &input.files {
            if !ids.insert(&file.id) || !stage.documents.iter().any(|d| d.id == file.id) {
                return Err(AppError::invalid("Invalid export collection selection."));
            }
            let name = filename(&file.name)?;
            if !names.insert(name.to_lowercase()) {
                return Err(AppError::invalid(
                    "Each exported file must have a unique name.",
                ));
            }
            let path = directory.join(&name);
            if let Some(stamp) = file_stamp(&path)? {
                conflicts.push((path.clone(), stamp));
            }
            targets.push((file.id.clone(), path));
        }
        if !conflicts.is_empty() && (!input.overwrite || conflicts != stage.conflicts) {
            stage.conflicts = conflicts;
            return Ok(Outcome::Conflict {
                files: stage
                    .conflicts
                    .iter()
                    .map(|(path, _)| {
                        path.file_name()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .into_owned()
                    })
                    .collect(),
            });
        }
        let mut written = Vec::new();
        let mut failed = Vec::new();
        for (id, path) in targets {
            let doc = stage
                .documents
                .iter()
                .find(|d| d.id == id)
                .ok_or_else(unavailable)?;
            let approved = conflicts
                .iter()
                .find(|(target, _)| target == &path)
                .map(|(_, stamp)| stamp);
            match write_file(directory, &path, &doc.bytes, approved) {
                Ok(()) => written.push(id),
                Err(message) => failed.push(Failed { id, message }),
            }
        }
        stage.conflicts.clear();
        stage.documents.retain(|d| !written.contains(&d.id));
        if stage.documents.is_empty() {
            *slot = None;
        }
        Ok(Outcome::Exported { written, failed })
    }
}
fn write_file(
    directory: &Path,
    path: &Path,
    bytes: &[u8],
    approved: Option<&FileStamp>,
) -> Result<(), String> {
    let mut temporary = tempfile::Builder::new()
        .prefix(".postmen-export-")
        .tempfile_in(directory)
        .map_err(|_| {
            "Cannot create the export file. Check folder permissions and free disk space."
                .to_string()
        })?;
    temporary
        .write_all(bytes)
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|_| {
            "Could not finish writing the export. Check free disk space and retry.".to_string()
        })?;
    let persisted = if let Some(approved) = approved {
        if file_stamp(path).map_err(|error| error.message)?.as_ref() != Some(approved) {
            return Err(
                "The destination changed after confirmation. Retry to review it again.".into(),
            );
        }
        temporary.persist(path)
    } else {
        temporary.persist_noclobber(path)
    };
    persisted.map_err(|error| {
        if error.error.kind() == std::io::ErrorKind::AlreadyExists {
            "A file with this name appeared during export. Choose another name; it was not overwritten.".to_string()
        } else { "Could not save the export file. Choose another folder and retry.".to_string() }
    })?;
    Ok(())
}
