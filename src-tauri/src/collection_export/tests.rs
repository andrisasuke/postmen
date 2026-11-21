use super::*;
use crate::{
    db::{environments, repository as repo},
    models::*,
};
use serde_json::{json, Value};

fn database() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(include_str!("../db/schema.sql"))
        .unwrap();
    conn.execute_batch(include_str!("../db/environments.sql"))
        .unwrap();
    conn
}
fn collection(conn: &mut Connection, name: &str) -> Collection {
    repo::create_collection(conn, CreateCollection { name: name.into() }).unwrap()
}
fn param(name: &str, value: &str) -> KeyValue {
    KeyValue {
        id: uuid::Uuid::new_v4().to_string(),
        enabled: true,
        name: name.into(),
        value: value.into(),
        description: "Description".into(),
    }
}
fn request(conn: &mut Connection, id: &str, folder_id: Option<String>) -> RequestDoc {
    let mut doc = repo::create_request(
        conn,
        CreateRequest {
            collection_id: id.into(),
            folder_id,
            name: "GET items".into(),
            content: None,
        },
    )
    .unwrap();
    doc.url = "<<api_url>>/items?q=first#fragment".into();
    doc.params = vec![
        param("q", "second"),
        param("<<key>>", "<<value>>"),
        KeyValue {
            enabled: false,
            ..param("off", "kept")
        },
    ];
    doc.headers = vec![param("Authorization", "Bearer <<token>>")];
    repo::save_request(conn, doc).unwrap()
}
fn prepared(conn: &mut Connection, exports: &Exports, ids: Vec<String>) -> Preview {
    exports
        .prepare(
            conn,
            Prepare {
                collection_ids: ids,
                include_variables: false,
            },
        )
        .unwrap()
}
fn commit(preview: &Preview, overwrite: bool) -> Commit {
    Commit {
        token: preview.token.clone(),
        files: preview
            .files
            .iter()
            .map(|file| FileName {
                id: file.id.clone(),
                name: file.file_name.clone(),
            })
            .collect(),
        overwrite,
    }
}

#[test]
fn exports_nested_requests_with_structured_urls_variables_duplicates_and_disabled_rows() {
    let mut conn = database();
    let col = collection(&mut conn, "Example");
    let parent = repo::create_folder(
        &mut conn,
        CreateFolder {
            collection_id: col.id.clone(),
            parent_id: None,
            name: "Parent".into(),
        },
    )
    .unwrap();
    let child = repo::create_folder(
        &mut conn,
        CreateFolder {
            collection_id: col.id.clone(),
            parent_id: Some(parent.id),
            name: "Child".into(),
        },
    )
    .unwrap();
    let source = request(&mut conn, &col.id, Some(child.id));
    let document = format::collection(&conn, &col.id, false).unwrap();
    let value: Value = serde_json::from_slice(&document.bytes).unwrap();
    assert!(value["info"]["schema"].as_str().unwrap().contains("v2.1.0"));
    let req = &value["item"][0]["item"][0]["item"][0]["request"];
    assert_eq!(req["url"]["host"], json!(["{{api_url}}"]));
    assert_eq!(req["url"]["path"], json!(["items"]));
    assert_eq!(req["url"]["query"].as_array().unwrap().len(), 4);
    assert_eq!(req["url"]["query"][3]["disabled"], true);
    assert_eq!(
        req["url"]["raw"],
        "{{api_url}}/items?q=first&q=second&{{key}}={{value}}#fragment"
    );
    assert_eq!(req["header"][0]["value"], "Bearer {{token}}");
    assert_eq!(
        repo::get_request(&conn, &source.id).unwrap().url,
        source.url
    );
    // Uses the existing backend importer without external apps, network or user DBs.
    crate::collection_import::Imports::default()
        .stage(&document.bytes)
        .unwrap();
}

