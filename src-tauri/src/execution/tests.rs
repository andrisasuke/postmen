use super::{http, models::*, Executions};
use crate::{
    db::{repository as repo, Database},
    models::*,
    test_support::curl_payload,
};
use std::{
    io::Write,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    task::JoinHandle,
};

struct Server {
    url: String,
    requests: Arc<Mutex<Vec<String>>>,
    task: JoinHandle<()>,
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}
async fn server() -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(vec![]));
    let recorded = requests.clone();
    let task = tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let recorded = recorded.clone();
            tokio::spawn(async move {
                let mut bytes = vec![];
                let mut buffer = [0; 8192];
                let header_end;
                loop {
                    let n = stream.read(&mut buffer).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    bytes.extend_from_slice(&buffer[..n]);
                    if let Some(index) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                        header_end = index + 4;
                        break;
                    }
                }
                let head = String::from_utf8_lossy(&bytes[..header_end]).into_owned();
                let length = head
                    .lines()
                    .find_map(|l| {
                        l.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .and_then(|n| n.trim().parse::<usize>().ok())
                    })
                    .unwrap_or(0);
                while bytes.len() < header_end + length {
                    let n = stream.read(&mut buffer).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    bytes.extend_from_slice(&buffer[..n]);
                }
                let path = head.split_whitespace().nth(1).unwrap_or("/");
                recorded
                    .lock()
                    .unwrap()
                    .push(String::from_utf8_lossy(&bytes).into_owned());
                if path.starts_with("/slow") {
                    tokio::time::sleep(Duration::from_millis(600)).await;
                }
                let mut body =
                    b"{\"ok\":true,\"name\":\"\xe6\x97\xa5\xe6\x9c\xac\xe8\xaa\x9e\"}".to_vec();
                let mut extra =
                    "Content-Type: application/json\r\nX-Repeat: first\r\nX-Repeat: second\r\n"
                        .to_string();
                let mut status = "200 OK";
                if path == "/empty" {
                    status = "204 No Content";
                    body.clear();
                }
                if head.starts_with("HEAD ") {
                    body.clear();
                }
                if path == "/error" {
                    status = "500 Internal Server Error";
                    body = b"{\"error\":true}".to_vec();
                }
                if path == "/redirect" {
                    status = "302 Found";
                    extra.push_str("Location: /json\r\n");
                    body.clear();
                }
                if path == "/cross" {
                    status = "302 Found";
                    extra.push_str("Location: http://localhost:1/not-followed\r\n");
                    body.clear();
                }
                if path == "/loop" {
                    status = "302 Found";
                    extra.push_str("Location: /loop\r\n");
                    body.clear();
                }
                if path == "/large" {
                    body = "日".repeat(500_000).into_bytes();
                    extra = "Content-Type: text/plain; charset=utf-8\r\n".into();
                }
                if path == "/html" {
                    body = b"<script>globalThis.pwned=true</script>".to_vec();
                    extra = "Content-Type: text/html\r\n".into();
                }
                if path == "/latin" {
                    body = b"caf\xe9".to_vec();
                    extra = "Content-Type: text/plain; charset=windows-1252\r\n".into();
                }
                if path == "/gzip" {
                    let mut encoder =
                        flate2::write::GzEncoder::new(vec![], flate2::Compression::default());
                    encoder.write_all(&body).unwrap();
                    body = encoder.finish().unwrap();
                    extra.push_str("Content-Encoding: gzip\r\n");
                }
                if path == "/deflate" {
                    let mut encoder =
                        flate2::write::ZlibEncoder::new(vec![], flate2::Compression::default());
                    encoder.write_all(&body).unwrap();
                    body = encoder.finish().unwrap();
                    extra.push_str("Content-Encoding: deflate\r\n");
                }
                if path == "/brotli" {
                    let mut output = vec![];
                    {
                        let mut encoder = brotli::CompressorWriter::new(&mut output, 4096, 4, 22);
                        encoder.write_all(&body).unwrap();
                    }
                    body = output;
                    extra.push_str("Content-Encoding: br\r\n");
                }
                let response = format!(
                    "HTTP/1.1 {status}\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                if stream.write_all(response.as_bytes()).await.is_ok() {
                    if path == "/delayed-body" {
                        tokio::time::sleep(Duration::from_millis(120)).await;
                    }
                    let _ = stream.write_all(&body).await;
                }
            });
        }
    });
    Server {
        url,
        requests,
        task,
    }
}
fn fixture() -> (tempfile::TempDir, Database, RequestDoc) {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path().join("postmen.sqlite3"));
    let doc = db
        .run(|c| {
            let col = repo::create_collection(
                c,
                CreateCollection {
                    name: "Test".into(),
                },
            )?;
            repo::create_request(
                c,
                CreateRequest {
                    collection_id: col.id,
                    folder_id: None,
                    name: "Request".into(),
                    content: None,
                },
            )
        })
        .unwrap();
    (dir, db, doc)
}
fn prepare(ex: &Executions, doc: RequestDoc, timeout_ms: u64) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    ex.prepare(PrepareExecution {
        execution_id: id.clone(),
        request: doc,
        timeout_ms,
    })
    .unwrap();
    id
}
fn row(name: &str, value: &str) -> KeyValue {
    KeyValue {
        id: uuid::Uuid::new_v4().to_string(),
        enabled: true,
        name: name.into(),
        value: value.into(),
        description: String::new(),
    }
}
fn sent_body(sent: &str) -> &str {
    sent.split_once("\r\n\r\n")
        .map(|(_, body)| body)
        .unwrap_or_default()
}

