//! Opt-in OS-input QA: isolated fixture setup and passive state assertions.
//! No production command, network listener or automatic UI action is added.
use super::*;

fn command(window: &WebviewWindow, name: &str, args: Value) -> Result<Value> {
    let result = ipc(window, name, args)?;
    if result["ok"] != true {
        return Err(format!("OS QA setup {name}: {result}").into());
    }
    Ok(result["value"].clone())
}

pub(super) fn run(app: &AppHandle, output: PathBuf) -> Result<()> {
    let window = app.get_webview_window("main").ok_or("No QA window")?;
    wait_for(
        &window,
        "document.querySelector('[data-testid=\"app-shell\"]')?.dataset.connection==='connected'",
    )?;
    let workspace = command(&window, "load_workspace", json!({}))?;
    if workspace["collections"]
        .as_array()
        .is_some_and(Vec::is_empty)
    {
        let endpoint = std::env::var("POSTMEN_SMOKE_ENDPOINT")?;
        let url = url::Url::parse(&endpoint)?;
        if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") {
            return Err("OS QA requires its loopback fixture server".into());
        }
        let collection = command(
            &window,
            "create_collection",
            json!({"input":{"name":"PostMen OS QA"}}),
        )?;
        let mut ids = Vec::new();
        for (name, path) in [("OS request", "/json"), ("OS upload", "/upload")] {
            let mut request = command(
                &window,
                "create_request",
                json!({"input":{"collectionId":collection["id"],"folderId":null,"name":name}}),
            )?;
            request["url"] = json!(format!("{endpoint}{path}"));
            if path == "/upload" {
                request["method"] = json!("POST");
                request["bodyKind"] = json!("multipart");
                request["formData"] = json!([{"id":uuid::Uuid::new_v4().to_string(),"enabled":true,"name":"file","value":"","description":"OS picker QA","kind":"file","attachmentId":null}]);
            }
            let saved = command(&window, "save_request", json!({"input":request}))?;
            ids.push(saved["id"].clone());
        }
        command(
            &window,
            "save_session",
            json!({"input":{"tabIds":ids,"activeId":ids[0],"views":{}}}),
        )?;
        evaluate(&window, "location.reload(); true")?;
    }
    wait_for(&window, "!!document.querySelector('[aria-label=\"Request URL\"]') && document.fonts.status==='loaded'")?;
    std::fs::write(
        output.join("os-ready.json"),
        serde_json::to_vec_pretty(
            &json!({"pid":std::process::id(),"geometry":geometry(&window)?,"workspace":command(&window,"load_workspace",json!({}))?}),
        )?,
    )?;
    let started = Instant::now();
    let mut last_id = 0;
    loop {
        if started.elapsed() > Duration::from_secs(3600) {
            return Err("OS QA timed out; no successful OS Quit received".into());
        }
        if let Ok(bytes) = std::fs::read(output.join("os-command.json")) {
            if let Ok(request) = serde_json::from_slice::<Value>(&bytes) {
                let id = request["id"].as_u64().unwrap_or(0);
                if id > last_id {
                    last_id = id;
                    let value: Result<Value> = (|| match request["op"].as_str() {
                        Some("probe") => evaluate(
                            &window,
                            request["expression"].as_str().ok_or("Missing expression")?,
                        ),
                        Some("state") => Ok(
                            json!({"geometry":geometry(&window)?,"position":window.outer_position()?,"size":window.outer_size()?,"minimized":window.is_minimized()?,"maximized":window.is_maximized()?,"fullscreen":window.is_fullscreen()?}),
                        ),
                        Some("workspace") => command(&window, "load_workspace", json!({})),
                        Some("request") => {
                            command(&window, "get_request", json!({"id":request["requestId"]}))
                        }
                        Some("save_failure") => {
                            let db = app.state::<crate::db::Database>();
                            db.run(|c| {
                                c.execute_batch(if request["enabled"] == true {"CREATE TRIGGER qa_os_save_failure BEFORE UPDATE ON requests BEGIN SELECT RAISE(ABORT,'OS QA failure'); END;"} else {"DROP TRIGGER IF EXISTS qa_os_save_failure;"})?;
                                Ok(())
                            })?;
                            Ok(json!(true))
                        }
                        _ => Err("Unknown OS QA probe operation".into()),
                    })();
                    let result = match value {
                        Ok(value) => json!({"id":id,"ok":true,"value":value}),
                        Err(error) => json!({"id":id,"ok":false,"error":error.to_string()}),
                    };
                    std::fs::write(output.join("os-response.tmp"), serde_json::to_vec(&result)?)?;
                    std::fs::rename(
                        output.join("os-response.tmp"),
                        output.join("os-response.json"),
                    )?;
                }
            }
        }
        thread::sleep(Duration::from_millis(40));
    }
}
