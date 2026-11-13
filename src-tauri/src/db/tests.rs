use super::{repository as repo, Database};
use crate::models::*;
use rusqlite::{params, Connection};

fn fixture() -> (tempfile::TempDir, Database) {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path().join("postmen.sqlite3"));
    (dir, db)
}
fn collection(c: &mut Connection) -> Collection {
    repo::create_collection(c, CreateCollection { name: "API".into() }).unwrap()
}
fn request(c: &mut Connection, collection_id: &str, folder_id: Option<String>) -> RequestDoc {
    repo::create_request(
        c,
        CreateRequest {
            collection_id: collection_id.into(),
            folder_id,
            name: "Request".into(),
            content: None,
        },
    )
    .unwrap()
}
fn row(name: &str, value: &str) -> KeyValue {
    KeyValue {
        id: uuid::Uuid::new_v4().to_string(),
        enabled: true,
        name: name.into(),
        value: value.into(),
        description: "Description".into(),
    }
}

#[test]
fn create_request_with_content_is_saved_complete_at_revision_one() {
    let (_dir, db) = fixture();
    db.run(|c| {
        let collection = collection(c);
        let doc = repo::create_request(
            c,
            CreateRequest {
                collection_id: collection.id,
                folder_id: None,
                name: "Imported HTTP".into(),
                content: Some(NewRequestContent {
                    method: "PATCH".into(),
                    url: "https://example.test/users?a=1&a=2".into(),
                    body_kind: "json".into(),
                    body: "{\"name\":\"日本語\"}".into(),
                    params: vec![row("q", "hello")],
                    headers: vec![row("X-Test", "first"), row("X-Test", "second")],
                    form_data: vec![],
                }),
            },
        )?;
        let saved = repo::get_request(c, &doc.id)?;
        assert_eq!(saved.revision, 1);
        assert_eq!(saved.method, "PATCH");
        assert_eq!(saved.url, "https://example.test/users?a=1&a=2");
        assert_eq!(saved.body, "{\"name\":\"日本語\"}");
        assert_eq!(saved.headers.len(), 2);
        assert_eq!(saved.headers[1].value, "second");
        assert_eq!(saved.params[0].value, "hello");
        Ok(())
    })
    .unwrap();
}

#[test]
fn create_request_rolls_back_everything_when_an_imported_row_fails() {
    let (_dir, db) = fixture();
    db.run(|c| {
        let collection = collection(c);
        let mut existing = request(c, &collection.id, None);
        existing.headers.push(row("X-Existing", "keep"));
        let saved = repo::save_request(c, existing)?;
        c.execute_batch("CREATE TRIGGER fail_import_header BEFORE INSERT ON request_headers BEGIN SELECT RAISE(ABORT,'test failure'); END;")?;
        let failed = repo::create_request(
            c,
            CreateRequest {
                collection_id: collection.id,
                folder_id: None,
                name: "Must not survive".into(),
                content: Some(NewRequestContent {
                    method: "POST".into(),
                    url: "https://example.test".into(),
                    body_kind: "json".into(),
                    body: "{}".into(),
                    params: vec![row("inserted-first", "rollback")],
                    headers: vec![row("X-Imported", "rollback")],
                    form_data: vec![],
                }),
            },
        );
        assert!(failed.is_err());
        assert_eq!(repo::workspace(c)?.requests.len(), 1);
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM request_params", [], |r| r
                .get::<_, i64>(0))?,
            0
        );
        assert_eq!(repo::get_request(c, &saved.id)?.headers[0].value, "keep");
        Ok(())
    })
    .unwrap();
}

#[test]
fn save_and_move_requests_is_atomic_and_preserves_visible_input_order() {
    let (_dir, db) = fixture();
    db.run(|c| {
        let collection = collection(c);
        let target = repo::create_folder(
            c,
            CreateFolder {
                collection_id: collection.id.clone(),
                parent_id: None,
                name: "Target".into(),
            },
        )?;
        let first = request(c, &collection.id, None);
        let second = request(c, &collection.id, None);
        let mut dirty = repo::get_request(c, &first.id)?;
        dirty.body = "saved atomically".into();
        let saved = repo::save_and_move_requests(
            c,
            SaveAndMoveRequests {
                target_folder_id: Some(target.id.clone()),
                anchor_id: None,
                insert_after: false,
                requests: vec![
                    MoveRequestItem {
                        id: second.id.clone(),
                        revision: second.revision,
                        draft: None,
                    },
                    MoveRequestItem {
                        id: first.id.clone(),
                        revision: dirty.revision,
                        draft: Some(dirty),
                    },
                ],
            },
        )?;
        assert_eq!(
            saved
                .requests
                .iter()
                .map(|doc| doc.id.as_str())
                .collect::<Vec<_>>(),
            vec![second.id.as_str(), first.id.as_str()]
        );
        assert_eq!(saved.requests[0].position + 1, saved.requests[1].position);
        assert_eq!(repo::get_request(c, &first.id)?.body, "saved atomically");
        let before = repo::workspace(c)?;
        let conflict = repo::save_and_move_requests(
            c,
            SaveAndMoveRequests {
                target_folder_id: Some(target.id),
                anchor_id: None,
                insert_after: false,
                requests: vec![
                    MoveRequestItem {
                        id: first.id,
                        revision: saved.requests[1].revision - 1,
                        draft: None,
                    },
                    MoveRequestItem {
                        id: second.id,
                        revision: saved.requests[0].revision,
                        draft: None,
                    },
                ],
            },
        );
        assert_eq!(conflict.unwrap_err().code, "CONFLICT");
        assert_eq!(
            repo::workspace(c)?
                .requests
                .iter()
                .map(|request| (
                    &request.id,
                    &request.folder_id,
                    request.revision,
                    request.position
                ))
                .collect::<Vec<_>>(),
            before
                .requests
                .iter()
                .map(|request| (
                    &request.id,
                    &request.folder_id,
                    request.revision,
                    request.position
                ))
                .collect::<Vec<_>>(),
        );
        Ok(())
    })
    .unwrap();
}

