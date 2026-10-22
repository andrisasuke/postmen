use super::*;
use crate::{db::Database, models::*};

fn row(name: &str, value: &str) -> KeyValue {
    KeyValue {
        id: uuid::Uuid::new_v4().to_string(),
        enabled: true,
        name: name.into(),
        value: value.into(),
        description: String::new(),
    }
}
fn field(name: &str, value: &str) -> FormField {
    FormField {
        id: uuid::Uuid::new_v4().to_string(),
        enabled: true,
        name: name.into(),
        value: value.into(),
        kind: "text".into(),
        attachment_id: None,
        description: String::new(),
    }
}
fn fixture(test: impl FnOnce(&mut Connection, RequestDoc)) {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path().join("test.sqlite3"));
    db.run(|conn| {
        let collection = repository::create_collection(
            conn,
            CreateCollection {
                name: "Synthetic API".into(),
            },
        )?;
        let mut request = repository::create_request(
            conn,
            CreateRequest {
                collection_id: collection.id,
                folder_id: None,
                name: "Synthetic request".into(),
                content: None,
            },
        )?;
        request.url = "https://example.test/path".into();
        test(conn, request);
        Ok(())
    })
    .unwrap();
}
fn environment(conn: &mut Connection, collection_id: Option<String>, variables: Vec<KeyValue>) {
    let env = environments::save(
        conn,
        SaveEnvironment {
            id: None,
            collection_id: collection_id.clone(),
            name: "Synthetic".into(),
            variables,
            revision: None,
        },
    )
    .unwrap();
    environments::select(
        conn,
        EnvironmentSelection {
            collection_id,
            environment_id: Some(env.id),
        },
    )
    .unwrap();
}

// Decode the subset of POSIX word syntax emitted by the generator in memory.
// Never start a shell or execute the generated command in tests.
fn arguments(code: &str) -> Vec<String> {
    let mut chars = code.chars().peekable();
    let mut quoted = false;
    let mut started = false;
    let mut word = String::new();
    let mut result = vec![];
    while let Some(c) = chars.next() {
        if c == '\'' {
            quoted = !quoted;
            started = true;
        } else if quoted {
            word.push(c);
        } else if c == '\\' {
            let next = chars.next().expect("complete escape");
            if next != '\n' {
                word.push(next);
                started = true;
            }
        } else if c.is_whitespace() {
            if started {
                result.push(std::mem::take(&mut word));
                started = false;
            }
        } else {
            word.push(c);
            started = true;
        }
    }
    assert!(!quoted, "balanced POSIX quotes");
    if started {
        result.push(word);
    }
    result
}

#[test]
fn exports_all_methods_and_head_without_body() {
    fixture(|conn, mut doc| {
        for method in ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] {
            doc.method = method.into();
            let code = generate(conn, doc.clone()).unwrap().code;
            assert!(code.starts_with("curl --globoff \\\n  "));
            assert!(code.contains(&format!("--request '{method}'")));
            assert_eq!(code.contains("--head"), method == "HEAD");
            assert!(!code.contains("--data"));
        }
    });
}

#[test]
fn composes_inline_and_repeated_params_once_and_skips_inactive_rows() {
    fixture(|conn, mut doc| {
        doc.url = "https://example.test/path?a=inline#fragment".into();
        let mut disabled = row("ignored", "<<missing>>");
        disabled.enabled = false;
        doc.params = vec![
            row("a", "first"),
            row("a", "second value"),
            row("", "blank"),
            disabled,
        ];
        let code = generate(conn, doc).unwrap().code;
        assert!(code.contains("--url 'https://example.test/path?a=inline&a=first&a=second+value'"));
        assert!(!code.contains("fragment"));
        assert!(!code.contains("ignored"));
    });
}