#[test]
fn tls_classification_handles_nested_io_without_string_matching() {
    let nested = std::io::Error::other(std::io::Error::other(rustls::Error::InvalidCertificate(
        rustls::CertificateError::UnknownIssuer,
    )));
    assert!(http::is_tls_error(&nested, 0));
    assert!(!http::is_tls_error(
        &std::io::Error::from(std::io::ErrorKind::ConnectionRefused),
        0
    ));
}

#[test]
fn history_retains_newest_500_even_with_equal_timestamps_and_validates_pages() {
    let (_dir, db, doc) = fixture();
    let mut latest = String::new();
    db.run(|c| {
        for _ in 0..503 {
            latest = uuid::Uuid::new_v4().to_string();
            let result = ExecutionResult::empty(&latest, &doc.id);
            repo::record_execution(c, &result, "GET")?;
        }
        let count: i64 = c.query_row("SELECT count(*) FROM request_history", [], |r| r.get(0))?;
        assert_eq!(count, 500);
        let first = repo::list_history(
            c,
            HistoryQuery {
                request_id: Some(doc.id.clone()),
                limit: 100,
                offset: 0,
            },
        )?;
        assert_eq!(first[0].id, latest);
        assert_eq!(first.len(), 100);
        assert_eq!(
            repo::list_history(
                c,
                HistoryQuery {
                    request_id: None,
                    limit: 100,
                    offset: 495
                }
            )?
            .len(),
            5
        );
        assert!(repo::list_history(
            c,
            HistoryQuery {
                request_id: None,
                limit: 101,
                offset: 0
            }
        )
        .is_err());
        repo::delete_item(c, "request", &doc.id)?;
        let result = ExecutionResult::empty(&uuid::Uuid::new_v4().to_string(), &doc.id);
        repo::record_execution(c, &result, "GET")?;
        assert!(repo::list_history(
            c,
            HistoryQuery {
                request_id: None,
                limit: 1,
                offset: 0
            }
        )?[0]
            .request_id
            .is_none());
        Ok(())
    })
    .unwrap();
}

#[tokio::test]
async fn dropped_execution_releases_registry_and_cancelled_reservation_does_not_block_quit() {
    let (_dir, db, mut doc) = fixture();
    let server = server().await;
    doc.url = format!("{}/slow", server.url);
    let executions = Executions::new().unwrap();
    let id = prepare(&executions, doc.clone(), 1000);
    executions.cancel(&id).unwrap();
    assert_eq!(executions.active_count(), 0);
    assert_eq!(
        executions.execute(id, db.clone()).await.unwrap().outcome,
        "cancelled"
    );
    let id = prepare(&executions, doc, 1000);
    let copy = executions.clone();
    let task = tokio::spawn(async move { copy.execute(id, db).await });
    tokio::time::sleep(Duration::from_millis(50)).await;
    task.abort();
    let _ = task.await;
    assert_eq!(executions.active_count(), 0);
}

#[test]
fn execution_registry_rejects_duplicate_ids_invalid_timeouts_and_excess_parallelism() {
    let (_dir, _db, doc) = fixture();
    let ex = Executions::new().unwrap();
    let input = PrepareExecution {
        execution_id: uuid::Uuid::new_v4().to_string(),
        request: doc.clone(),
        timeout_ms: 1000,
    };
    ex.prepare(input.clone()).unwrap();
    assert_eq!(ex.prepare(input).unwrap_err().code, "CONFLICT");
    assert!(ex
        .prepare(PrepareExecution {
            execution_id: uuid::Uuid::new_v4().to_string(),
            request: doc.clone(),
            timeout_ms: 0
        })
        .is_err());
    for _ in 0..31 {
        prepare(&ex, doc.clone(), 1000);
    }
    assert_eq!(
        ex.prepare(PrepareExecution {
            execution_id: uuid::Uuid::new_v4().to_string(),
            request: doc,
            timeout_ms: 1000
        })
        .unwrap_err()
        .code,
        "BUSY"
    );
}