#[test]
fn save_and_move_requests_rolls_back_after_a_later_dirty_write_fails() {
    let (_dir, db) = fixture();
    db.run(|c| {
        let collection = collection(c);
        let target = repo::create_folder(c, CreateFolder { collection_id: collection.id.clone(), parent_id: None, name: "Target".into() })?;
        let first_created = request(c, &collection.id, None);
        let second_created = request(c, &collection.id, None);
        let first = repo::get_request(c, &first_created.id)?;
        let second = repo::get_request(c, &second_created.id)?;
        let mut dirty_first = first.clone(); dirty_first.body = "first changed".into(); dirty_first.headers = vec![row("X-First", "one")];
        let mut dirty_second = second.clone(); dirty_second.body = "second changed".into(); dirty_second.headers = vec![row("X-Second", "two")];
        c.execute_batch(&format!("CREATE TRIGGER fail_second_move BEFORE INSERT ON request_headers WHEN NEW.request_id = '{}' BEGIN SELECT RAISE(ABORT,'second write failed'); END;", second.id))?;
        let failure = repo::save_and_move_requests(c, SaveAndMoveRequests {
            target_folder_id: Some(target.id),
            anchor_id: None, insert_after: false,
            requests: vec![
                MoveRequestItem { id: first.id.clone(), revision: first.revision, draft: Some(dirty_first) },
                MoveRequestItem { id: second.id.clone(), revision: second.revision, draft: Some(dirty_second) },
            ],
        });
        assert!(failure.is_err());
        for original in [&first, &second] {
            let current = repo::get_request(c, &original.id)?;
            assert_eq!(current.body, original.body);
            assert_eq!(current.revision, original.revision);
            assert_eq!(current.position, original.position);
            assert_eq!(current.folder_id, original.folder_id);
            assert_eq!(current.headers.len(), original.headers.len());
        }
        Ok(())
    }).unwrap();
}

#[test]
fn save_and_move_requests_moves_to_collection_root_atomically_and_keeps_root_noops_stable() {
    let (_dir, db) = fixture();
    db.run(|c| {
        let collection = collection(c);
        let folder = repo::create_folder(
            c,
            CreateFolder {
                collection_id: collection.id.clone(),
                parent_id: None,
                name: "Folder".into(),
            },
        )?;
        let nested_created = request(c, &collection.id, Some(folder.id.clone()));
        let root_created = request(c, &collection.id, None);
        let nested = repo::get_request(c, &nested_created.id)?;
        let root = repo::get_request(c, &root_created.id)?;
        let mut dirty = nested.clone();
        dirty.body = "saved while moving to root".into();
        let saved = repo::save_and_move_requests(
            c,
            SaveAndMoveRequests {
                target_folder_id: None,
                anchor_id: None,
                insert_after: false,
                requests: vec![
                    MoveRequestItem {
                        id: nested.id.clone(),
                        revision: nested.revision,
                        draft: Some(dirty),
                    },
                    MoveRequestItem {
                        id: root.id.clone(),
                        revision: root.revision,
                        draft: None,
                    },
                ],
            },
        )?;
        assert!(saved.requests.iter().all(|doc| doc.folder_id.is_none()));
        assert_eq!(saved.requests[0].body, "saved while moving to root");
        assert_eq!(saved.requests[1].position + 1, saved.requests[0].position);
        let root_after = repo::get_request(c, &root.id)?;
        let no_op = repo::save_and_move_requests(
            c,
            SaveAndMoveRequests {
                target_folder_id: None,
                anchor_id: None,
                insert_after: false,
                requests: vec![MoveRequestItem {
                    id: root.id.clone(),
                    revision: root_after.revision,
                    draft: None,
                }],
            },
        )?;
        assert_eq!(no_op.requests[0].revision, root_after.revision);
        Ok(())
    })
    .unwrap();
}

#[test]
fn save_and_move_requests_inserts_before_anchor_with_mixed_siblings() {
    let (_dir, db) = fixture();
    db.run(|c| {
        let collection = collection(c);
        let source = repo::create_folder(
            c,
            CreateFolder {
                collection_id: collection.id.clone(),
                parent_id: None,
                name: "Source".into(),
            },
        )?;
        let destination = repo::create_folder(
            c,
            CreateFolder {
                collection_id: collection.id.clone(),
                parent_id: None,
                name: "Destination".into(),
            },
        )?;
        let earlier = request(c, &collection.id, Some(destination.id.clone()));
        let nested_folder = repo::create_folder(
            c,
            CreateFolder {
                collection_id: collection.id.clone(),
                parent_id: Some(destination.id.clone()),
                name: "Nested".into(),
            },
        )?;
        let target = request(c, &collection.id, Some(destination.id.clone()));
        let later = request(c, &collection.id, Some(destination.id.clone()));
        let first = request(c, &collection.id, Some(source.id.clone()));
        let second = request(c, &collection.id, Some(source.id));
        let result = repo::save_and_move_requests(
            c,
            SaveAndMoveRequests {
                target_folder_id: Some(destination.id),
                anchor_id: Some(target.id.clone()),
                insert_after: false,
                requests: vec![
                    MoveRequestItem {
                        id: first.id.clone(),
                        revision: first.revision,
                        draft: None,
                    },
                    MoveRequestItem {
                        id: second.id.clone(),
                        revision: second.revision,
                        draft: None,
                    },
                ],
            },
        )?;
        assert_eq!(
            result.items,
            vec![
                TreeRef {
                    kind: "request".into(),
                    id: earlier.id
                },
                TreeRef {
                    kind: "folder".into(),
                    id: nested_folder.id
                },
                TreeRef {
                    kind: "request".into(),
                    id: first.id.clone()
                },
                TreeRef {
                    kind: "request".into(),
                    id: second.id.clone()
                },
                TreeRef {
                    kind: "request".into(),
                    id: target.id
                },
                TreeRef {
                    kind: "request".into(),
                    id: later.id
                },
            ]
        );
        assert_eq!(repo::get_request(c, &first.id)?.position, 2);
        assert_eq!(repo::get_request(c, &second.id)?.position, 3);
        Ok(())
    })
    .unwrap();
}

