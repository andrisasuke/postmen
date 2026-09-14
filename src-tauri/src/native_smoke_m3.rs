//! Actual WKWebView -> IPC -> Rust HTTP -> temporary SQLite and guarded exit.
use super::*;
use crate::db::{repository as repo, Database};
fn text_button(window: &WebviewWindow, label: &str) -> Result<()> {
    let label = serde_json::to_string(label)?;
    let expression = format!(
        "Array.from(document.querySelectorAll('button')).find(e=>e.textContent.trim()==={label})"
    );
    wait_for(
        window,
        &format!("!!({expression}) && !({expression}).disabled"),
    )?;
    evaluate(window, &format!("({expression}).click(); true"))?;
    Ok(())
}
fn send(window: &WebviewWindow, url: &str, expected: &str) -> Result<()> {
    input(window, "[aria-label=\"Request URL\"]", url)?;
    text_button(window, "Send")?;
    wait_for(window,&format!("document.querySelector('[data-testid=\"response-pane\"]')?.textContent.includes({}) === true",serde_json::to_string(expected)?))
}
pub(super) fn run(app: &AppHandle, output: PathBuf) -> Result<()> {
    let window = app.get_webview_window("main").ok_or("No main window")?;
    let restore = std::env::var("POSTMEN_SMOKE_RESTORE").is_ok_and(|v| v == "1");
    let base = std::env::var("POSTMEN_SMOKE_HTTP")?;
    let tls = std::env::var("POSTMEN_SMOKE_TLS")?;
    for address in [&base, &tls] {
        let url = url::Url::parse(address)?;
        if url.host_str() != Some("127.0.0.1") {
            return Err("QA HTTP must use loopback only".into());
        }
    }
    wait_for(
        &window,
        "document.querySelector('[data-testid=\"app-shell\"]')?.dataset.connection==='connected'",
    )?;
    let db = app.state::<Database>();
    let mut checks = vec!["M3-native-bootstrap-real-sqlite"];
    let initial = geometry(&window)?;
    if restore {
        wait_for(
            &window,
            "document.querySelector('[aria-label=\"Request URL\"]')?.value==='/saved-on-quit'",
        )?;
        wait_for(&window,"document.documentElement.dataset.theme==='dark' && document.querySelector('[data-testid=\"split-panes\"]')?.dataset.orientation==='vertical'")?;
        let expected: Value = serde_json::from_str(&std::fs::read_to_string(std::env::var(
            "POSTMEN_SMOKE_EXPECTED_WINDOW",
        )?)?)?;
        let size = window.inner_size()?;
        let position = window.outer_position()?;
        if size.width != expected["width"].as_u64().unwrap() as u32
            || size.height != expected["height"].as_u64().unwrap() as u32
            || position.x != expected["x"].as_i64().unwrap() as i32
            || position.y != expected["y"].as_i64().unwrap() as i32
        {
            return Err(format!(
                "Window restore mismatch: {size:?} {position:?}, expected {expected}"
            )
            .into());
        }
        db.run(|c| {
            let workspace = repo::workspace(c)?;
            assert_eq!(workspace.requests.len(), 1);
            assert_eq!(workspace.session.tab_ids.len(), 1);
            assert_eq!(
                repo::get_request(c, &workspace.requests[0].id)?.url,
                "/saved-on-quit"
            );
            Ok(())
        })?;
        checks.push("second-process-restores-saved-request-tab-theme-layout-window-size-position");
        snapshot(&window, output.join("native-restored.tiff"))?;
    } else {
        wait_for(
            &window,
            "document.body.innerText.includes('No collections yet')",
        )?;
        assert!(db.run(repo::workspace)?.collections.is_empty());
        click(&window, "[aria-label=\"Create collection\"]")?;
        input(&window, "[aria-label=\"Item name\"]", "M3 Native QA")?;
        evaluate(
            &window,
            "document.querySelector('.tree-create-form').requestSubmit(); true",
        )?;
        wait_for(
            &window,
            "document.querySelector('.data-tree-row')?.textContent.includes('M3 Native QA')===true",
        )?;
        click(&window, ".request-tabs-bar > [aria-label=\"New request\"]")?;
        wait_for(&window, "!!document.querySelector('.new-request-form')")?;
        input(&window, "[aria-label=\"Request Name\"]", "Native HTTP")?;
        evaluate(
            &window,
            "document.querySelector('.new-request-form').requestSubmit(); true",
        )?;
        wait_for(&window, "document.querySelector('.new-request-form')===null && !!document.querySelector('[aria-label=\"Request URL\"]')")?;
        send(&window, &format!("{base}/gzip"), "200 OK")?;
        wait_for(&window,"document.querySelector('[data-testid=\"response-body-text\"]')?.textContent.includes('日本語')===true")?;
        // Repeated headers really traversed reqwest and Tauri IPC.
        click(
            &window,
            "[aria-label=\"Response sections\"] [role=\"tab\"]:last-child",
        )?;
        wait_for(&window,"Array.from(document.querySelectorAll('[aria-label=\"Response headers\"] tbody tr')).filter(e=>e.textContent.includes('x-repeat')).length===2")?;
        checks.push("native-send-gzip-unicode-duplicate-headers");
        send(&window, &format!("{base}/html"), "Read only")?;
        wait_for(&window,"document.querySelector('[data-testid=\"response-body-text\"]')?.textContent.includes('<script>')===true")?;
        if evaluate(&window, "globalThis.injected===true")? == true {
            return Err("HTML executed".into());
        }
        send(&window, &format!("{base}/empty"), "Empty response body")?;
        send(
            &window,
            &format!("{base}/error"),
            "500 Internal Server Error",
        )?;
        send(&window, &format!("{base}/large"), "Preview truncated")?;
        checks.push("native-html-inert-empty-http-500-bounded-preview");
        send(&window, &format!("{base}/slow"), "Sending request")?;
        text_button(&window, "Cancel request")?;
        wait_for(&window,"document.querySelector('[data-testid=\"response-pane\"]')?.textContent.includes('Request cancelled')===true")?;
        send(&window, &format!("{base}/json"), "200 OK")?;
        click(&window, "[aria-label=\"Request timeout\"]")?;
        click(
            &window,
            "[role=\"menuitemradio\"][aria-label=\"5 s timeout\"]",
        )?;
        send(&window, &format!("{base}/slow"), "Request timed out")?;
        send(
            &window,
            &tls,
            "TLS negotiation or certificate verification failed",
        )?;
        checks.push("native-cancel-resend-total-timeout-untrusted-tls-rejected");
        db.run(|c|{c.execute_batch("CREATE TRIGGER qa_history_failure BEFORE INSERT ON request_history BEGIN SELECT RAISE(ABORT,'qa failure'); END;")?;Ok(())})?;
        send(
            &window,
            &format!("{base}/json"),
            "history could not be saved",
        )?;
        wait_for(&window,"document.querySelector('[data-testid=\"response-body-text\"]')?.textContent.includes('日本語')===true")?;
        db.run(|c| {
            c.execute_batch("DROP TRIGGER qa_history_failure")?;
            Ok(())
        })?;
        checks.push("history-failure-keeps-native-response");
        for theme in ["Light", "Dark"] {
            click(&window, "[aria-label=\"Change theme\"]")?;
            evaluate(&window,&format!("Array.from(document.querySelectorAll('[role=\"menuitemradio\"]')).find(e=>e.textContent.trim()==='{theme}').click();true"))?;
            wait_for(&window,&format!("document.documentElement.dataset.theme==='{}' && document.fonts.status==='loaded'",theme.to_lowercase()))?;
            snapshot(
                &window,
                output.join(format!("native-http-{}.tiff", theme.to_lowercase())),
            )?;
        }
        input(
            &window,
            "[aria-label=\"Request URL\"]",
            "/saved-before-quit",
        )?;
        app.emit_to("main", "shell-action", "save-request")?;
        wait_for(&window, "!document.querySelector('.dirty-dot')")?;
        input(&window, "[aria-label=\"Request URL\"]", "/saved-on-quit")?;
        window.close()?;
        wait_for(
            &window,
            "document.querySelector('[role=dialog]')?.textContent.includes('Quit PostMen')===true",
        )?;
        snapshot(&window, output.join("native-quit-unsaved.tiff"))?;
        text_button(&window, "Cancel")?;
        wait_for(
            &window,
            "!document.querySelector('[role=dialog]') && !!document.querySelector('.dirty-dot')",
        )?;
        checks.push("actual-native-window-close-cancel-keeps-draft");
        db.run(|c|{c.execute_batch("CREATE TRIGGER qa_quit_save_failure BEFORE UPDATE ON requests BEGIN SELECT RAISE(ABORT,'qa failure'); END;")?;Ok(())})?;
        crate::lifecycle::request_quit(app);
        text_button(&window, "Save All and Quit")?;
        wait_for(&window,"!!document.querySelector('[role=dialog] [role=alert]') && !!document.querySelector('.dirty-dot')")?;
        if db
            .run(|c| {
                let w = repo::workspace(c)?;
                repo::get_request(c, &w.requests[0].id)
            })?
            .url
            != "/saved-before-quit"
        {
            return Err("Failed Quit save mutated stored request".into());
        }
        snapshot(&window, output.join("native-quit-save-failure.tiff"))?;
        db.run(|c| {
            c.execute_batch("DROP TRIGGER qa_quit_save_failure")?;
            Ok(())
        })?;
        text_button(&window, "Cancel")?;
        wait_for(&window, "!document.querySelector('[role=dialog]')")?;
        checks.push("quit-save-failure-keeps-window-draft-and-saved-record");
        app.emit_to("main", "shell-action", "toggle-layout")?;
        wait_for(&window,"document.querySelector('[data-testid=\"split-panes\"]')?.dataset.orientation==='vertical'")?;
        window.set_size(tauri::LogicalSize::new(1100.0, 720.0))?;
        window.set_position(tauri::LogicalPosition::new(80.0, 90.0))?;
        wait_for(&window, "innerWidth===1100 && innerHeight===720")?;
        let size = window.inner_size()?;
        let position = window.outer_position()?;
        std::fs::write(
            std::env::var("POSTMEN_SMOKE_EXPECTED_WINDOW")?,
            serde_json::to_vec(
                &json!({"width":size.width,"height":size.height,"x":position.x,"y":position.y}),
            )?,
        )?;
        let history = ipc(
            &window,
            "list_history",
            json!({"input":{"requestId":null,"limit":100,"offset":0}}),
        )?;
        if history["ok"] != true {
            return Err("Native history IPC failed".into());
        }
        let rows = history["value"].as_array().ok_or("No history")?;
        for outcome in ["success", "error", "cancelled"] {
            if !rows.iter().any(|r| r["outcome"] == outcome) {
                return Err(format!("Missing history {outcome}").into());
            }
        }
        checks.push("native-history-success-error-cancel");
    }
    // Report before exit; parent verifies actual process termination and next launch.
    std::fs::write(
        output.join("native-smoke.json"),
        serde_json::to_string_pretty(
            &json!({"milestone":"M3","nativeDesktop":true,"restoreProcess":restore,"checks":checks,"initial":initial,"final":geometry(&window)?,"exitExpected":if restore {"explicit-discard-and-quit"}else{"successful-save-all-and-quit"},"limitations":["DOM input/Rust close dispatch, not physical menu accelerators or traffic-light clicks.","WKWebView captures omit native traffic lights; OS picker selection remains manual."]}),
        )?,
    )?;
    if restore {
        send(&window, &format!("{base}/slow"), "Sending request")?;
        window.close()?;
        text_button(&window, "Discard and Quit")?;
    } else {
        window.close()?;
        text_button(&window, "Save All and Quit")?;
    }
    thread::sleep(Duration::from_secs(12));
    Err("Application did not exit through the native Quit guard".into())
}