#[test]
fn selected_collection_variables_override_global_and_unselected_values_are_excluded() {
    let mut conn = database();
    let col = collection(&mut conn, "Variables");
    request(&mut conn, &col.id, None);
    for (scope, value) in [(None, "global"), (Some(col.id.clone()), "collection")] {
        let env = environments::save(
            &mut conn,
            SaveEnvironment {
                id: None,
                collection_id: scope.clone(),
                name: "Selected".into(),
                variables: vec![param("api_url", value)],
                revision: None,
            },
        )
        .unwrap();
        environments::select(
            &mut conn,
            EnvironmentSelection {
                collection_id: scope,
                environment_id: Some(env.id),
            },
        )
        .unwrap();
    }
    environments::save(
        &mut conn,
        SaveEnvironment {
            id: None,
            collection_id: Some(col.id.clone()),
            name: "Other".into(),
            variables: vec![param("private", "NOT_EXPORTED")],
            revision: None,
        },
    )
    .unwrap();
    let included = format::collection(&conn, &col.id, true).unwrap();
    let json: Value = serde_json::from_slice(&included.bytes).unwrap();
    assert_eq!(json["variable"].as_array().unwrap().len(), 1);
    assert_eq!(json["variable"][0]["value"], "collection");
    assert!(!String::from_utf8(included.bytes)
        .unwrap()
        .contains("NOT_EXPORTED"));
    let excluded = format::collection(&conn, &col.id, false).unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&excluded.bytes).unwrap()["variable"],
        json!([])
    );
}

#[test]
fn preserves_invalid_raw_bodies_and_multipart_without_reading_attachment_paths() {
    let mut conn = database();
    let col = collection(&mut conn, "Body");
    let mut doc = request(&mut conn, &col.id, None);
    doc.body_kind = "json".into();
    let invalid = "{\"literal\":\"<<not_substituted>>\"}\n{}";
    doc.body = invalid.into();
    repo::save_request(&mut conn, doc.clone()).unwrap();
    let value: Value =
        serde_json::from_slice(&format::collection(&conn, &col.id, false).unwrap().bytes).unwrap();
    assert_eq!(value["item"][0]["request"]["body"]["raw"], invalid);
    assert_eq!(
        value["item"][0]["request"]["header"][1]["value"],
        "application/json"
    );
    doc = repo::get_request(&conn, &doc.id).unwrap();
    let commented = "{\n  /* saved note */\n  \"literal\":\"<<not_substituted>>\",\n  \"name\":\"test/* */\"\n}";
    doc.body = commented.into();
    repo::save_request(&mut conn, doc.clone()).unwrap();
    let value: Value =
        serde_json::from_slice(&format::collection(&conn, &col.id, false).unwrap().bytes).unwrap();
    assert_eq!(
        value["item"][0]["request"]["body"]["raw"],
        "{\n  \"literal\": \"<<not_substituted>>\",\n  \"name\": \"test/* */\"\n}"
    );
    assert_eq!(
        value["item"][0]["request"]["header"][1]["value"],
        "application/json"
    );
    doc = repo::get_request(&conn, &doc.id).unwrap();
    assert_eq!(doc.body, commented);
    doc.body_kind = "multipart".into();
    doc.form_data = vec![FormField {
        id: uuid::Uuid::new_v4().to_string(),
        enabled: true,
        name: "upload".into(),
        kind: "file".into(),
        value: "DO_NOT_READ_LOCAL_PATH".into(),
        attachment_id: None,
        description: "File".into(),
    }];
    repo::save_request(&mut conn, doc).unwrap();
    let document = format::collection(&conn, &col.id, false).unwrap();
    assert!(!String::from_utf8(document.bytes.clone())
        .unwrap()
        .contains("DO_NOT_READ_LOCAL_PATH"));
    assert!(!document.warnings.is_empty());
    let value: Value = serde_json::from_slice(&document.bytes).unwrap();
    assert_eq!(
        value["item"][0]["request"]["body"]["formdata"][0]["src"],
        json!([])
    );
}