#[test]
fn save_and_move_requests_keeps_a_selected_anchor_and_rolls_back_on_failure() {
    let (_dir, db) = fixture();
    db.run(|c| {
        let collection = collection(c);
        let source = repo::create_folder(
            c,
            CreateFolder {
                collection_id: collection.id.clone(),
                parent_id: None,
                name: "Source".into(),
            },
        )?;
        let destination = repo::create_folder(
            c,
            CreateFolder {
                collection_id: collection.id.clone(),
                parent_id: None,
                name: "Destination".into(),
            },
        )?;
        let anchor = request(c, &collection.id, Some(destination.id.clone()));
        let first = request(c, &collection.id, Some(source.id.clone()));
        let second = request(c, &collection.id, Some(source.id));
        let before = repo::workspace(c)?;
        let result = repo::save_and_move_requests(
            c,
            SaveAndMoveRequests {
                target_folder_id: Some(destination.id.clone()),
                anchor_id: Some(anchor.id.clone()),
                insert_after: false,
                requests: vec![
                    MoveRequestItem {
                        id: first.id.clone(),
                        revision: first.revision,
                        draft: None,
                    },
                    MoveRequestItem {
                        id: anchor.id.clone(),
                        revision: anchor.revision,
                        draft: None,
                    },
                    MoveRequestItem {
                        id: second.id.clone(),
                        revision: second.revision,
                        draft: None,
                    },
                ],
            },
        )?;
        assert_eq!(
            result
                .items
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec![first.id.as_str(), second.id.as_str(), anchor.id.as_str()]
        );
        assert_eq!(
            repo::get_request(c, &anchor.id)?.folder_id.as_deref(),
            Some(destination.id.as_str())
        );
        let first_after = repo::get_request(c, &first.id)?;
        let anchor_after = repo::get_request(c, &anchor.id)?;
        let before_failure = repo::workspace(c)?;
        let failure = repo::save_and_move_requests(
            c,
            SaveAndMoveRequests {
                target_folder_id: Some(destination.id),
                anchor_id: Some(anchor.id.clone()),
                insert_after: true,
                requests: vec![
                    MoveRequestItem {
                        id: first.id.clone(),
                        revision: first_after.revision - 1,
                        draft: None,
                    },
                    MoveRequestItem {
                        id: anchor.id.clone(),
                        revision: anchor_after.revision,
                        draft: None,
                    },
                ],
            },
        );
        assert_eq!(failure.unwrap_err().code, "CONFLICT");
        let after = repo::workspace(c)?;
        assert_ne!(before.requests.len(), 0);
        assert_eq!(
            after
                .requests
                .iter()
                .map(|request| (
                    &request.id,
                    &request.folder_id,
                    request.position,
                    request.revision
                ))
                .collect::<Vec<_>>(),
            before_failure
                .requests
                .iter()
                .map(|request| (
                    &request.id,
                    &request.folder_id,
                    request.position,
                    request.revision
                ))
                .collect::<Vec<_>>()
        );
        Ok(())
    })
    .unwrap();
}

#[test]
fn name_only_create_input_remains_compatible_and_content_is_validated() {
    let (_dir, db) = fixture();
    db.run(|c| {
        let collection = collection(c);
        let input: CreateRequest = serde_json::from_value(serde_json::json!({
            "collectionId": collection.id, "folderId": null, "name": "Default request"
        }))
        .unwrap();
        let created = repo::create_request(c, input)?;
        assert_eq!(created.method, "GET");
        assert!(created.url.is_empty());
        assert_eq!(created.body_kind, "none");
        let invalid: CreateRequest = serde_json::from_value(serde_json::json!({
            "collectionId": collection.id, "folderId": null, "name": "Invalid",
            "content": { "method": "TRACE", "url": "",
                "bodyKind": "none", "body": "", "params": [], "headers": [], "formData": [] }
        }))
        .unwrap();
        assert!(repo::create_request(c, invalid).is_err());
        assert_eq!(repo::workspace(c)?.requests.len(), 1);
        Ok(())
    })
    .unwrap();
}

#[test]
fn new_database_is_empty_and_restart_is_not_destructive() {
    let (dir, db) = fixture();
    db.run(|c| {
        assert!(repo::workspace(c)?.collections.is_empty());
        assert_eq!(
            c.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))?,
            3
        );
        collection(c);
        Ok(())
    })
    .unwrap();
    drop(db);
    let db = Database::new(dir.path().join("postmen.sqlite3"));
    db.run(|c| {
        assert_eq!(repo::workspace(c)?.collections.len(), 1);
        assert_eq!(
            c.pragma_query_value(None, "foreign_keys", |r| r.get::<_, i64>(0))?,
            1
        );
        Ok(())
    })
    .unwrap();
}
#[test]
fn environment_upgrade_preserves_requests_and_retires_base_url_tables() {
    let (dir, _) = fixture();
    let path = dir.path().join("postmen.sqlite3");
    let mut conn = Connection::open(&path).unwrap();
    conn.pragma_update(None, "foreign_keys", true).unwrap();
    conn.execute_batch("CREATE TABLE hostnames (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL, position INTEGER NOT NULL);").unwrap();
    conn.execute_batch(&include_str!("schema.sql").replace("url TEXT NOT NULL DEFAULT '',", "url TEXT NOT NULL DEFAULT '', hostname_id TEXT REFERENCES hostnames(id) ON DELETE SET NULL,")).unwrap();
    conn.pragma_update(None, "application_id", super::APPLICATION_ID)
        .unwrap();
    conn.pragma_update(None, "user_version", 1).unwrap();
    let col = collection(&mut conn);
    let mut doc = request(&mut conn, &col.id, None);
    doc.url = "/users".into();
    doc.headers.push(row("X-Keep", "preserved"));
    repo::save_request(&mut conn, doc.clone()).unwrap();
    conn.execute(
        "INSERT INTO hostnames VALUES ('old','Local','https://example.test',0)",
        [],
    )
    .unwrap();
    conn.execute(
        "UPDATE requests SET hostname_id='old' WHERE id=?1",
        [&doc.id],
    )
    .unwrap();
    drop(conn);
    let db = Database::new(path);
    db.run(|conn| {
        assert_eq!(
            conn.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))?,
            3
        );
        let saved = repo::get_request(conn, &doc.id)?;
        assert_eq!(saved.url, "/users");
        assert_eq!(saved.headers[0].value, "preserved");
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM sqlite_master WHERE name='hostnames'",
                [],
                |r| r.get::<_, i64>(0)
            )?,
            0
        );
        assert!(repo::workspace(conn)?.environments.is_empty());
        assert_eq!(
            conn.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))?,
            "ok"
        );
        Ok(())
    })
    .unwrap();
}

