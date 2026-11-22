use super::*;
use crate::{
    db::Database,
    models::*,
    test_support::{arguments, curl_payload, curl_payload_result, printf_chunks},
};

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

// Decoder is shared with Send parity tests through test_support.

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
            "\n{\"name\": \"O'Reilly 日本語\"}\n",
            "@file\n$(secret) `command` \\\n raw",
            "raw\r\nCRLF\rstandalone carriage return",
            "",
        ] {
            doc.body = body.into();
            let args = arguments(&generate(conn, doc.clone()).unwrap().code);
            assert_eq!(args[args.len() - 2], "--data-raw");
            assert_eq!(args.last().unwrap(), body);
        }
        doc.body = "{\n  \n  \"a\":1\n}".into();
        let args = arguments(&generate(conn, doc.clone()).unwrap().code);
        assert_eq!(args.last().unwrap(), "{\n  \"a\": 1\n}");
    });
}

#[test]
fn json_comment_payload_uses_same_media_type_policy_as_send() {
    fixture(|conn, mut doc| {
        doc.body_kind = "json".into();
        let raw = "{\n  /* old\n     payload */\n  \"name\": /* note */ \"test/* */\",\n  \"amount\":1e+400,\"amount\":9007199254740993\n}";
        let formatted = "{\n  \"name\": \"test/* */\",\n  \"amount\": 1e+400,\n  \"amount\": 9007199254740993\n}";
        doc.body = raw.into();
        // No Content-Type follows the existing JSON default.
        let args = arguments(&generate(conn, doc.clone()).unwrap().code);
        assert_eq!(args[args.len() - 2], "--data-raw");
        assert_eq!(args.last().unwrap(), formatted);
        assert!(args.last().unwrap().contains("\"test/* */\""));
        // Structured JSON suffixes with parameters are still JSON.
        doc.headers = vec![row(
            "Content-Type",
            "application/vnd.api+json; charset=utf-8",
        )];
        let args = arguments(&generate(conn, doc.clone()).unwrap().code);
        assert_eq!(args.last().unwrap(), formatted);
        // Non-ASCII quoted parameters do not affect the media type decision.
        doc.headers = vec![row("Content-Type", "application/json; profile=\"café\"")];
        let args = arguments(&generate(conn, doc.clone()).unwrap().code);
        assert_eq!(args.last().unwrap(), formatted);
        // Explicit raw media types preserve the body byte for byte.
        doc.headers = vec![row("Content-Type", "text/plain")];
        let args = arguments(&generate(conn, doc.clone()).unwrap().code);
        assert_eq!(args.last().unwrap(), raw);
        // A malformed media type is not the structured +json suffix.
        doc.headers = vec![row("Content-Type", "foo+json")];
        let args = arguments(&generate(conn, doc.clone()).unwrap().code);
        assert_eq!(args.last().unwrap(), raw);
        // A valid structured suffix is JSON even when type is not application.
        doc.headers = vec![row("Content-Type", "text/plain+json; profile=\"café\"")];
        let args = arguments(&generate(conn, doc.clone()).unwrap().code);
        assert_eq!(args.last().unwrap(), formatted);
        // JSON request rules recognize markers after single quotes and // text.
        doc.headers = vec![row("Content-Type", "application/json")];
        doc.body = "'/* single */' // /* line */\n{\"a\":1}/* tail */".into();
        let args = arguments(&generate(conn, doc.clone()).unwrap().code);
        let payload = args.last().unwrap();
        assert!(!payload.contains("/* single */"));
        assert!(!payload.contains("/* line */"));
        assert!(!payload.contains("/* tail */"));
        // Unclosed comments are rejected instead of exporting a partial body.
        for body in [
            "{\"a\":1}/* unfinished PRIVATE_TAIL",
            "'/* unfinished PRIVATE_TAIL",
            "// /* unfinished PRIVATE_TAIL",
            "{\"a\":\"bad\\\n/* unfinished PRIVATE_TAIL",
            "{\"a\":\"bad\\\r\n/* unfinished PRIVATE_TAIL",
        ] {
            doc.body = body.into();
            let error = generate(conn, doc.clone()).unwrap_err();
            assert_eq!(error.code, "INVALID_INPUT");
            assert!(error.message.contains("unclosed"));
            assert!(!error.message.contains("PRIVATE_TAIL"));
        }
    });
}

#[test]
fn streams_payloads_at_or_above_64_kib_through_stdin() {
    fixture(|conn, mut doc| {
        doc.body_kind = "json".into();
        doc.headers = vec![row("Content-Type", "text/plain")];
        for length in [64 * 1024 - 1, 64 * 1024, 64 * 1024 + 1] {
            let body = "x".repeat(length);
            doc.body = body.clone();
            let code = generate(conn, doc.clone()).unwrap().code;
            if length < 64 * 1024 {
                assert_eq!(
                    arguments(&code).iter().rev().nth(1).map(String::as_str),
                    Some("--data-raw")
                );
            } else {
                assert!(code.contains("--data-binary '@-'"));
                assert!(!code.contains("--data-raw"));
                assert!(code.contains("printf '%s' "));
                assert!(!code.contains("printf '%s\\n'"));
            }
            assert_eq!(curl_payload(&code), body.as_bytes(), "{length}");
        }
    });
}