#[test]
fn cleans_export_copy_only_for_string_json_bodies_with_padding_or_comments() {
    let mut conn = database();
    let col = collection(&mut conn, "Export body policy");
    let mut doc = request(&mut conn, &col.id, None);
    doc.body_kind = "json".into();
    let padded = "{\"a\":1,\n  \n\"b\":2}";
    let clean = "{\n  \"a\": 1,\n  \"b\": 2\n}";
    let cases: [(&str, Option<&str>, &str); 4] = [
        (padded, None, clean),
        (padded, Some("application/json"), clean),
        (padded, Some("text/plain"), padded),
        ("{\"a\":1}", None, "{\"a\":1}"),
    ];
    for (body, content_type, expected) in cases {
        doc.body = body.into();
        doc.headers = content_type
            .map(|value| vec![param("Content-Type", value)])
            .unwrap_or_default();
        doc = repo::save_request(&mut conn, doc).unwrap();
        let value: Value =
            serde_json::from_slice(&format::collection(&conn, &col.id, false).unwrap().bytes)
                .unwrap();
        assert_eq!(
            value["item"][0]["request"]["body"]["raw"], expected,
            "{content_type:?}"
        );
        assert_eq!(repo::get_request(&conn, &doc.id).unwrap().body, body);
    }

    let unfinished = "{\"a\":1}/* unfinished PRIVATE_TAIL";
    for (body, content_type) in [
        (unfinished, None),
        (unfinished, Some("application/json")),
        ("{\"a\":1,\n  \n", None),
        ("{\"a\":1,\n  \n", Some("application/json")),
        ("{\n  /* note */\n  \"a\":1\n}", Some("text/plain")),
    ] {
        doc.body = body.into();
        doc.headers = content_type
            .map(|value| vec![param("Content-Type", value)])
            .unwrap_or_default();
        doc = repo::save_request(&mut conn, doc).unwrap();
        let value: Value =
            serde_json::from_slice(&format::collection(&conn, &col.id, false).unwrap().bytes)
                .unwrap();
        assert_eq!(
            value["item"][0]["request"]["body"]["raw"], body,
            "{content_type:?}"
        );
    }

    doc.body = "{\n  /* note */\n  \"a\":1\n}".into();
    doc.headers = vec![
        param("Content-Type", "application/json"),
        param("Content-Type", "application/json"),
    ];
    repo::save_request(&mut conn, doc).unwrap();
    let value: Value =
        serde_json::from_slice(&format::collection(&conn, &col.id, false).unwrap().bytes).unwrap();
    assert_eq!(
        value["item"][0]["request"]["body"]["raw"],
        "{\n  /* note */\n  \"a\":1\n}"
    );
}

#[test]
fn preserves_export_bodies_when_placeholders_make_media_type_uncertain() {
    let mut conn = database();
    let col = collection(&mut conn, "Export placeholder policy");
    let mut doc = request(&mut conn, &col.id, None);
    doc.body_kind = "json".into();
    let body = "{\n  /* note */\n  \"name\":\"test/* */\"\n}";
    let clean = "{\n  \"name\": \"test/* */\"\n}";
    let mut disabled_dynamic = param("<<mediaHeader>>", "text/plain");
    disabled_dynamic.enabled = false;
    let cases: [(Vec<KeyValue>, &str); 4] = [
        (
            vec![
                param("<<mediaHeader>>", "text/plain"),
                param("Content-Type", "application/json"),
            ],
            body,
        ),
        (
            vec![
                disabled_dynamic.clone(),
                param("Content-Type", "application/json"),
            ],
            clean,
        ),
        (vec![param("Content-Type", "<<mediaType>>")], body),
        (
            vec![param(
                "Content-Type",
                "application/vnd.api+json; profile=\"a,b\"",
            )],
            clean,
        ),
    ];
    for (headers, expected) in cases {
        doc.body = body.into();
        doc.headers = headers;
        doc = repo::save_request(&mut conn, doc).unwrap();
        let value: Value =
            serde_json::from_slice(&format::collection(&conn, &col.id, false).unwrap().bytes)
                .unwrap();
        assert_eq!(value["item"][0]["request"]["body"]["raw"], expected);
        assert_eq!(repo::get_request(&conn, &doc.id).unwrap().body, body);
    }
    doc.body = body.into();
    doc.headers = vec![
        param("<<mediaHeader>>", "text/plain"),
        param("Content-Type", "application/json"),
    ];
    repo::save_request(&mut conn, doc).unwrap();
    let value: Value =
        serde_json::from_slice(&format::collection(&conn, &col.id, false).unwrap().bytes).unwrap();
    assert!(value["item"][0]["request"]["header"]
        .as_array()
        .unwrap()
        .iter()
        .any(|header| header["key"] == "{{mediaHeader}}" && header["value"] == "text/plain"));
    assert!(value["item"][0]["request"]["header"]
        .as_array()
        .unwrap()
        .iter()
        .any(|header| header["key"] == "Content-Type" && header["value"] == "application/json"));
}