#[test]
fn environments_resolve_scopes_without_mutating_saved_templates_and_restore_selection() {
    use super::environments as env;
    let (dir, db) = fixture();
    let (collection_id, local_id, request_id) = db
        .run(|conn| {
            let col = collection(conn);
            let global = env::save(
                conn,
                SaveEnvironment {
                    id: None,
                    collection_id: None,
                    name: "Shared".into(),
                    variables: vec![
                        row("api_url", "https://global.test"),
                        row("token", "global-token"),
                        row("query", "a&b 日本語"),
                    ],
                    revision: None,
                },
            )?;
            let local = env::save(
                conn,
                SaveEnvironment {
                    id: None,
                    collection_id: Some(col.id.clone()),
                    name: "Local".into(),
                    variables: vec![
                        row("api_url", "https://local.test"),
                        row("endpoint", "<<api_url>>/users"),
                        row("header", "X-Token"),
                    ],
                    revision: None,
                },
            )?;
            env::select(
                conn,
                EnvironmentSelection {
                    collection_id: None,
                    environment_id: Some(global.id),
                },
            )?;
            env::select(
                conn,
                EnvironmentSelection {
                    collection_id: Some(col.id.clone()),
                    environment_id: Some(local.id.clone()),
                },
            )?;
            assert!(env::select(
                conn,
                EnvironmentSelection {
                    collection_id: None,
                    environment_id: Some(local.id.clone())
                }
            )
            .is_err());
            let mut doc = request(conn, &col.id, None);
            doc.url = "<<endpoint>>?existing=1".into();
            doc.params = vec![row("q", "<<query>>"), row("q", "repeat")];
            doc.headers = vec![row("<<header>>", "Bearer <<token>>")];
            doc.params.push(KeyValue {
                enabled: false,
                ..row("ignored", "<<missing>>")
            });
            let saved = repo::save_request(conn, doc)?;
            let resolved = env::resolve_request(conn, saved.clone())?;
            assert_eq!(resolved.url, "https://local.test/users?existing=1");
            assert_eq!(resolved.headers[0].name, "X-Token");
            assert_eq!(resolved.headers[0].value, "Bearer global-token");
            let url = crate::execution::http::compose_url(&resolved)?;
            assert_eq!(url.query_pairs().nth(1).unwrap().1, "a&b 日本語");
            assert_eq!(
                repo::get_request(conn, &saved.id)?.url,
                "<<endpoint>>?existing=1"
            );
            env::select(
                conn,
                EnvironmentSelection {
                    collection_id: Some(col.id.clone()),
                    environment_id: None,
                },
            )?;
            assert_eq!(
                env::resolve_request(conn, saved.clone()).unwrap_err().code,
                "VARIABLE_NOT_FOUND"
            );
            // A prepared snapshot keeps its resolved values after the selection changes.
            assert_eq!(resolved.url, "https://local.test/users?existing=1");
            env::select(
                conn,
                EnvironmentSelection {
                    collection_id: Some(col.id.clone()),
                    environment_id: Some(local.id.clone()),
                },
            )?;
            Ok((col.id, local.id, saved.id))
        })
        .unwrap();
    drop(db);
    Database::new(dir.path().join("postmen.sqlite3"))
        .run(|conn| {
            assert!(env::selections(conn)?
                .iter()
                .any(|s| s.collection_id.as_deref() == Some(&collection_id)
                    && s.environment_id.as_deref() == Some(&local_id)));
            let saved = repo::get_request(conn, &request_id)?;
            assert_eq!(
                env::resolve_request(conn, saved)?.url,
                "https://local.test/users?existing=1"
            );
            Ok(())
        })
        .unwrap();
}