#[test]
fn preserves_repeated_empty_headers_and_content_type_rules() {
    fixture(|conn, mut doc| {
        let mut disabled = row("Invalid Header", "\n");
        disabled.enabled = false;
        doc.headers = vec![
            row("X-Repeat", "one"),
            row("X-Repeat", ""),
            row("X-Repeat", "two's"),
            row("X-Whitespace", " \tkeep trailing \t "),
            row("", "blank"),
            disabled,
        ];
        doc.body_kind = "json".into();
        doc.body = "raw body".into();
        let code = generate(conn, doc.clone()).unwrap().code;
        assert_eq!(code.matches("--header 'x-repeat").count(), 3);
        let args = arguments(&code);
        let repeated: Vec<_> = args
            .windows(2)
            .filter(|pair| pair[0] == "--header" && pair[1].starts_with("x-repeat"))
            .map(|pair| pair[1].as_str())
            .collect();
        assert_eq!(repeated, ["x-repeat: one", "x-repeat;", "x-repeat: two's"]);
        assert!(code.contains("--header 'x-repeat;'"));
        assert!(code.contains("--header 'x-repeat: two'\\''s'"));
        assert!(code.contains("--header 'content-type: application/json'"));
        assert!(arguments(&code).contains(&"x-whitespace:  \tkeep trailing \t ".to_string()));
        doc.headers.push(row("Content-Type", "text/plain"));
        let code = generate(conn, doc).unwrap().code;
        assert!(code.contains("content-type: text/plain"));
        assert!(!code.contains("application/json"));
    });
}

#[test]
fn retains_raw_json_whitespace_newlines_apostrophes_and_shell_literals() {
    fixture(|conn, mut doc| {
        doc.body_kind = "json".into();
        for body in [
            " \n{\"name\": \"O'Reilly 日本語\"}\n  ",
            "@file\n$(secret) `command` \\\n raw",
            "raw\r\nCRLF\rstandalone carriage return",
            "",
        ] {
            doc.body = body.into();
            let args = arguments(&generate(conn, doc.clone()).unwrap().code);
            assert_eq!(args[args.len() - 2], "--data-raw");
            assert_eq!(args.last().unwrap(), body);
        }
    });
}

#[test]
fn resolves_collection_over_global_but_keeps_body_and_form_values_literal() {
    fixture(|conn, mut doc| {
        environment(
            conn,
            None,
            vec![
                row("host", "https://global.test"),
                row("token", "synthetic-global-token"),
                row("key", "global"),
            ],
        );
        environment(
            conn,
            Some(doc.collection_id.clone()),
            vec![
                row("host", "https://collection.test"),
                row("token", "synthetic-full-collection-token"),
            ],
        );
        doc.url = "<<host>>/users".into();
        doc.params = vec![row("<<key>>", "<<token>>")];
        doc.headers = vec![
            row("Authorization", "Bearer <<token>>"),
            row("X-<<key>>", "<<key>>"),
        ];
        doc.body_kind = "json".into();
        doc.body = "<<missing>>".into();
        let code = generate(conn, doc.clone()).unwrap().code;
        assert!(
            code.contains("https://collection.test/users?global=synthetic-full-collection-token")
        );
        assert!(code.contains("authorization: Bearer synthetic-full-collection-token"));
        assert!(code.contains("x-global: global"));
        assert!(code.ends_with("--data-raw '<<missing>>'"));
        doc.body_kind = "multipart".into();
        doc.form_data = vec![field("<<missing>>", "<<missing>>")];
        assert!(generate(conn, doc)
            .unwrap()
            .code
            .contains("--form-string '<<missing>>=<<missing>>'"));
    });
}

#[test]
fn exports_multipart_text_and_original_file_paths_with_two_layers_of_quoting() {
    fixture(|conn, mut doc| {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("file ,;\"\\ O'Reilly 日本語.txt");
        std::fs::write(&path, "synthetic").unwrap();
        let attachment = repository::register_attachment(conn, &path).unwrap();
        let mut file = field("upload ;,\"\\' 日本語", "ignored");
        file.kind = "file".into();
        file.attachment_id = Some(attachment.id);
        let mut disabled = field("disabled", "");
        disabled.kind = "file".into();
        disabled.enabled = false;
        doc.body_kind = "multipart".into();
        doc.headers = vec![row("Content-Type", "manually supplied")];
        doc.form_data = vec![
            field("text ;,\"\\' 日本語", "@file;<literal>\n$(command)'"),
            file,
            disabled,
            field("", "ignored"),
        ];
        let code = generate(conn, doc).unwrap().code;
        assert!(!code.contains("content-type"));
        assert_eq!(code.matches("--form-string").count(), 1);
        assert_eq!(code.matches("--form ").count(), 1);
        assert!(code.contains(&format!(
            "--form-string {}",
            quote("text ;,\"\\' 日本語=@file;<literal>\n$(command)'")
        )));
        let path = path.canonicalize().unwrap();
        let escaped = path
            .to_str()
            .unwrap()
            .replace('\\', "\\\\")
            .replace('"', "\\\"");
        assert!(code.contains(&format!(
            "--form {}",
            quote(&format!("upload ;,\"\\' 日本語=@\"{escaped}\""))
        )));
    });
}

