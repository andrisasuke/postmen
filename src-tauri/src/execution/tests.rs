use super::{http, models::*, Executions};
use crate::{
    db::{repository as repo, Database},
    models::*,
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