#[test]
fn environment_failures_leave_saved_variables_unchanged_and_block_invalid_expansion() {
    use super::environments as env;
    let (_dir, db) = fixture();
    db.run(|conn| {
        let col = collection(conn);
        let saved = env::save(
            conn,
            SaveEnvironment {
                id: None,
                collection_id: Some(col.id.clone()),
                name: "Local".into(),
                variables: vec![
                    row("api_url", "https://example.test"),
                    row("cycle", "<<cycle>>"),
                    row("bad_header", "bad\r\nInjected: value"),
                ],
                revision: None,
            },
        )?;
        env::select(
            conn,
            EnvironmentSelection {
                collection_id: Some(col.id.clone()),
                environment_id: Some(saved.id.clone()),
            },
        )?;
        let edit = SaveEnvironment {
            id: Some(saved.id.clone()),
            collection_id: saved.collection_id.clone(),
            name: saved.name.clone(),
            variables: vec![row("api_url", "https://changed.test")],
            revision: Some(999),
        };
        assert_eq!(env::save(conn, edit).unwrap_err().code, "CONFLICT");
        assert_eq!(
            env::list(conn)?[0].variables[0].value,
            "https://example.test"
        );
        let mut doc = request(conn, &col.id, None);
        for (url, code) in [
            ("<<missing>>", "VARIABLE_NOT_FOUND"),
            ("<<cycle>>", "VARIABLE_CYCLE"),
            ("<<unfinished", "INVALID_VARIABLE"),
        ] {
            doc.url = url.into();
            assert_eq!(
                env::resolve_request(conn, doc.clone()).unwrap_err().code,
                code
            );
        }
        doc.url = "<<api_url>>".into();
        doc.headers = vec![row("X-Test", "<<bad_header>>")];
        let resolved = env::resolve_request(conn, doc)?;
        assert!(crate::execution::http::headers(&resolved).is_err());
        Ok(())
    })
    .unwrap();
}
#[test]
fn unsupported_database_is_not_migrated_or_deleted() {
    let (dir, _) = fixture();
    let path = dir.path().join("postmen.sqlite3");
    let c = Connection::open(&path).unwrap();
    c.execute_batch("CREATE TABLE unrelated (value TEXT); INSERT INTO unrelated VALUES ('keep');")
        .unwrap();
    drop(c);
    let db = Database::new(path.clone());
    assert_eq!(db.run(|_| Ok(())).unwrap_err().code, "UNSUPPORTED_SCHEMA");
    assert_eq!(
        Connection::open(path)
            .unwrap()
            .query_row("SELECT value FROM unrelated", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "keep"
    );
}
#[test]
fn io_errors_are_visible_and_initialization_can_retry() {
    let (dir, _) = fixture();
    let parent = dir.path().join("not-a-directory");
    std::fs::write(&parent, "marker").unwrap();
    let db = Database::new(parent.join("postmen.sqlite3"));
    assert_eq!(db.run(|_| Ok(())).unwrap_err().code, "DATABASE_ERROR");
    assert_eq!(std::fs::read_to_string(&parent).unwrap(), "marker");
    std::fs::rename(&parent, dir.path().join("preserved-marker")).unwrap();
    db.run(|c| {
        assert!(repo::workspace(c)?.collections.is_empty());
        Ok(())
    })
    .unwrap();
}
#[test]
fn folder_relationships_cycle_and_cross_collection_are_rejected() {
    let (_dir, db) = fixture();
    db.run(|c| {
        let a = collection(c);
        let b = collection(c);
        let f = repo::create_folder(
            c,
            CreateFolder {
                collection_id: a.id.clone(),
                parent_id: None,
                name: "Parent".into(),
            },
        )?;
        let child = repo::create_folder(
            c,
            CreateFolder {
                collection_id: a.id.clone(),
                parent_id: Some(f.id.clone()),
                name: "Child".into(),
            },
        )?;
        assert!(repo::update_folder(
            c,
            UpdateFolder {
                id: f.id.clone(),
                parent_id: Some(child.id),
                name: f.name.clone()
            }
        )
        .is_err());
        assert!(repo::create_folder(
            c,
            CreateFolder {
                collection_id: b.id.clone(),
                parent_id: Some(f.id.clone()),
                name: "Bad".into(),
            }
        )
        .is_err());
        assert!(repo::create_request(
            c,
            CreateRequest {
                collection_id: b.id,
                folder_id: Some(f.id),
                name: "Bad".into(),
                content: None,
            }
        )
        .is_err());
        Ok(())
    })
    .unwrap();
}
#[test]
fn move_folder_orders_with_request_anchor_and_persists_safely() {
    let (_dir, db) = fixture();
    let (collection_id, source_id, target_id, anchor_id, other_collection_id) = db
        .run(|c| {
            let collection = collection(c);
            let other = repo::create_collection(
                c,
                CreateCollection {
                    name: "Other API".into(),
                },
            )?;
            let parent = repo::create_folder(
                c,
                CreateFolder {
                    collection_id: collection.id.clone(),
                    parent_id: None,
                    name: "Parent".into(),
                },
            )?;
            let source = repo::create_folder(
                c,
                CreateFolder {
                    collection_id: collection.id.clone(),
                    parent_id: Some(parent.id),
                    name: "Source".into(),
                },
            )?;
            let target = repo::create_folder(
                c,
                CreateFolder {
                    collection_id: collection.id.clone(),
                    parent_id: None,
                    name: "Target".into(),
                },
            )?;
            let earlier = request(c, &collection.id, Some(target.id.clone()));
            let anchor = request(c, &collection.id, Some(target.id.clone()));
            let later = request(c, &collection.id, Some(target.id.clone()));
            let moved = repo::move_folder(
                c,
                MoveFolder {
                    id: source.id.clone(),
                    target_folder_id: Some(target.id.clone()),
                    anchor_id: Some(anchor.id.clone()),
                    insert_after: false,
                },
            )?;
            assert_eq!(moved.folder.parent_id, Some(target.id.clone()));
            assert_eq!(
                moved.items,
                vec![
                    TreeRef {
                        kind: "request".into(),
                        id: earlier.id
                    },
                    TreeRef {
                        kind: "folder".into(),
                        id: source.id.clone()
                    },
                    TreeRef {
                        kind: "request".into(),
                        id: anchor.id.clone()
                    },
                    TreeRef {
                        kind: "request".into(),
                        id: later.id
                    },
                ]
            );
            Ok((collection.id, source.id, target.id, anchor.id, other.id))
        })
        .unwrap();
    db.run(|c| {
        let workspace = repo::workspace(c)?;
        assert_eq!(
            workspace
                .folders
                .iter()
                .find(|folder| folder.id == source_id)
                .unwrap()
                .parent_id,
            Some(target_id.clone())
        );
        assert!(repo::move_folder(
            c,
            MoveFolder {
                id: target_id.clone(),
                target_folder_id: Some(source_id.clone()),
                anchor_id: None,
                insert_after: false,
            }
        )
        .is_err());
        let other_target = repo::create_folder(
            c,
            CreateFolder {
                collection_id: other_collection_id,
                parent_id: None,
                name: "Other".into(),
            },
        )?;
        assert!(repo::move_folder(
            c,
            MoveFolder {
                id: source_id.clone(),
                target_folder_id: Some(other_target.id),
                anchor_id: Some(anchor_id),
                insert_after: false,
            }
        )
        .is_err());
        assert_eq!(
            repo::workspace(c)?
                .folders
                .iter()
                .find(|folder| folder.id == source_id)
                .unwrap()
                .collection_id,
            collection_id
        );
        Ok(())
    })
    .unwrap();
}
#[test]
fn request_roundtrip_preserves_duplicates_unicode_and_all_body_fields() {
    let (dir, db) = fixture();
    let id = db
        .run(|c| {
            let col = collection(c);
            let mut r = request(c, &col.id, None);
            r.method = "POST".into();
            r.url = "/users?existing=1".into();
            r.body_kind = "json".into();
            r.body = "{\"日本語\":true}".into();
            r.params = vec![row("q", "a&b"), row("q", "東京 + #?")];
            r.params[1].enabled = false;
            r.headers = vec![row("X-Test", "first"), row("X-Test", "second")];
            r.form_data = vec![FormField {
                id: uuid::Uuid::new_v4().to_string(),
                enabled: false,
                name: "meta".into(),
                kind: "text".into(),
                value: "hello".into(),
                attachment_id: None,
                description: "kept".into(),
            }];
            let saved = repo::save_request(c, r)?;
            assert_eq!(saved.revision, 2);
            Ok(saved.id)
        })
        .unwrap();
    drop(db);
    let db = Database::new(dir.path().join("postmen.sqlite3"));
    db.run(|c| {
        let r = repo::get_request(c, &id)?;
        assert_eq!(r.params.len(), 2);
        assert!(!r.params[1].enabled);
        assert_eq!(r.params[1].value, "東京 + #?");
        assert_eq!(r.headers.len(), 2);
        assert_eq!(r.form_data[0].description, "kept");
        assert_eq!(r.body, "{\"日本語\":true}");
        Ok(())
    })
    .unwrap();
}
#[test]
fn save_rolls_back_mid_transaction_failure() {
    let (_dir, db) = fixture();
    db.run(|c|{
        let col=collection(c);let mut r=request(c,&col.id,None);r.params=vec![row("before","kept")];let mut r=repo::save_request(c,r)?;let revision=r.revision;
        c.execute_batch("CREATE TRIGGER fail_header BEFORE INSERT ON request_headers BEGIN SELECT RAISE(ABORT,'test failure'); END;")?;
        r.name="Not committed".into();r.params.clear();r.headers.push(row("X-Test","fail"));assert!(repo::save_request(c,r.clone()).is_err());
        let kept=repo::get_request(c,&r.id)?;assert_eq!(kept.name,"Request");assert_eq!(kept.params.len(),1);assert_eq!(kept.revision,revision);Ok(())
    }).unwrap();
}
#[test]
fn stale_save_cannot_overwrite_newer_revision() {
    let (_dir, db) = fixture();
    db.run(|c| {
        let col = collection(c);
        let a = request(c, &col.id, None);
        let mut b = a.clone();
        b.name = "New name".into();
        repo::save_request(c, b)?;
        assert_eq!(
            repo::save_request(c, a.clone()).unwrap_err().code,
            "CONFLICT"
        );
        assert_eq!(repo::get_request(c, &a.id)?.name, "New name");
        Ok(())
    })
    .unwrap();
}
#[test]
fn delete_cascades_and_environment_delete_clears_selection() {
    let (_dir, db) = fixture();
    db.run(|c| {
        let col = collection(c);
        let f = repo::create_folder(
            c,
            CreateFolder {
                collection_id: col.id.clone(),
                parent_id: None,
                name: "Folder".into(),
            },
        )?;
        let env = super::environments::save(
            c,
            SaveEnvironment {
                id: None,
                collection_id: Some(col.id.clone()),
                name: "Local".into(),
                variables: vec![row("api_url", "http://localhost:43119/api")],
                revision: None,
            },
        )?;
        super::environments::select(
            c,
            EnvironmentSelection {
                collection_id: Some(col.id.clone()),
                environment_id: Some(env.id.clone()),
            },
        )?;
        let mut r = request(c, &col.id, Some(f.id.clone()));
        r.url = "<<api_url>>/users".into();
        r.params.push(row("q", "kept"));
        repo::save_request(c, r.clone())?;
        super::environments::delete(c, &env.id)?;
        assert!(super::environments::selections(c)?[0]
            .environment_id
            .is_none());
        assert_eq!(repo::get_request(c, &r.id)?.url, "<<api_url>>/users");
        c.execute(
            "INSERT INTO request_history VALUES (?1,?2,'success',0,'{}')",
            params![uuid::Uuid::new_v4().to_string(), r.id],
        )?;
        repo::delete_item(c, "folder", &f.id)?;
        assert!(repo::get_request(c, &r.id).is_err());
        assert_eq!(
            c.query_row("SELECT count(*) FROM request_params", [], |r| r
                .get::<_, i64>(0))?,
            0
        );
        assert_eq!(
            c.query_row("SELECT request_id FROM request_history", [], |r| r
                .get::<_, Option<String>>(0))?,
            None
        );
        repo::delete_item(c, "collection", &col.id)?;
        assert!(repo::workspace(c)?.collections.is_empty());
        Ok(())
    })
    .unwrap();
}
#[test]
fn reorder_requires_complete_unique_siblings() {
    let (_dir, db) = fixture();
    db.run(|c| {
        let col = collection(c);
        let a = request(c, &col.id, None);
        let b = request(c, &col.id, None);
        assert!(repo::reorder(
            c,
            Reorder {
                collection_id: Some(col.id.clone()),
                parent_id: None,
                items: vec![TreeRef {
                    kind: "request".into(),
                    id: a.id.clone()
                }]
            }
        )
        .is_err());
        repo::reorder(
            c,
            Reorder {
                collection_id: Some(col.id),
                parent_id: None,
                items: vec![
                    TreeRef {
                        kind: "request".into(),
                        id: b.id.clone(),
                    },
                    TreeRef {
                        kind: "request".into(),
                        id: a.id,
                    },
                ],
            },
        )?;
        assert_eq!(repo::workspace(c)?.requests[0].id, b.id);
        Ok(())
    })
    .unwrap();
}
#[test]
fn sessions_restore_only_existing_tabs_and_report_corruption() {
    let (_dir, db) = fixture();
    db.run(|c| {
        let col = collection(c);
        let r = request(c, &col.id, None);
        let missing = uuid::Uuid::new_v4().to_string();
        let session = repo::save_session(
            c,
            Session {
                tab_ids: vec![r.id.clone(), missing.clone(), r.id.clone()],
                active_id: Some(missing),
                views: Default::default(),
            },
        )?;
        assert_eq!(session.tab_ids, vec![r.id.clone()]);
        assert_eq!(session.active_id, Some(r.id));
        c.execute("UPDATE app_settings SET value_json='broken'", [])?;
        let w = repo::workspace(c)?;
        assert_eq!(w.warnings.len(), 1);
        assert_eq!(w.collections.len(), 1);
        Ok(())
    })
    .unwrap();
}
#[test]
fn workspace_restores_attachment_metadata_without_checking_files() {
    let (dir, db) = fixture();
    let path = dir.path().join("attachment.txt");
    std::fs::write(&path, "sample").unwrap();
    let file = db.run(|c| repo::register_attachment(c, &path)).unwrap();
    assert_eq!(file.size, 6);
    db.run(|c| {
        let col = collection(c);
        let mut doc = request(c, &col.id, None);
        doc.body_kind = "multipart".into();
        doc.form_data.push(FormField {
            id: uuid::Uuid::new_v4().to_string(),
            enabled: true,
            name: "file".into(),
            kind: "file".into(),
            value: String::new(),
            attachment_id: Some(file.id.clone()),
            description: String::new(),
        });
        repo::save_request(c, doc)?;
        Ok(())
    })
    .unwrap();
    let moved = dir.path().join("moved.txt");
    std::fs::rename(path, moved).unwrap();
    drop(db);
    let restored = Database::new(dir.path().join("postmen.sqlite3"));
    let files = restored.run(repo::workspace).unwrap().attachments;
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].id, file.id);
    assert_eq!(files[0].name, "attachment.txt");
    assert_eq!(files[0].size, 6);
    let exposed = serde_json::to_value(&files[0]).unwrap();
    assert!(exposed.get("path").is_none());
    assert!(exposed.get("available").is_none());
}
#[test]
fn arbitrary_attachment_ids_and_invalid_variable_names_are_rejected() {
    let (_dir, db) = fixture();
    db.run(|c| {
        for name in ["invalid name", "<<name>>", "1name"] {
            assert!(super::environments::save(
                c,
                SaveEnvironment {
                    id: None,
                    collection_id: None,
                    name: "Bad".into(),
                    variables: vec![row(name, "value")],
                    revision: None,
                }
            )
            .is_err());
        }
        let col = collection(c);
        let mut r = request(c, &col.id, None);
        r.form_data.push(FormField {
            id: uuid::Uuid::new_v4().to_string(),
            enabled: true,
            name: "file".into(),
            kind: "file".into(),
            value: String::new(),
            attachment_id: Some(uuid::Uuid::new_v4().to_string()),
            description: String::new(),
        });
        assert!(repo::save_request(c, r).is_err());
        Ok(())
    })
    .unwrap();
}