#[test]
fn rejects_invalid_url_headers_and_missing_or_cyclic_variables() {
    fixture(|conn, mut doc| {
        for url in [
            "not a URL",
            "ftp://example.test",
            "https://user:secret@example.test",
            "https://example.test/<<missing>>",
        ] {
            doc.url = url.into();
            assert!(generate(conn, doc.clone()).is_err());
        }
        doc.url = "https://example.test".into();
        for header in [
            row("Invalid Header", "value"),
            row("X-Test", "line\nbreak"),
            row("Host", "example.test"),
            row("X-Test", " \t "),
        ] {
            doc.headers = vec![header];
            assert!(generate(conn, doc.clone()).is_err());
        }
        doc.headers.clear();
        environment(conn, None, vec![row("a", "<<b>>"), row("b", "<<a>>")]);
        doc.url = "https://example.test/<<a>>".into();
        assert!(generate(conn, doc).unwrap_err().message.contains("cycle"));
    });
}

#[test]
fn rejects_unrepresentable_active_values_and_combinations() {
    fixture(|conn, mut doc| {
        doc.method = "HEAD".into();
        doc.body_kind = "json".into();
        assert!(generate(conn, doc.clone())
            .unwrap_err()
            .message
            .contains("HEAD"));
        doc.method = "POST".into();
        doc.body = "NUL\0".into();
        assert!(generate(conn, doc.clone())
            .unwrap_err()
            .message
            .contains("NUL"));
        doc.body_kind = "none".into();
        doc.params = vec![row("q", "\0")];
        assert!(generate(conn, doc.clone()).is_err());
        doc.params.clear();
        doc.headers = vec![row("X-Test", "\0")];
        assert!(generate(conn, doc.clone()).is_err());
        doc.headers.clear();
        doc.body_kind = "multipart".into();
        assert!(generate(conn, doc.clone())
            .unwrap_err()
            .message
            .contains("at least one"));
        for (name, value) in [
            ("a=b", "text"),
            ("line\nbreak", "text"),
            ("name", "\0"),
            ("nul\0", "text"),
        ] {
            doc.form_data = vec![field(name, value)];
            assert!(generate(conn, doc.clone()).is_err());
        }
    });
}

#[test]
fn reports_unselected_unregistered_and_missing_files() {
    fixture(|conn, mut doc| {
        doc.body_kind = "multipart".into();
        let mut file = field("upload", "");
        file.kind = "file".into();
        doc.form_data = vec![file];
        assert_eq!(
            generate(conn, doc.clone()).unwrap_err().code,
            "FILE_UNAVAILABLE"
        );
        doc.form_data[0].attachment_id = Some(uuid::Uuid::new_v4().to_string());
        assert_eq!(
            generate(conn, doc.clone()).unwrap_err().code,
            "FILE_UNAVAILABLE"
        );
        conn.execute(
            "INSERT INTO attachments VALUES (?1,?2,?3,0)",
            rusqlite::params![
                doc.form_data[0].attachment_id,
                "/missing/synthetic-file",
                "synthetic"
            ],
        )
        .unwrap();
        assert_eq!(
            generate(conn, doc.clone()).unwrap_err().code,
            "FILE_UNAVAILABLE"
        );
        let directory = tempfile::tempdir().unwrap();
        conn.execute(
            "UPDATE attachments SET path=?1 WHERE id=?2",
            rusqlite::params![
                directory.path().to_str().unwrap(),
                doc.form_data[0].attachment_id
            ],
        )
        .unwrap();
        assert_eq!(generate(conn, doc).unwrap_err().code, "UPLOAD_LIMIT");
    });
}

#[test]
fn generating_keeps_saved_request_and_history_unchanged() {
    fixture(|conn, mut doc| {
        let saved = repository::get_request(conn, &doc.id).unwrap();
        doc.body_kind = "json".into();
        doc.body = "unsaved".into();
        for _ in 0..2 {
            generate(conn, doc.clone()).unwrap();
        }
        let after = repository::get_request(conn, &doc.id).unwrap();
        assert_eq!(
            serde_json::to_value(saved).unwrap(),
            serde_json::to_value(after).unwrap()
        );
        let history: i64 = conn
            .query_row("SELECT COUNT(*) FROM request_history", [], |r| r.get(0))
            .unwrap();
        assert_eq!(history, 0);
    });
}