#[test]
fn imported_legacy_comment_padding_is_cleaned_only_in_the_export_copy() {
    let mut conn = database();
    let imports = crate::collection_import::Imports::default();
    let raw = "{\n  /* old */\n  \"name\": \"test/* */\"\n}";
    let source = json!({
        "info": {"name": "Imported legacy", "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},
        "item": [{"name": "Legacy request", "request": {
            "method": "POST",
            "url": "https://example.test/legacy",
            "body": {"mode": "raw", "raw": raw}
        }}]
    });
    let preview = imports
        .stage(&serde_json::to_vec(&source).unwrap())
        .unwrap();
    let token = serde_json::to_value(&preview).unwrap()["token"]
        .as_str()
        .unwrap()
        .to_string();
    let outcome = imports
        .commit(
            &mut conn,
            crate::collection_import::Commit {
                token,
                mode: crate::collection_import::Mode::Create,
                target_id: None,
            },
        )
        .unwrap();
    let (collection_id, workspace) = match outcome {
        crate::collection_import::Outcome::Imported {
            collection_id,
            workspace,
            ..
        } => (collection_id, workspace),
        _ => panic!("expected import"),
    };
    let request_id = workspace
        .requests
        .iter()
        .find(|request| request.name == "Legacy request")
        .unwrap()
        .id
        .clone();
    let stored = repo::get_request(&conn, &request_id).unwrap();
    assert!(crate::body_payload::has_padded_blank_line(&stored.body));
    assert!(!stored.body.contains("/* old */"));
    let exported: Value = serde_json::from_slice(
        &format::collection(&conn, &collection_id, false)
            .unwrap()
            .bytes,
    )
    .unwrap();
    assert_eq!(
        exported["item"][0]["request"]["body"]["raw"],
        "{\n  \"name\": \"test/* */\"\n}"
    );
    assert_eq!(
        repo::get_request(&conn, &request_id).unwrap().body,
        stored.body
    );
}

#[test]
fn imported_padding_with_all_line_endings_flows_through_send_curl_and_export() {
    let mut conn = database();
    let imports = crate::collection_import::Imports::default();
    let bodies = [
        ("LF", "{\n  /* note */\n  \"a\":\"test/* */\"\n}"),
        ("CR", "{\r  /* note */\r  \"a\":\"test/* */\"\r}"),
        ("CRLF", "{\r\n  /* note */\r\n  \"a\":\"test/* */\"\r\n}"),
        ("No trigger", "{\"a\":\"test/* */\"}"),
        ("Invalid", "{\"a\":1}/* note */ trailing"),
        ("Unfinished", "{\"a\":1}/* unfinished PRIVATE_TAIL"),
    ];
    let source = json!({
        "info": {"name": "Imported line endings", "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},
        "item": bodies.iter().map(|(name, raw)| json!({
            "name": name,
            "request": {
                "method": "POST",
                "url": "https://example.test/line-endings",
                "body": {"mode": "raw", "raw": raw}
            }
        })).collect::<Vec<_>>()
    });
    let preview = imports
        .stage(&serde_json::to_vec(&source).unwrap())
        .unwrap();
    let token = serde_json::to_value(&preview).unwrap()["token"]
        .as_str()
        .unwrap()
        .to_string();
    let outcome = imports
        .commit(
            &mut conn,
            crate::collection_import::Commit {
                token,
                mode: crate::collection_import::Mode::Create,
                target_id: None,
            },
        )
        .unwrap();
    let (collection_id, workspace) = match outcome {
        crate::collection_import::Outcome::Imported {
            collection_id,
            workspace,
            ..
        } => (collection_id, workspace),
        _ => panic!("expected import"),
    };
    let exported_collection: Value = serde_json::from_slice(
        &format::collection(&conn, &collection_id, false)
            .unwrap()
            .bytes,
    )
    .unwrap();
    let item = |name: &str| {
        exported_collection["item"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["name"] == name)
            .unwrap()
            .clone()
    };
    let clean = "{\n  \"a\": \"test/* */\"\n}";
    for (name, _raw) in bodies {
        let id = workspace
            .requests
            .iter()
            .find(|request| request.name == name)
            .unwrap()
            .id
            .clone();
        let doc = repo::get_request(&conn, &id).unwrap();
        let stored = doc.body.clone();
        assert_eq!(doc.body_kind, "json", "{name}");
        if name == "LF" || name == "CR" || name == "CRLF" {
            assert!(
                crate::body_payload::has_padded_blank_line(&stored),
                "{name}"
            );
            assert!(!stored.contains("/* note */"), "{name}");
        }
        let headers = crate::execution::http::headers(&doc).unwrap();
        if name == "Unfinished" {
            let error = crate::execution::http::json_payload(&doc, &headers).unwrap_err();
            assert_eq!(error.code, "INVALID_INPUT", "{name}");
            let error = crate::generate_curl::generate(&conn, doc.clone()).unwrap_err();
            assert_eq!(error.code, "INVALID_INPUT", "{name}");
        } else {
            let sent = crate::execution::http::json_payload(&doc, &headers)
                .unwrap()
                .into_owned();
            let expected = if name == "LF" || name == "CR" || name == "CRLF" {
                clean
            } else {
                stored.as_str()
            };
            assert_eq!(sent, expected, "{name}");
            let code = crate::generate_curl::generate(&conn, doc.clone())
                .unwrap()
                .code;
            assert_eq!(
                crate::test_support::curl_payload(&code),
                sent.as_bytes(),
                "{name}"
            );
        }
        assert_eq!(item(name)["request"]["body"]["raw"], stored, "{name}");
        assert_eq!(
            repo::get_request(&conn, &id).unwrap().body,
            stored,
            "{name}"
        );
    }
}

#[test]
fn safe_unique_filenames_and_selection_validation() {
    for name in [
        "", "../file", "a/b", "a\\b", "CON", "NUL.json", ".", "..", "name.", "a\nfile",
    ] {
        assert!(filename(name).is_err(), "{name:?}");
    }
    assert_eq!(filename("Example.json").unwrap(), "Example.json");
    let mut conn = database();
    let first = collection(&mut conn, "Same");
    let second = collection(&mut conn, "Same");
    let exports = Exports::default();
    let preview = prepared(&mut conn, &exports, vec![first.id.clone(), second.id]);
    assert_eq!(preview.files[0].file_name, "Same");
    assert_eq!(preview.files[1].file_name, "Same_1");
    assert!(exports.commit(commit(&preview, false)).is_err()); // No picker grant.
    assert!(exports
        .prepare(
            &mut conn,
            Prepare {
                collection_ids: vec![first.id.clone(), first.id],
                include_variables: false
            }
        )
        .is_err());
    assert!(exports.validate_token(&preview.token).is_err());
}

#[test]
fn no_file_is_written_until_conflicts_are_explicitly_confirmed() {
    let mut conn = database();
    let col = collection(&mut conn, "Existing");
    let exports = Exports::default();
    let preview = prepared(&mut conn, &exports, vec![col.id]);
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("Existing.json"), "old content").unwrap();
    exports.set_directory(&preview.token, dir.path()).unwrap();
    // Even an unsolicited overwrite=true must first produce a conflict preview.
    assert!(matches!(
        exports.commit(commit(&preview, true)).unwrap(),
        Outcome::Conflict { .. }
    ));
    assert_eq!(
        std::fs::read_to_string(dir.path().join("Existing.json")).unwrap(),
        "old content"
    );
    // Changed targets require fresh consent.
    std::fs::write(
        dir.path().join("Existing.json"),
        "changed contents with new length",
    )
    .unwrap();
    assert!(matches!(
        exports.commit(commit(&preview, true)).unwrap(),
        Outcome::Conflict { .. }
    ));
    assert!(
        matches!(exports.commit(commit(&preview,true)).unwrap(),Outcome::Exported{written,failed} if written.len() == 1 && failed.is_empty())
    );
    let value: Value =
        serde_json::from_slice(&std::fs::read(dir.path().join("Existing.json")).unwrap()).unwrap();
    assert_eq!(value["info"]["name"], "Existing");
    assert!(exports.validate_token(&preview.token).is_err());
}

#[test]
fn cancellation_and_expiry_invalidate_export_tokens() {
    let mut conn = database();
    let col = collection(&mut conn, "Cancel");
    let exports = Exports::default();
    let preview = prepared(&mut conn, &exports, vec![col.id.clone()]);
    exports.discard(&preview.token).unwrap();
    assert!(exports.validate_token(&preview.token).is_err());
    let preview = prepared(&mut conn, &exports, vec![col.id]);
    exports.0.lock().unwrap().as_mut().unwrap().at = Instant::now() - Duration::from_secs(901);
    assert!(exports.validate_token(&preview.token).is_err());
}

#[test]
fn a_batch_checks_all_conflicts_before_writing_and_reprompts_after_browse() {
    let mut conn = database();
    let fresh = collection(&mut conn, "Fresh");
    let existing = collection(&mut conn, "Existing");
    let exports = Exports::default();
    let preview = prepared(&mut conn, &exports, vec![fresh.id, existing.id]);
    let first = tempfile::tempdir().unwrap();
    std::fs::write(first.path().join("Existing.json"), "keep first").unwrap();
    exports.set_directory(&preview.token, first.path()).unwrap();
    assert!(matches!(
        exports.commit(commit(&preview, false)).unwrap(),
        Outcome::Conflict { .. }
    ));
    assert!(!first.path().join("Fresh.json").exists());
    let second = tempfile::tempdir().unwrap();
    std::fs::write(second.path().join("Existing.json"), "keep second").unwrap();
    exports
        .set_directory(&preview.token, second.path())
        .unwrap();
    assert!(matches!(
        exports.commit(commit(&preview, true)).unwrap(),
        Outcome::Conflict { .. }
    ));
    assert!(!second.path().join("Fresh.json").exists());
    assert!(
        matches!(exports.commit(commit(&preview, true)).unwrap(), Outcome::Exported { written, failed } if written.len() == 2 && failed.is_empty())
    );
    assert_eq!(
        std::fs::read_to_string(first.path().join("Existing.json")).unwrap(),
        "keep first"
    );
    assert!(second.path().join("Fresh.json").exists());
}

#[test]
fn exports_ipv6_port_unicode_and_query_delimiters_without_lossy_decoding() {
    let mut conn = database();
    let col = collection(&mut conn, "URL");
    let mut doc = request(&mut conn, &col.id, None);
    doc.url = "http://[::1]:8080/a/b?encoded=a%26b%3Dc%2Bd&unicode=%E6%97%A5#frag".into();
    doc.params.clear();
    doc = repo::save_request(&mut conn, doc).unwrap();
    let value: Value =
        serde_json::from_slice(&format::collection(&conn, &col.id, false).unwrap().bytes).unwrap();
    let url = &value["item"][0]["request"]["url"];
    assert_eq!(url["protocol"], "http");
    assert_eq!(url["host"], json!(["[::1]"]));
    assert_eq!(url["port"], "8080");
    assert_eq!(url["path"], json!(["a", "b"]));
    assert_eq!(url["query"][0]["value"], "a&b=c+d");
    assert_eq!(url["query"][1]["value"], "日");
    doc.url = "https://example.test/?q=%FF".into();
    repo::save_request(&mut conn, doc).unwrap();
    assert!(format::collection(&conn, &col.id, false).is_err());
}

#[cfg(unix)]
#[test]
fn refuses_symlink_targets_even_with_overwrite_requested() {
    let mut conn = database();
    let col = collection(&mut conn, "Link");
    let exports = Exports::default();
    let preview = prepared(&mut conn, &exports, vec![col.id]);
    let dir = tempfile::tempdir().unwrap();
    let original = dir.path().join("original.txt");
    std::fs::write(&original, "keep").unwrap();
    std::os::unix::fs::symlink(&original, dir.path().join("Link.json")).unwrap();
    exports.set_directory(&preview.token, dir.path()).unwrap();
    assert!(exports.commit(commit(&preview, true)).is_err());
    assert_eq!(std::fs::read_to_string(original).unwrap(), "keep");
}