#[test]
fn request_validation_limits_do_not_modify_saved_record() {
    let (_dir, db) = fixture();
    db.run(|c| {
        let col = collection(c);
        let original = request(c, &col.id, None);
        let mut oversized = original.clone();
        oversized.body = "x".repeat(2 * 1024 * 1024 + 1);
        assert_eq!(
            repo::save_request(c, oversized).unwrap_err().code,
            "LIMIT_EXCEEDED"
        );
        let mut too_many = original.clone();
        too_many.params = (0..501).map(|_| row("q", "x")).collect();
        assert_eq!(
            repo::save_request(c, too_many).unwrap_err().code,
            "LIMIT_EXCEEDED"
        );
        let mut duplicates = original.clone();
        let same = row("q", "x");
        duplicates.headers = vec![same.clone(), same];
        assert_eq!(
            repo::save_request(c, duplicates).unwrap_err().code,
            "INVALID_INPUT"
        );
        let mut invalid = original.clone();
        invalid.url = "https://example.test/\r\n".into();
        assert_eq!(
            repo::save_request(c, invalid).unwrap_err().code,
            "INVALID_INPUT"
        );
        let saved = repo::get_request(c, &original.id)?;
        assert_eq!(saved.revision, original.revision);
        assert!(saved.body.is_empty());
        assert!(saved.headers.is_empty());
        Ok(())
    })
    .unwrap();
}

