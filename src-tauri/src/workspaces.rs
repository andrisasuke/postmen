//! A bounded catalog routes commands to separate SQLite files. The initial
//! workspace keeps the existing database in place; no data is copied or deleted.
use crate::{
    db::{repository as repo, validation, Database},
    error::{AppError, AppResult},
    models::{RequestDoc, Workspace},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    io::{Read, Write},
    path::PathBuf,
    sync::Mutex,
};

const DEFAULT_ID: &str = "00000000-0000-4000-8000-000000000001";
const MAX_WORKSPACES: usize = 100;
const MAX_REMOVED_WORKSPACES: usize = 1000;
const MAX_CATALOG_BYTES: u64 = 2 * 1024 * 1024;
fn initial_default_id() -> String {
    DEFAULT_ID.into()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Entry {
    pub id: String,
    pub name: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Catalog {
    version: u8,
    pub active_id: String,
    #[serde(default = "initial_default_id")]
    pub default_id: String,
    pub workspaces: Vec<Entry>,
    // Retain removed IDs/names and their untouched DBs for manual recovery.
    #[serde(default)]
    removed_workspaces: Vec<Entry>,
}
impl Default for Catalog {
    fn default() -> Self {
        Self {
            version: 1,
            active_id: DEFAULT_ID.into(),
            default_id: DEFAULT_ID.into(),
            removed_workspaces: Vec::new(),
            workspaces: vec![Entry {
                id: DEFAULT_ID.into(),
                name: "My Workspace".into(),
            }],
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Activation {
    pub catalog: Catalog,
    pub workspace: Workspace,
    pub documents: Vec<RequestDoc>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Removal {
    pub catalog: Catalog,
    pub activation: Option<Activation>,
}
pub struct Registry {
    root: PathBuf,
    catalog: Mutex<Option<Catalog>>,
}
fn unavailable() -> AppError {
    AppError::new("WORKSPACE_STORAGE_ERROR", "Workspace settings could not be read or saved. No active workspace was changed. Check storage permissions and retry.")
}
fn validate(catalog: &Catalog) -> AppResult<()> {
    let mut ids = HashSet::new();
    let mut names = HashSet::new();
    if catalog.version != 1
        || catalog.workspaces.is_empty()
        || catalog.workspaces.len() > MAX_WORKSPACES
        || catalog.removed_workspaces.len() > MAX_REMOVED_WORKSPACES
    {
        return Err(unavailable());
    }
    for entry in &catalog.workspaces {
        let uuid = uuid::Uuid::parse_str(&entry.id).map_err(|_| unavailable())?;
        if uuid.to_string() != entry.id
            || !ids.insert(&entry.id)
            || validation::name(&entry.name)? != entry.name
            || !names.insert(entry.name.to_lowercase())
        {
            return Err(unavailable());
        }
    }
    if !ids.contains(&catalog.active_id) || !ids.contains(&catalog.default_id) {
        return Err(unavailable());
    }
    for entry in &catalog.removed_workspaces {
        let uuid = uuid::Uuid::parse_str(&entry.id).map_err(|_| unavailable())?;
        if uuid.to_string() != entry.id
            || !ids.insert(&entry.id)
            || validation::name(&entry.name)? != entry.name
        {
            return Err(unavailable());
        }
    }
    Ok(())
}
impl Registry {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            catalog: Mutex::new(None),
        }
    }
    fn path(&self, id: &str) -> PathBuf {
        if id == DEFAULT_ID {
            self.root.join("postmen.sqlite3")
        } else {
            self.root
                .join("workspaces")
                .join(id)
                .join("postmen.sqlite3")
        }
    }
    fn read(&self) -> AppResult<Catalog> {
        let file = match std::fs::File::open(self.root.join("workspaces.v1.json")) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Catalog::default()),
            Err(_) => return Err(unavailable()),
        };
        let mut bytes = Vec::new();
        file.take(MAX_CATALOG_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| unavailable())?;
        if bytes.len() > MAX_CATALOG_BYTES as usize {
            return Err(unavailable());
        }
        let catalog = serde_json::from_slice(&bytes).map_err(|_| unavailable())?;
        validate(&catalog)?;
        Ok(catalog)
    }
    fn persist(&self, catalog: &Catalog) -> AppResult<()> {
        validate(catalog)?;
        std::fs::create_dir_all(&self.root).map_err(|_| unavailable())?;
        let mut file = tempfile::NamedTempFile::new_in(&self.root).map_err(|_| unavailable())?;
        let bytes = serde_json::to_vec_pretty(catalog).map_err(|_| unavailable())?;
        if bytes.len() > MAX_CATALOG_BYTES as usize {
            return Err(unavailable());
        }
        file.write_all(&bytes).map_err(|_| unavailable())?;
        file.as_file().sync_all().map_err(|_| unavailable())?;
        file.persist(self.root.join("workspaces.v1.json"))
            .map_err(|_| unavailable())?;
        Ok(())
    }
    pub fn initialize(&self, db: &Database) -> AppResult<Catalog> {
        let mut slot = self.catalog.lock().map_err(|_| unavailable())?;
        if let Some(catalog) = slot.as_ref() {
            return Ok(catalog.clone());
        }
        let mut catalog = self.read()?;
        // Startup always opens the user's default; changing it does not switch
        // the running session. Old catalogs default to the original workspace.
        catalog.active_id = catalog.default_id.clone();
        if self
            .root
            .join("workspaces.v1.json")
            .try_exists()
            .map_err(|_| unavailable())?
            && !self.path(&catalog.active_id).is_file()
        {
            return Err(AppError::new("WORKSPACE_STORAGE_ERROR", "The active workspace database is missing. Restore its file before reopening; no empty replacement was created."));
        }
        let target = Database::new(self.path(&catalog.active_id));
        target.run(|_| Ok(()))?;
        db.replace_after(&target, || self.persist(&catalog))?;
        *slot = Some(catalog.clone());
        Ok(catalog)
    }
    pub fn activate(
        &self,
        db: &Database,
        id: Option<String>,
        name: Option<String>,
    ) -> AppResult<Activation> {
        let mut slot = self.catalog.lock().map_err(|_| unavailable())?;
        let current = slot.as_ref().ok_or_else(unavailable)?;
        let mut catalog = current.clone();
        let next_id = if let Some(name) = name {
            let name = validation::name(&name)?;
            if catalog.workspaces.len() >= MAX_WORKSPACES {
                return Err(AppError::invalid("At most 100 workspaces can be created."));
            }
            if catalog
                .workspaces
                .iter()
                .any(|entry| entry.name.to_lowercase() == name.to_lowercase())
            {
                return Err(AppError::invalid(
                    "A workspace with this name already exists. Choose another name.",
                ));
            }
            let id = uuid::Uuid::new_v4().to_string();
            catalog.workspaces.push(Entry {
                id: id.clone(),
                name,
            });
            id
        } else {
            let id = id.ok_or_else(AppError::missing)?;
            if !catalog.workspaces.iter().any(|entry| entry.id == id) {
                return Err(AppError::missing());
            }
            if !self.path(&id).is_file() {
                return Err(AppError::new(
                    "WORKSPACE_STORAGE_ERROR",
                    "The selected workspace database is missing. No empty replacement was created.",
                ));
            }
            id
        };
        let target = if next_id == current.active_id {
            db.clone()
        } else {
            Database::new(self.path(&next_id))
        };
        // Read all restored tabs before changing selection, so the UI can apply
        // one complete result without a second load that could partially fail.
        let (workspace, documents) = target.run(|conn| {
            let workspace = repo::workspace(conn)?;
            let documents = workspace
                .session
                .tab_ids
                .iter()
                .map(|id| repo::get_request(conn, id))
                .collect::<AppResult<Vec<_>>>()?;
            Ok((workspace, documents))
        })?;
        catalog.active_id = next_id;
        db.replace_after(&target, || self.persist(&catalog))?;
        *slot = Some(catalog.clone());
        Ok(Activation {
            catalog,
            workspace,
            documents,
        })
    }
    pub fn set_default(&self, id: &str) -> AppResult<Catalog> {
        let mut slot = self.catalog.lock().map_err(|_| unavailable())?;
        let mut catalog = slot.as_ref().ok_or_else(unavailable)?.clone();
        if !catalog.workspaces.iter().any(|entry| entry.id == id) {
            return Err(AppError::missing());
        }
        if catalog.default_id == id {
            return Ok(catalog);
        }
        if !self.path(id).is_file() {
            return Err(AppError::new(
                "WORKSPACE_STORAGE_ERROR",
                "The selected workspace database is missing. The default was not changed.",
            ));
        }
        Database::new(self.path(id)).run(|_| Ok(()))?;
        catalog.default_id = id.into();
        self.persist(&catalog)?;
        *slot = Some(catalog.clone());
        Ok(catalog)
    }
    pub fn remove(&self, db: &Database, id: &str) -> AppResult<Removal> {
        let mut slot = self.catalog.lock().map_err(|_| unavailable())?;
        let mut catalog = slot.as_ref().ok_or_else(unavailable)?.clone();
        if catalog.default_id == id {
            return Err(AppError::new(
                "PROTECTED_WORKSPACE",
                "The default workspace cannot be deleted. Set another workspace as default first.",
            ));
        }
        let removed = catalog
            .workspaces
            .iter()
            .find(|entry| entry.id == id)
            .cloned()
            .ok_or_else(AppError::missing)?;
        if catalog.removed_workspaces.len() >= MAX_REMOVED_WORKSPACES {
            return Err(AppError::invalid(
                "The recoverable workspace archive is full. No workspace was deleted.",
            ));
        }
        let replacement = if catalog.active_id == id {
            if !self.path(&catalog.default_id).is_file() {
                return Err(AppError::new("WORKSPACE_STORAGE_ERROR", "The default workspace database is missing. The active workspace was not deleted."));
            }
            let target = Database::new(self.path(&catalog.default_id));
            let (workspace, documents) = target.run(|conn| {
                let workspace = repo::workspace(conn)?;
                let documents = workspace
                    .session
                    .tab_ids
                    .iter()
                    .map(|id| repo::get_request(conn, id))
                    .collect::<AppResult<Vec<_>>>()?;
                Ok((workspace, documents))
            })?;
            catalog.active_id = catalog.default_id.clone();
            Some((target, workspace, documents))
        } else {
            None
        };
        catalog.workspaces.retain(|entry| entry.id != id);
        catalog.removed_workspaces.push(removed);
        // Atomic logical deletion: retain database/WAL/SHM files in place.
        // This also avoids moving files held by any previously captured worker.
        let activation = if let Some((target, workspace, documents)) = replacement {
            db.replace_after(&target, || self.persist(&catalog))?;
            Some(Activation {
                catalog: catalog.clone(),
                workspace,
                documents,
            })
        } else {
            self.persist(&catalog)?;
            None
        };
        *slot = Some(catalog.clone());
        Ok(Removal {
            catalog,
            activation,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::CreateCollection;
    #[test]
    fn switching_keeps_existing_data_and_command_snapshots_isolated() {
        let directory = tempfile::tempdir().unwrap();
        let db = Database::new(directory.path().join("postmen.sqlite3"));
        let registry = Registry::new(directory.path().into());
        registry.initialize(&db).unwrap();
        db.run(|c| {
            repo::create_collection(
                c,
                CreateCollection {
                    name: "Existing".into(),
                },
            )
        })
        .unwrap();
        let in_flight = db.clone();
        let created = registry
            .activate(&db, None, Some("Shopping".into()))
            .unwrap();
        assert!(created.workspace.collections.is_empty());
        in_flight
            .run(|c| {
                repo::create_collection(
                    c,
                    CreateCollection {
                        name: "Original only".into(),
                    },
                )
            })
            .unwrap();
        assert!(db.run(repo::workspace).unwrap().collections.is_empty());
        let original = registry
            .activate(&db, Some(DEFAULT_ID.into()), None)
            .unwrap();
        assert_eq!(original.workspace.collections.len(), 2);
        registry
            .activate(&db, Some(created.catalog.active_id.clone()), None)
            .unwrap();
        registry.set_default(&created.catalog.active_id).unwrap();
        let restarted = Registry::new(directory.path().into());
        let restarted_db = Database::new(directory.path().join("postmen.sqlite3"));
        assert_eq!(
            restarted.initialize(&restarted_db).unwrap().active_id,
            created.catalog.active_id
        );
        assert!(restarted_db
            .run(repo::workspace)
            .unwrap()
            .collections
            .is_empty());
    }
    #[test]
    fn invalid_selection_and_duplicate_names_do_not_change_active_workspace() {
        let directory = tempfile::tempdir().unwrap();
        let db = Database::new(directory.path().join("postmen.sqlite3"));
        let registry = Registry::new(directory.path().into());
        registry.initialize(&db).unwrap();
        for name in [" ", "my workspace", "\n\0"] {
            assert!(registry.activate(&db, None, Some(name.into())).is_err());
        }
        assert!(registry
            .activate(&db, Some("../../other".into()), None)
            .is_err());
        assert_eq!(registry.read().unwrap().active_id, DEFAULT_ID);
    }
    #[test]
    fn invalid_catalog_is_not_silently_replaced() {
        let mut catalog = Catalog::default();
        catalog.workspaces[0].id = "../escape".into();
        assert!(validate(&catalog).is_err());
        catalog = Catalog::default();
        catalog.active_id = uuid::Uuid::new_v4().to_string();
        assert!(validate(&catalog).is_err());
    }
    #[test]
    fn failed_catalog_save_keeps_the_original_database_and_selection() {
        let directory = tempfile::tempdir().unwrap();
        let db = Database::new(directory.path().join("postmen.sqlite3"));
        let registry = Registry::new(directory.path().into());
        registry.initialize(&db).unwrap();
        db.run(|c| {
            repo::create_collection(
                c,
                CreateCollection {
                    name: "Keep".into(),
                },
            )
        })
        .unwrap();
        let path = directory.path().join("workspaces.v1.json");
        let backup = directory.path().join("catalog-backup.json");
        std::fs::rename(&path, &backup).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert!(registry
            .activate(&db, None, Some("Cannot commit".into()))
            .is_err());
        assert_eq!(
            registry.catalog.lock().unwrap().as_ref().unwrap().active_id,
            DEFAULT_ID
        );
        assert_eq!(db.run(repo::workspace).unwrap().collections[0].name, "Keep");
        assert!(backup.is_file());
    }
    #[test]
    fn global_environments_and_saved_tabs_stay_with_their_workspace() {
        use crate::models::{CreateRequest, SaveEnvironment, Session};
        let directory = tempfile::tempdir().unwrap();
        let db = Database::new(directory.path().join("postmen.sqlite3"));
        let registry = Registry::new(directory.path().into());
        registry.initialize(&db).unwrap();
        let request = db
            .run(|c| {
                let collection = repo::create_collection(
                    c,
                    CreateCollection {
                        name: "Keep".into(),
                    },
                )?;
                let request = repo::create_request(
                    c,
                    CreateRequest {
                        collection_id: collection.id,
                        folder_id: None,
                        name: "Request".into(),
                        content: None,
                    },
                )?;
                crate::db::environments::save(
                    c,
                    SaveEnvironment {
                        id: None,
                        collection_id: None,
                        name: "Global".into(),
                        variables: vec![],
                        revision: None,
                    },
                )?;
                repo::save_session(
                    c,
                    Session {
                        tab_ids: vec![request.id.clone()],
                        active_id: Some(request.id.clone()),
                        views: Default::default(),
                    },
                )?;
                Ok(request)
            })
            .unwrap();
        let created = registry
            .activate(&db, None, Some("Isolated".into()))
            .unwrap();
        assert!(created.workspace.environments.is_empty());
        assert!(created.workspace.session.tab_ids.is_empty());
        assert!(created.documents.is_empty());
        let original = registry
            .activate(&db, Some(DEFAULT_ID.into()), None)
            .unwrap();
        assert_eq!(original.workspace.environments[0].name, "Global");
        assert_eq!(
            original.workspace.session.active_id.as_deref(),
            Some(request.id.as_str())
        );
        assert_eq!(original.documents[0].id, request.id);
    }
    #[test]
    fn a_missing_registered_database_is_not_recreated_as_empty() {
        let directory = tempfile::tempdir().unwrap();
        let db = Database::new(directory.path().join("postmen.sqlite3"));
        let registry = Registry::new(directory.path().into());
        let mut catalog = registry.initialize(&db).unwrap();
        let missing_id = uuid::Uuid::new_v4().to_string();
        catalog.workspaces.push(Entry {
            id: missing_id.clone(),
            name: "Missing".into(),
        });
        registry.persist(&catalog).unwrap();
        *registry.catalog.lock().unwrap() = Some(catalog);
        assert!(registry
            .activate(&db, Some(missing_id.clone()), None)
            .is_err());
        assert!(!registry.path(&missing_id).exists());
        assert_eq!(registry.read().unwrap().active_id, DEFAULT_ID);
    }
    #[test]
    fn existing_catalogs_gain_the_initial_default_without_losing_entries() {
        let value = format!(
            r#"{{"version":1,"activeId":"{DEFAULT_ID}","workspaces":[{{"id":"{DEFAULT_ID}","name":"My Workspace"}}]}}"#
        );
        let catalog: Catalog = serde_json::from_str(&value).unwrap();
        validate(&catalog).unwrap();
        assert_eq!(catalog.default_id, DEFAULT_ID);
        assert!(catalog.removed_workspaces.is_empty());
    }
    #[test]
    fn startup_opens_default_without_switching_when_default_is_set() {
        let directory = tempfile::tempdir().unwrap();
        let db = Database::new(directory.path().join("postmen.sqlite3"));
        let registry = Registry::new(directory.path().into());
        registry.initialize(&db).unwrap();
        let second = registry
            .activate(&db, None, Some("Shopping".into()))
            .unwrap()
            .catalog
            .active_id;
        let default = registry.set_default(DEFAULT_ID).unwrap();
        assert_eq!(default.active_id, second);
        let restarted = Registry::new(directory.path().into());
        let root = Database::new(directory.path().join("postmen.sqlite3"));
        assert_eq!(restarted.initialize(&root).unwrap().active_id, DEFAULT_ID);
    }
    #[test]
    fn default_is_protected_and_active_deletion_returns_default_without_erasing_files() {
        let directory = tempfile::tempdir().unwrap();
        let db = Database::new(directory.path().join("postmen.sqlite3"));
        let registry = Registry::new(directory.path().into());
        registry.initialize(&db).unwrap();
        assert_eq!(
            registry.remove(&db, DEFAULT_ID).err().unwrap().code,
            "PROTECTED_WORKSPACE"
        );
        let second = registry
            .activate(&db, None, Some("Shopping".into()))
            .unwrap()
            .catalog
            .active_id;
        db.run(|conn| {
            repo::create_collection(
                conn,
                CreateCollection {
                    name: "Recoverable".into(),
                },
            )
        })
        .unwrap();
        let removed = registry.remove(&db, &second).unwrap();
        assert_eq!(removed.catalog.active_id, DEFAULT_ID);
        assert!(removed.activation.is_some());
        assert!(removed
            .catalog
            .workspaces
            .iter()
            .all(|entry| entry.id != second));
        assert_eq!(registry.read().unwrap().removed_workspaces[0].id, second);
        let retained = Database::new(registry.path(&second));
        assert_eq!(
            retained.run(repo::workspace).unwrap().collections[0].name,
            "Recoverable"
        );
        assert!(registry.activate(&db, Some(second), None).is_err());
    }
    #[test]
    fn original_workspace_can_be_removed_only_after_another_is_default() {
        let directory = tempfile::tempdir().unwrap();
        let db = Database::new(directory.path().join("postmen.sqlite3"));
        let registry = Registry::new(directory.path().into());
        registry.initialize(&db).unwrap();
        let second = registry
            .activate(&db, None, Some("New default".into()))
            .unwrap()
            .catalog
            .active_id;
        registry.set_default(&second).unwrap();
        let result = registry.remove(&db, DEFAULT_ID).unwrap();
        assert!(result.activation.is_none());
        assert_eq!(result.catalog.default_id, second);
        validate(&result.catalog).unwrap();
        assert!(directory.path().join("postmen.sqlite3").is_file());
        assert!(registry.remove(&db, &second).is_err());
    }
}