#[test]
fn streams_formatted_json_by_payload_size_not_source_size() {
    fixture(|conn, mut doc| {
        doc.body_kind = "json".into();
        let body = format!(
            "/* note */{}{}0{}",
            "[".repeat(64),
            "0,".repeat(1000),
            "]".repeat(64)
        );
        assert!(body.len() < 64 * 1024);
        doc.body = body;
        doc.headers = vec![row("Content-Type", "application/json")];
        let headers = crate::execution::http::headers(&doc).unwrap();
        let expected = crate::execution::http::json_payload(&doc, &headers)
            .unwrap()
            .into_owned();
        assert!(expected.len() >= 64 * 1024);
        let code = generate(conn, doc).unwrap().code;
        assert!(code.contains("--data-binary '@-'"));
        assert_eq!(curl_payload(&code), expected.as_bytes());
        assert!(printf_chunks(&code)
            .unwrap()
            .iter()
            .all(|chunk| chunk.as_bytes().len() <= 32 * 1024));
    });
}

#[test]
fn streams_large_review_array_raw_apostrophes_and_multibyte_chunks() {
    fixture(|conn, mut doc| {
        doc.body_kind = "json".into();
        let large_array = format!("/* note */[{}0]", "0,".repeat(250_000));
        doc.body = large_array;
        doc.headers = vec![row("Content-Type", "application/json")];
        let headers = crate::execution::http::headers(&doc).unwrap();
        let expected = crate::execution::http::json_payload(&doc, &headers)
            .unwrap()
            .into_owned();
        assert!(expected.len() > 1_000_000);
        let code = generate(conn, doc.clone()).unwrap().code;
        assert!(code.contains("--data-binary '@-'"));
        assert_eq!(curl_payload(&code), expected.as_bytes());

        let raw = format!(
            "  O'Reilly\r\n\"$(command)\" `tick` 日本語😀\n{}\n",
            "x".repeat(70_000)
        );
        doc.body = raw.clone();
        doc.headers = vec![row("Content-Type", "text/plain")];
        let code = generate(conn, doc.clone()).unwrap().code;
        assert!(code.contains("--data-binary '@-'"));
        assert_eq!(curl_payload(&code), raw.as_bytes());
        assert!(printf_chunks(&code).unwrap().iter().all(|chunk| {
            chunk.as_bytes().len() <= 32 * 1024 && std::str::from_utf8(chunk.as_bytes()).is_ok()
        }));

        let json = format!(
            "/* note */{{\"author\":\"O'Reilly\",\"text\":\"{}\"}}",
            "日".repeat(30_000)
        );
        doc.body = json;
        doc.headers = vec![row("Content-Type", "application/json")];
        let headers = crate::execution::http::headers(&doc).unwrap();
        let expected = crate::execution::http::json_payload(&doc, &headers)
            .unwrap()
            .into_owned();
        let code = generate(conn, doc).unwrap().code;
        assert!(code.contains("--data-binary '@-'"));
        assert_eq!(curl_payload(&code), expected.as_bytes());
        assert!(printf_chunks(&code)
            .unwrap()
            .iter()
            .all(|chunk| chunk.as_bytes().len() <= 32 * 1024));
    });
}
#[test]
fn strict_stdin_decoder_rejects_extra_commands_and_missing_chunks() {
    fixture(|conn, mut doc| {
        doc.body_kind = "json".into();
        let raw = format!(
            "printf '%s' --data-raw --data-binary @- }} | curl O'Reilly {}",
            "x".repeat(70_000)
        );
        doc.body = raw.clone();
        doc.headers = vec![row("Content-Type", "text/plain")];
        let code = generate(conn, doc).unwrap().code;
        assert_eq!(curl_payload(&code), raw.as_bytes());
        assert!(!raw.ends_with('\n'));

        let extra_newline = code.replacen("  printf '%s' ", "  printf '\\n'\n  printf '%s' ", 1);
        assert!(curl_payload_result(&extra_newline).is_err());
        let echo = code.replacen("  printf '%s' ", "  echo synthetic\n  printf '%s' ", 1);
        assert!(curl_payload_result(&echo).is_err());

        let first_command = code.lines().nth(1).expect("first printf command");
        let missing_chunk = code.replacen(first_command, "", 1);
        let decoded = curl_payload(&missing_chunk);
        assert_ne!(decoded, raw.as_bytes());
        assert!(decoded.len() < raw.len());
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