#[test]
fn session_validation_rejects_invalid_sizes_without_erasing_previous_state() {
    let (_dir, db) = fixture();
    db.run(|c| {
        let col = collection(c);
        let request = request(c, &col.id, None);
        let original = Session {
            tab_ids: vec![request.id.clone()],
            active_id: Some(request.id.clone()),
            views: Default::default(),
        };
        repo::save_session(c, original)?;
        let too_many = Session {
            tab_ids: (0..101).map(|_| uuid::Uuid::new_v4().to_string()).collect(),
            ..Session::default()
        };
        assert_eq!(
            repo::save_session(c, too_many).unwrap_err().code,
            "LIMIT_EXCEEDED"
        );
        assert_eq!(repo::workspace(c)?.session.active_id, Some(request.id));
        Ok(())
    })
    .unwrap();
}

#[test]
fn last_execution_survives_reopen_replacement_history_pruning_and_failed_write() {
    use crate::execution::models::{ExecutionResult, ResponseHeader};
    let (dir, db) = fixture();
    let request_id = db.run(|c| {
        let col = collection(c);
        let doc = request(c, &col.id, None);
        assert!(repo::get_last_execution(c, &doc.id)?.is_none());
        let mut result = ExecutionResult::empty(&uuid::Uuid::new_v4().to_string(), &doc.id);
        result.status = Some(200);
        result.body = "日本語\nbody".into();
        result.preview_bytes = result.body.len();
        result.headers = vec![ResponseHeader { name: "x-test".into(), value: "one".into() }, ResponseHeader { name: "x-test".into(), value: "two".into() }];
        repo::save_last_execution(c, &result, 123)?;
        result.body = "replacement".into();
        result.preview_bytes = result.body.len();
        repo::save_last_execution(c, &result, 456)?;
        for _ in 0..501 {
            let history = ExecutionResult::empty(&uuid::Uuid::new_v4().to_string(), &doc.id);
            repo::record_execution(c, &history, "GET")?;
        }
        assert_eq!(c.query_row("SELECT count(*) FROM request_history", [], |r| r.get::<_, i64>(0))?, 500);
        c.execute_batch("CREATE TRIGGER fail_snapshot BEFORE UPDATE ON last_executions BEGIN SELECT RAISE(ABORT,'failure'); END;")?;
        result.body = "failed".into();
        result.preview_bytes = result.body.len();
        assert!(repo::save_last_execution(c, &result, 789).is_err());
        Ok(doc.id)
    }).unwrap();
    drop(db);
    let db = Database::new(dir.path().join("postmen.sqlite3"));
    db.run(|c| {
        let snapshot = repo::get_last_execution(c, &request_id)?.unwrap();
        assert_eq!(snapshot.completed_at, 456);
        assert_eq!(snapshot.result.body, "replacement");
        assert_eq!(snapshot.result.headers[1].value, "two");
        c.execute("DELETE FROM requests WHERE id=?1", [&request_id])?;
        assert!(repo::get_last_execution(c, &request_id)?.is_none());
        Ok(())
    })
    .unwrap();
}