#[test]
fn url_composition_keeps_existing_query_repeats_and_encoding() {
    let (_dir, _db, mut doc) = fixture();
    doc.url = "https://example.test/api/users?existing=1#ignored".into();
    doc.params = vec![row("q", "a&b ?#+日本語"), row("q", "second")];
    let url = http::compose_url(&doc).unwrap();
    assert_eq!(url.path(), "/api/users");
    assert_eq!(url.fragment(), None);
    assert_eq!(url.query_pairs().collect::<Vec<_>>().len(), 3);
    assert_eq!(url.query_pairs().nth(1).unwrap().1, "a&b ?#+日本語");
    doc.url = "/users".into();
    assert!(http::compose_url(&doc).is_err());
    doc.url = "https://other.test/users".into();
    assert_eq!(
        http::compose_url(&doc).unwrap().host_str(),
        Some("other.test")
    );
    for bad in [
        "//other.test/path",
        "file:///etc/passwd",
        "https://user:secret@example.test/",
        "\\other.test",
    ] {
        doc.url = bad.into();
        assert!(http::compose_url(&doc).is_err());
    }
}
#[test]
fn headers_validate_framing_and_preserve_duplicates() {
    let (_dir, _db, mut doc) = fixture();
    doc.headers = vec![row("X-Test", "one"), row("X-Test", "two")];
    assert_eq!(
        http::headers(&doc)
            .unwrap()
            .get_all("x-test")
            .iter()
            .count(),
        2
    );
    doc.headers.push(row("Content-Length", "999"));
    assert!(http::headers(&doc).is_err());
    doc.headers = vec![row("X-Test", "bad\r\ninjected")];
    assert!(http::headers(&doc).is_err());
}
#[tokio::test]
async fn compression_status_empty_head_and_charset() {
    let server = server().await;
    let (_dir, db, doc) = fixture();
    let ex = Executions::new().unwrap();
    for path in [
        "/gzip", "/deflate", "/brotli", "/json", "/error", "/empty", "/latin",
    ] {
        let mut doc = doc.clone();
        doc.url = format!("{}{path}", server.url);
        let result = ex
            .execute(prepare(&ex, doc, 5000), db.clone())
            .await
            .unwrap();
        assert_eq!(result.outcome, "success", "{path}: {result:?}");
        match path {
            "/error" => assert_eq!(result.status, Some(500)),
            "/empty" => assert_eq!(result.body, ""),
            "/latin" => assert_eq!(result.body, "café"),
            _ => assert!(result.body.contains("日本語")),
        };
        assert_eq!(
            result.preview_bytes,
            result
                .body
                .len()
                .min(if path == "/latin" { 4 } else { usize::MAX })
        );
    }
    let mut doc = doc;
    doc.method = "HEAD".into();
    doc.url = format!("{}/json", server.url);
    assert!(ex
        .execute(prepare(&ex, doc, 5000), db)
        .await
        .unwrap()
        .body
        .is_empty());
}
#[tokio::test]
async fn duplicate_headers_and_duration_include_body() {
    let server = server().await;
    let (_dir, db, mut doc) = fixture();
    doc.url = format!("{}/delayed-body", server.url);
    let ex = Executions::new().unwrap();
    let result = ex.execute(prepare(&ex, doc, 5000), db).await.unwrap();
    assert!(result.duration_ms >= 110);
    assert_eq!(
        result
            .headers
            .iter()
            .filter(|h| h.name == "x-repeat")
            .count(),
        2
    );
}
#[test]
fn json_payload_strips_complete_comments_only_for_json_media_types() {
    let (_dir, _db, mut doc) = fixture();
    doc.body_kind = "json".into();
    let raw = "{\n  /*\n  \"old\": 0\n  */\n  \"name\": \"test/* */\",\n  \"n\": 1/* note */2\n}";
    doc.body = raw.into();
    doc.headers = vec![row(
        "Content-Type",
        "Application/Vnd.Api+Json; profile=\"café\"",
    )];
    let payload = {
        let headers = http::headers(&doc).unwrap();
        http::json_payload(&doc, &headers).unwrap().into_owned()
    };
    assert!(!payload.contains("\"old\": 0"));
    assert!(payload.contains("\"name\": \"test/* */\""));
    assert!(!payload.contains("12"));
    assert_eq!(payload.len(), raw.len());
    assert_eq!(
        payload
            .bytes()
            .filter(|byte| matches!(byte, b'\r' | b'\n'))
            .collect::<Vec<_>>(),
        raw.bytes()
            .filter(|byte| matches!(byte, b'\r' | b'\n'))
            .collect::<Vec<_>>()
    );
    // No explicit header: headers() supplies the existing JSON default.
    doc.headers.clear();
    let default_payload = {
        let headers = http::headers(&doc).unwrap();
        http::json_payload(&doc, &headers).unwrap().into_owned()
    };
    assert_eq!(default_payload, payload);
    // Legacy comment padding without a marker is cleaned for the payload copy.
    doc.body = "{\n  \n  \"a\":1\n}".into();
    let headers = http::headers(&doc).unwrap();
    assert_eq!(
        &*http::json_payload(&doc, &headers).unwrap(),
        "{\n  \"a\": 1\n}"
    );
    doc.body = raw.into();
    // Explicit non-JSON media types keep every raw byte, comments included.
    doc.headers = vec![row("Content-Type", "text/plain; charset=utf-8")];
    let raw_payload = {
        let headers = http::headers(&doc).unwrap();
        http::json_payload(&doc, &headers).unwrap().into_owned()
    };
    assert_eq!(raw_payload, raw);
    // A malformed media type is not the structured +json suffix.
    doc.headers = vec![row("Content-Type", "foo+json")];
    let foo_payload = {
        let headers = http::headers(&doc).unwrap();
        http::json_payload(&doc, &headers).unwrap().into_owned()
    };
    assert_eq!(foo_payload, raw);
    // A valid structured suffix is JSON even when type is not application.
    doc.headers = vec![row("Content-Type", "text/plain+json; profile=\"café\"")];
    let structured_payload = {
        let headers = http::headers(&doc).unwrap();
        http::json_payload(&doc, &headers).unwrap().into_owned()
    };
    assert_eq!(structured_payload, payload);
    // Multiple active values are ambiguous even when identical; order cannot
    // decide whether the raw or cleaned copy is sent.
    for headers in [
        vec![
            row("Content-Type", "application/json"),
            row("Content-Type", "text/plain"),
        ],
        vec![
            row("Content-Type", "text/plain"),
            row("Content-Type", "application/json"),
        ],
        vec![
            row("Content-Type", "application/json"),
            row("Content-Type", "application/json"),
        ],
        vec![row("Content-Type", "application/json, text/plain")],
    ] {
        doc.headers = headers;
        let ambiguous = {
            let headers = http::headers(&doc).unwrap();
            http::json_payload(&doc, &headers).unwrap().into_owned()
        };
        assert_eq!(ambiguous, raw);
    }
    let mut disabled = row("Content-Type", "text/plain");
    disabled.enabled = false;
    doc.headers = vec![row("Content-Type", "application/json"), disabled];
    let active_only = {
        let headers = http::headers(&doc).unwrap();
        http::json_payload(&doc, &headers).unwrap().into_owned()
    };
    assert_eq!(active_only, payload);
    // JSON request rules recognize markers after single quotes and // text.
    doc.headers = vec![row("Content-Type", "application/json")];
    doc.body = "'/* single */' // /* line */\n{\"a\":1}/* tail */".into();
    let payload = {
        let headers = http::headers(&doc).unwrap();
        http::json_payload(&doc, &headers).unwrap().into_owned()
    };
    assert!(!payload.contains("/* single */"));
    assert!(!payload.contains("/* line */"));
    assert!(!payload.contains("/* tail */"));
    // Unclosed blocks outside JSON strings fail before any transport body.
    for body in [
        "{\"a\":1}/* unfinished PRIVATE_TAIL",
        "'/* unfinished PRIVATE_TAIL",
        "// /* unfinished PRIVATE_TAIL",
    ] {
        doc.body = body.into();
        let headers = http::headers(&doc).unwrap();
        let error = http::json_payload(&doc, &headers).unwrap_err();
        assert_eq!(error.code, "INVALID_INPUT");
        assert!(error.message.contains("unclosed"));
        assert!(!error.message.contains("PRIVATE_TAIL"));
    }
}
#[tokio::test]
async fn imported_unfinished_body_is_rejected_or_verbatim_by_effective_media_type() {
    let server = server().await;
    let (_dir, db, _) = fixture();
    let imports = crate::collection_import::Imports::default();
    let raw = "{\"one\":1}/* unfinished PRIVATE_TAIL";
    let collection = serde_json::json!({
        "info": {"name": "Imported raw", "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},
        "item": [{"name": "Raw request", "request": {
            "method": "POST",
            "url": "https://example.test/raw",
            "body": {"mode": "raw", "raw": raw}
        }}]
    });
    let bytes = serde_json::to_vec(&collection).unwrap();
    let preview = imports.stage(&bytes).unwrap();
    let token = serde_json::to_value(&preview).unwrap()["token"]
        .as_str()
        .unwrap()
        .to_string();
    let outcome = db
        .run(|conn| {
            imports.commit(
                conn,
                crate::collection_import::Commit {
                    token,
                    mode: crate::collection_import::Mode::Create,
                    target_id: None,
                },
            )
        })
        .unwrap();
    let workspace = match outcome {
        crate::collection_import::Outcome::Imported { workspace, .. } => workspace,
        _ => panic!("expected import"),
    };
    let request_id = workspace
        .requests
        .iter()
        .find(|request| request.name == "Raw request")
        .unwrap()
        .id
        .clone();
    let mut doc = db.run(|conn| repo::get_request(conn, &request_id)).unwrap();
    assert_eq!(doc.body, raw);
    assert_eq!(doc.body_kind, "json");
    doc.url = format!("{}/json", server.url);
    doc.method = "POST".into();
    let ex = Executions::new().unwrap();

    // Default JSON rejects the unfinished block before HTTP.
    let result = ex
        .execute(prepare(&ex, doc.clone(), 5000), db.clone())
        .await
        .unwrap();
    assert_eq!(result.outcome, "error");
    assert_eq!(result.error_code.as_deref(), Some("INVALID_INPUT"));
    assert_eq!(server.requests.lock().unwrap().len(), 0);

    // Explicit JSON also rejects, and Generate cURL returns the same error.
    doc.headers = vec![row("Content-Type", "application/json")];
    let result = ex
        .execute(prepare(&ex, doc.clone(), 5000), db.clone())
        .await
        .unwrap();
    assert_eq!(result.outcome, "error");
    assert_eq!(result.error_code.as_deref(), Some("INVALID_INPUT"));
    assert_eq!(server.requests.lock().unwrap().len(), 0);
    assert_eq!(
        db.run(|conn| crate::generate_curl::generate(conn, doc.clone()))
            .unwrap_err()
            .code,
        "INVALID_INPUT"
    );

    // Explicit text/plain sends the stored bytes and matches cURL arguments.
    doc.headers = vec![row("Content-Type", "text/plain")];
    let result = ex
        .execute(prepare(&ex, doc.clone(), 5000), db.clone())
        .await
        .unwrap();
    assert_eq!(result.status, Some(200));
    {
        let requests = server.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(sent_body(&requests[0]), raw);
    }
    let code = db
        .run(|conn| crate::generate_curl::generate(conn, doc))
        .unwrap()
        .code;
    assert!(code.contains(raw));
}

#[tokio::test]
async fn send_records_same_payload_as_generate_curl_for_effective_media_types() {
    let server = server().await;
    let (_dir, db, mut doc) = fixture();
    doc.method = "POST".into();
    doc.url = format!("{}/json", server.url);
    doc.body_kind = "json".into();
    let raw =
        "{\n  /* old */\n  \"name\": \"test/* */\",\n  \"author\": \"O'Reilly\",\n  \"n\": 1\n}";
    let formatted = "{\n  \"name\": \"test/* */\",\n  \"author\": \"O'Reilly\",\n  \"n\": 1\n}";
    let cases: [(Option<&str>, &str); 5] = [
        (None, formatted),
        (Some("application/json; profile=\"café\""), formatted),
        (
            Some("application/vnd.api+json; profile=\"café\""),
            formatted,
        ),
        (Some("text/plain"), raw),
        (Some("foo+json"), raw),
    ];
    let ex = Executions::new().unwrap();
    for (index, (content_type, expected)) in cases.into_iter().enumerate() {
        doc.body = raw.into();
        doc.headers = match content_type {
            Some(value) => vec![row("Content-Type", value)],
            None => vec![],
        };
        let result = ex
            .execute(prepare(&ex, doc.clone(), 5000), db.clone())
            .await
            .unwrap();
        assert_eq!(result.status, Some(200), "{content_type:?}");
        let sent = {
            let requests = server.requests.lock().unwrap();
            assert_eq!(requests.len(), index + 1);
            sent_body(&requests[index]).to_owned()
        };
        let code = db
            .run(|conn| crate::generate_curl::generate(conn, doc.clone()))
            .unwrap()
            .code;
        assert_eq!(curl_payload(&code), sent.as_bytes(), "{content_type:?}");
        assert_eq!(sent.as_str(), expected, "{content_type:?}");
    }

    let large = format!(
        "/* note */{{\"author\":\"O'Reilly\",\"text\":\"{}\"}}",
        "日".repeat(30_000)
    );
    doc.body = large;
    doc.headers = vec![row("Content-Type", "application/json")];
    let result = ex
        .execute(prepare(&ex, doc.clone(), 5000), db.clone())
        .await
        .unwrap();
    assert_eq!(result.status, Some(200));
    let sent = {
        let requests = server.requests.lock().unwrap();
        assert_eq!(requests.len(), 6);
        sent_body(&requests[5]).as_bytes().to_vec()
    };
    let code = db
        .run(|conn| crate::generate_curl::generate(conn, doc))
        .unwrap()
        .code;
    assert!(code.contains("--data-binary '@-'"));
    assert_eq!(curl_payload(&code), sent);
    assert!(sent
        .windows(b"O'Reilly".len())
        .any(|window| window == b"O'Reilly"));
}

#[tokio::test]
async fn conflicting_content_types_preserve_raw_send_and_curl_bytes() {
    let server = server().await;
    let (_dir, db, mut doc) = fixture();
    doc.method = "POST".into();
    doc.url = format!("{}/json", server.url);
    doc.body_kind = "json".into();
    let raw = "{\n  /* old */\n  \"name\": \"test/* */\",\n  \"author\": \"O'Reilly\"\n}";
    let formatted = "{\n  \"name\": \"test/* */\",\n  \"author\": \"O'Reilly\"\n}";
    let mut disabled_text = row("Content-Type", "text/plain");
    disabled_text.enabled = false;
    let cases: [(Vec<KeyValue>, &str, usize); 5] = [
        (
            vec![
                row("Content-Type", "application/json"),
                row("Content-Type", "text/plain"),
            ],
            raw,
            2,
        ),
        (
            vec![
                row("Content-Type", "text/plain"),
                row("Content-Type", "application/json"),
            ],
            raw,
            2,
        ),
        (
            vec![
                row("Content-Type", "application/json"),
                row("Content-Type", "application/json"),
            ],
            raw,
            2,
        ),
        (
            vec![row("Content-Type", "application/json, text/plain")],
            raw,
            1,
        ),
        (
            vec![row("Content-Type", "application/json"), disabled_text],
            formatted,
            1,
        ),
    ];
    let ex = Executions::new().unwrap();
    for (index, (headers, expected, active_count)) in cases.into_iter().enumerate() {
        doc.body = raw.into();
        doc.headers = headers;
        let result = ex
            .execute(prepare(&ex, doc.clone(), 5000), db.clone())
            .await
            .unwrap();
        assert_eq!(result.status, Some(200), "{index}");
        let (sent, recorded) = {
            let requests = server.requests.lock().unwrap();
            assert_eq!(requests.len(), index + 1);
            (
                sent_body(&requests[index]).as_bytes().to_vec(),
                requests[index].clone(),
            )
        };
        assert_eq!(
            recorded
                .to_ascii_lowercase()
                .matches("content-type:")
                .count(),
            active_count,
            "{index}"
        );
        let code = db
            .run(|conn| crate::generate_curl::generate(conn, doc.clone()))
            .unwrap()
            .code;
        assert_eq!(curl_payload(&code), sent, "{index}");
        assert_eq!(sent.as_slice(), expected.as_bytes(), "{index}");
    }
}

#[tokio::test]
async fn send_uses_draft_comment_payload_without_modifying_the_saved_request() {
    let server = server().await;
    let (_dir, db, mut doc) = fixture();
    doc.method = "POST".into();
    doc.url = format!("{}/json", server.url);
    doc.body_kind = "json".into();
    let draft = "{\n  /*\n  \"old\": true\n  */\n  \"name\": \"test/* */\",\n  \"active\": 1\n}";
    doc.body = draft.into();
    doc.headers = vec![row("Content-Type", "application/json; charset=utf-8")];
    let ex = Executions::new().unwrap();
    let saved_id = doc.id.clone();
    let result = ex
        .execute(prepare(&ex, doc.clone(), 5000), db.clone())
        .await
        .unwrap();
    assert_eq!(result.status, Some(200));
    {
        let requests = server.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        let sent = sent_body(&requests[0]);
        assert!(!sent.contains("\"old\": true"));
        assert_eq!(sent.matches("/*").count(), 1);
        assert!(sent.contains("\"name\": \"test/* */\""));
        assert!(serde_json::from_str::<serde_json::Value>(sent).is_ok());
    }
    let saved = db.run(|c| repo::get_request(c, &saved_id)).unwrap();
    assert_eq!(saved.body, "");
    assert_eq!(saved.body_kind, "none");

    for body in [
        "{\"a\":1}/* unfinished",
        "'/* unfinished",
        "// /* unfinished",
        "{\"a\":\"bad\\\n/* unfinished PRIVATE_TAIL",
        "{\"a\":\"bad\\\r\n/* unfinished PRIVATE_TAIL",
    ] {
        doc.body = body.into();
        let result = ex
            .execute(prepare(&ex, doc.clone(), 5000), db.clone())
            .await
            .unwrap();
        assert_eq!(result.outcome, "error");
        assert_eq!(result.error_code.as_deref(), Some("INVALID_INPUT"));
        assert_eq!(server.requests.lock().unwrap().len(), 1);
    }
}
#[tokio::test]
async fn large_utf8_is_bounded_and_html_remains_plain_text() {
    let server = server().await;
    let (_dir, db, doc) = fixture();
    let ex = Executions::new().unwrap();
    for path in ["/large", "/html"] {
        let mut doc = doc.clone();
        doc.url = format!("{}{path}", server.url);
        let result = ex
            .execute(prepare(&ex, doc, 5000), db.clone())
            .await
            .unwrap();
        if path == "/large" {
            assert!(result.truncated);
            assert_eq!(result.preview_bytes, http::PREVIEW_LIMIT);
            assert!(!result.body.contains('\u{fffd}'));
        } else {
            assert!(result.body.contains("<script>"));
        }
    }
}
#[tokio::test]
async fn same_origin_redirects_follow_cross_origin_stops_and_loops_error() {
    let server = server().await;
    let (_dir, db, doc) = fixture();
    let ex = Executions::new().unwrap();
    for (path, status, error) in [
        ("/redirect", Some(200), None),
        ("/cross", Some(302), None),
        ("/loop", None, Some("REDIRECT_ERROR")),
    ] {
        let mut doc = doc.clone();
        doc.url = format!("{}{path}", server.url);
        let result = ex
            .execute(prepare(&ex, doc, 5000), db.clone())
            .await
            .unwrap();
        assert_eq!(result.status, status);
        assert_eq!(result.error_code.as_deref(), error);
    }
}
#[tokio::test]
async fn cancel_before_execute_never_sends_and_is_idempotent() {
    let server = server().await;
    let (_dir, db, mut doc) = fixture();
    doc.url = server.url.clone();
    let ex = Executions::new().unwrap();
    let id = prepare(&ex, doc, 5000);
    ex.cancel(&id).unwrap();
    let result = ex.execute(id.clone(), db).await.unwrap();
    assert_eq!(result.outcome, "cancelled");
    assert!(server.requests.lock().unwrap().is_empty());
    ex.cancel(&id).unwrap();
    assert_eq!(ex.active_count(), 0);
}
#[tokio::test]
async fn concurrent_cancel_resend_and_timeout_have_separate_results() {
    let server = server().await;
    let (_dir, db, mut doc) = fixture();
    doc.url = format!("{}/slow", server.url);
    let ex = Executions::new().unwrap();
    let old = prepare(&ex, doc.clone(), 5000);
    let active = ex.clone();
    let data = db.clone();
    let id = old.clone();
    let task = tokio::spawn(async move { active.execute(id, data).await.unwrap() });
    tokio::time::sleep(Duration::from_millis(20)).await;
    ex.cancel(&old).unwrap();
    let timeout = ex
        .execute(prepare(&ex, doc.clone(), 100), db.clone())
        .await
        .unwrap();
    assert_eq!(timeout.error_code.as_deref(), Some("TIMEOUT"));
    doc.url = format!("{}/json", server.url);
    let fresh = ex.execute(prepare(&ex, doc, 5000), db).await.unwrap();
    assert_eq!(fresh.status, Some(200));
    assert_eq!(task.await.unwrap().outcome, "cancelled");
    assert_ne!(old, fresh.execution_id);
}
#[tokio::test]
async fn multipart_streams_selected_unicode_file_skips_disabled_and_rejects_missing() {
    let server = server().await;
    let (dir, db, mut doc) = fixture();
    let path = dir.path().join("日本語.txt");
    std::fs::write(&path, "file contents").unwrap();
    let file = db.run(|c| repo::register_attachment(c, &path)).unwrap();
    doc.method = "POST".into();
    doc.url = server.url.clone();
    doc.body_kind = "multipart".into();
    doc.form_data = vec![
        FormField {
            id: uuid::Uuid::new_v4().to_string(),
            enabled: true,
            name: "file".into(),
            kind: "file".into(),
            value: "".into(),
            attachment_id: Some(file.id),
            description: "".into(),
        },
        FormField {
            id: uuid::Uuid::new_v4().to_string(),
            enabled: true,
            name: "note".into(),
            kind: "text".into(),
            value: "hello".into(),
            attachment_id: None,
            description: "".into(),
        },
        FormField {
            id: uuid::Uuid::new_v4().to_string(),
            enabled: false,
            name: "disabled".into(),
            kind: "file".into(),
            value: "".into(),
            attachment_id: None,
            description: "".into(),
        },
    ];
    let ex = Executions::new().unwrap();
    assert_eq!(
        ex.execute(prepare(&ex, doc.clone(), 5000), db.clone())
            .await
            .unwrap()
            .status,
        Some(200)
    );
    let sent = server.requests.lock().unwrap()[0].clone();
    assert!(sent.contains("file contents"));
    assert!(sent.contains("日本語.txt"));
    assert!(sent.contains("hello"));
    assert!(!sent.contains("disabled"));
    std::fs::rename(path, dir.path().join("moved.txt")).unwrap();
    assert_eq!(
        ex.execute(prepare(&ex, doc, 5000), db)
            .await
            .unwrap()
            .error_code
            .as_deref(),
        Some("FILE_UNAVAILABLE")
    );
}
#[tokio::test]
async fn history_omits_secrets_and_failure_never_loses_response() {
    let server = server().await;
    let (_dir, db, mut doc) = fixture();
    doc.url = format!("{}/json?secret=not-for-history", server.url);
    doc.headers = vec![row("Authorization", "Bearer secret")];
    doc.body_kind = "json".into();
    doc.body = "sensitive body".into();
    let ex = Executions::new().unwrap();
    let result = ex
        .execute(prepare(&ex, doc.clone(), 5000), db.clone())
        .await
        .unwrap();
    assert_eq!(result.outcome, "success");
    db.run(|c|{let text:String=c.query_row("SELECT summary_json FROM request_history",[],|r|r.get(0))?;assert!(!text.contains("secret"));assert!(!text.contains("sensitive"));c.execute_batch("CREATE TRIGGER fail_history BEFORE INSERT ON request_history BEGIN SELECT RAISE(ABORT,'qa'); END;")?;Ok(())}).unwrap();
    let result = ex.execute(prepare(&ex, doc, 5000), db).await.unwrap();
    assert_eq!(result.status, Some(200));
    assert!(result.history_warning.is_some());
}
#[tokio::test]
async fn completion_persists_latest_result_and_reports_independent_failures() {
    let server = server().await;
    let (_dir, db, mut doc) = fixture();
    doc.url = format!("{}/json", server.url);
    let ex = Executions::new().unwrap();
    let first = ex
        .execute(prepare(&ex, doc.clone(), 5000), db.clone())
        .await
        .unwrap();
    let saved = db
        .run(|c| repo::get_last_execution(c, &doc.id))
        .unwrap()
        .unwrap();
    assert_eq!(saved.result.execution_id, first.execution_id);
    assert_eq!(saved.result.body, first.body);
    db.run(|c| { c.execute_batch("CREATE TRIGGER fail_snapshot BEFORE UPDATE ON last_executions BEGIN SELECT RAISE(ABORT,'qa'); END;")?; Ok(()) }).unwrap();
    let second = ex
        .execute(prepare(&ex, doc.clone(), 5000), db.clone())
        .await
        .unwrap();
    assert_eq!(second.status, Some(200));
    assert!(second.snapshot_warning.is_some());
    assert!(second.history_warning.is_none());
    assert_eq!(
        db.run(|c| repo::get_last_execution(c, &doc.id))
            .unwrap()
            .unwrap()
            .result
            .execution_id,
        first.execution_id
    );
    db.run(|c| { c.execute_batch("DROP TRIGGER fail_snapshot; CREATE TRIGGER fail_history_independent BEFORE INSERT ON request_history BEGIN SELECT RAISE(ABORT,'qa'); END;")?; Ok(()) }).unwrap();
    let third = ex
        .execute(prepare(&ex, doc.clone(), 5000), db.clone())
        .await
        .unwrap();
    assert!(third.history_warning.is_some());
    assert!(third.snapshot_warning.is_none());
    assert_eq!(
        db.run(|c| repo::get_last_execution(c, &doc.id))
            .unwrap()
            .unwrap()
            .result
            .execution_id,
        third.execution_id
    );
}
#[tokio::test]
async fn cancellation_replaces_snapshot_and_deleted_request_stays_absent() {
    let (_dir, db, mut doc) = fixture();
    doc.url = "http://127.0.0.1:1/".into();
    let ex = Executions::new().unwrap();
    let execution_id = prepare(&ex, doc.clone(), 1000);
    ex.cancel(&execution_id).unwrap();
    let result = ex.execute(execution_id, db.clone()).await.unwrap();
    let saved = db
        .run(|c| repo::get_last_execution(c, &doc.id))
        .unwrap()
        .unwrap();
    assert_eq!(result.outcome, "cancelled");
    assert_eq!(saved.result.execution_id, result.execution_id);
    assert_eq!(saved.result.error_code.as_deref(), Some("CANCELLED"));
    db.run(|c| {
        c.execute("DELETE FROM requests WHERE id=?1", [&doc.id])?;
        Ok(())
    })
    .unwrap();
    let next = prepare(&ex, doc.clone(), 1000);
    ex.cancel(&next).unwrap();
    let result = ex.execute(next, db.clone()).await.unwrap();
    assert!(result.snapshot_warning.is_none());
    assert!(db
        .run(|c| repo::get_last_execution(c, &doc.id))
        .unwrap()
        .is_none());
}
#[tokio::test]
async fn connection_failure_is_safe_and_saved_draft_is_not_modified() {
    let (_dir, db, mut doc) = fixture();
    doc.url = "http://127.0.0.1:1/?secret=hidden".into();
    let id = doc.id.clone();
    let ex = Executions::new().unwrap();
    let result = ex
        .execute(prepare(&ex, doc, 1000), db.clone())
        .await
        .unwrap();
    assert_eq!(result.outcome, "error");
    assert!(!result.message.unwrap().contains("hidden"));
    assert_eq!(db.run(|c| repo::get_request(c, &id)).unwrap().url, "");
}