#[test]
fn schema_two_upgrade_preserves_requests_and_session() {
    let (dir, _) = fixture();
    let path = dir.path().join("postmen.sqlite3");
    let mut conn = Connection::open(&path).unwrap();
    conn.pragma_update(None, "foreign_keys", true).unwrap();
    conn.execute_batch(include_str!("schema.sql")).unwrap();
    conn.execute_batch(include_str!("environments.sql"))
        .unwrap();
    conn.pragma_update(None, "application_id", super::APPLICATION_ID)
        .unwrap();
    conn.pragma_update(None, "user_version", 2).unwrap();
    let col = collection(&mut conn);
    let doc = request(&mut conn, &col.id, None);
    conn.execute(
        "INSERT INTO app_settings VALUES ('session', '{\"kept\":true}')",
        [],
    )
    .unwrap();
    drop(conn);
    let db = Database::new(path);
    db.run(|c| {
        assert_eq!(
            c.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))?,
            3
        );
        assert_eq!(repo::get_request(c, &doc.id)?.id, doc.id);
        assert_eq!(
            c.query_row(
                "SELECT value_json FROM app_settings WHERE key='session'",
                [],
                |r| r.get::<_, String>(0)
            )?,
            "{\"kept\":true}"
        );
        assert!(repo::get_last_execution(c, &doc.id)?.is_none());
        Ok(())
    })
    .unwrap();
}

#[test]
fn malformed_last_execution_is_an_error_and_deleted_requests_are_not_recreated() {
    use crate::execution::models::ExecutionResult;
    let (_dir, db) = fixture();
    db.run(|c| {
        let col = collection(c);
        let doc = request(c, &col.id, None);
        let mut result = ExecutionResult::empty(&uuid::Uuid::new_v4().to_string(), &doc.id);
        result.status = Some(204);
        repo::save_last_execution(c, &result, 123)?;
        c.execute(
            "UPDATE last_executions SET result_json='{}' WHERE request_id=?1",
            [&doc.id],
        )?;
        assert!(repo::get_last_execution(c, &doc.id).is_err());
        c.execute("DELETE FROM requests WHERE id=?1", [&doc.id])?;
        repo::save_last_execution(c, &result, 456)?;
        assert!(repo::get_last_execution(c, &doc.id)?.is_none());
        Ok(())
    })
    .unwrap();
}

#[test]
fn failed_schema_upgrade_rolls_back_without_changing_existing_data() {
    let (dir, _) = fixture();
    let path = dir.path().join("postmen.sqlite3");
    let mut conn = Connection::open(&path).unwrap();
    conn.execute_batch(include_str!("schema.sql")).unwrap();
    conn.execute_batch(include_str!("environments.sql"))
        .unwrap();
    conn.execute_batch(
        "CREATE TABLE last_executions (marker TEXT); INSERT INTO last_executions VALUES ('keep');",
    )
    .unwrap();
    conn.pragma_update(None, "application_id", super::APPLICATION_ID)
        .unwrap();
    conn.pragma_update(None, "user_version", 2).unwrap();
    let col = collection(&mut conn);
    drop(conn);
    assert!(Database::new(path.clone()).run(|_| Ok(())).is_err());
    let conn = Connection::open(path).unwrap();
    assert_eq!(
        conn.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert_eq!(
        conn.query_row("SELECT marker FROM last_executions", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "keep"
    );
    assert_eq!(
        conn.query_row("SELECT name FROM collections WHERE id=?1", [&col.id], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "API"
    );
}

#[test]
fn snapshot_boundary_rejects_corrupt_payloads_and_accepts_expanded_previews() {
    use crate::execution::models::{ExecutionResult, ResponseHeader};
    let (_dir, db) = fixture();
    db.run(|c| {
        let col = collection(c);
        let doc = request(c, &col.id, None);
        let mut value = ExecutionResult::empty(&uuid::Uuid::new_v4().to_string(), &doc.id);
        value.status = Some(200);
        value.preview_bytes = 1024 * 1024;
        value.body = "�".repeat(value.preview_bytes);
        value.headers = vec![ResponseHeader {
            name: "x-test".into(),
            value: "value".into(),
        }];
        repo::save_last_execution(c, &value, 1)?;
        assert_eq!(
            repo::get_last_execution(c, &doc.id)?.unwrap().result.body,
            value.body
        );
        let mut invalid = value.clone();
        invalid.headers = (0..1001)
            .map(|_| ResponseHeader {
                name: "x".into(),
                value: "v".into(),
            })
            .collect();
        assert!(repo::save_last_execution(c, &invalid, 2).is_err());
        invalid = value.clone();
        invalid.status = Some(42);
        assert!(repo::save_last_execution(c, &invalid, 2).is_err());
        invalid = value.clone();
        invalid.request_id = "invalid".into();
        assert!(repo::save_last_execution(c, &invalid, 2).is_err());
        invalid = value.clone();
        invalid.body.push('x');
        assert!(repo::save_last_execution(c, &invalid, 2).is_err());
        invalid = value.clone();
        invalid.outcome = "cancelled".into();
        c.execute(
            "UPDATE last_executions SET result_json=?1 WHERE request_id=?2",
            rusqlite::params![serde_json::to_string(&invalid).unwrap(), doc.id],
        )?;
        assert!(repo::get_last_execution(c, &doc.id).is_err());
        Ok(())
    })
    .unwrap();
}
