//! Opt-in QA of this app's own WKWebView. No accessibility or screen capture
//! permission, external app inspection, HTTP endpoint, or frontend IPC is added.
use block2::RcBlock;
use objc2_app_kit::NSImage;
use objc2_foundation::NSError;
use objc2_web_kit::WKWebView;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
#[path = "native_smoke_m3.rs"]
mod m3;
#[path = "native_smoke_m4.rs"]
mod m4;
#[path = "native_smoke_os.rs"]
mod os;

type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

fn evaluate(window: &WebviewWindow, script: &str) -> Result<Value> {
    let (tx, rx) = mpsc::channel();
    window.eval_with_callback(script, move |result| {
        let _ = tx.send(result);
    })?;
    Ok(serde_json::from_str(
        &rx.recv_timeout(Duration::from_secs(8))?,
    )?)
}

fn wait_for(window: &WebviewWindow, condition: &str) -> Result<()> {
    let started = Instant::now();
    loop {
        // WKWebView queues scripts before its first load but drops callbacks.
        // Retry readiness checks until navigation and the Vue bootstrap finish.
        let state = evaluate(window, condition);
        if matches!(&state, Ok(Value::Bool(true))) {
            return Ok(());
        }
        if started.elapsed() > Duration::from_secs(20) {
            return Err(format!("Timed out: {condition}; last evaluation: {state:?}").into());
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn snapshot(window: &WebviewWindow, path: PathBuf) -> Result<()> {
    let (tx, rx) = mpsc::channel::<std::result::Result<(), String>>();
    window.with_webview(move |platform| {
        // Tauri runs this closure on the UI thread and owns the WKWebView.
        let view = unsafe { &*(platform.inner() as *const WKWebView) };
        let callback = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
            let result = if !error.is_null() || image.is_null() {
                Err("WKWebView snapshot failed".to_string())
            } else {
                // Image is retained by WebKit for the duration of this callback.
                unsafe { &*image }
                    .TIFFRepresentation()
                    .ok_or_else(|| "No TIFF representation".to_string())
                    .and_then(|data| {
                        std::fs::write(&path, data.to_vec()).map_err(|e| e.to_string())
                    })
            };
            let _ = tx.send(result);
        });
        unsafe {
            view.takeSnapshotWithConfiguration_completionHandler(None, &callback);
        }
    })?;
    rx.recv_timeout(Duration::from_secs(10))?
        .map_err(Into::into)
}

fn click(window: &WebviewWindow, selector: &str) -> Result<()> {
    let selector = serde_json::to_string(selector)?;
    wait_for(window, &format!("!!document.querySelector({selector})"))?;
    evaluate(
        window,
        &format!("document.querySelector({selector}).click(); true"),
    )?;
    Ok(())
}
fn input(window: &WebviewWindow, selector: &str, value: &str) -> Result<()> {
    let selector = serde_json::to_string(selector)?;
    let value = serde_json::to_string(value)?;
    wait_for(window, &format!("!!document.querySelector({selector})"))?;
    evaluate(window, &format!("(() => {{const e=document.querySelector({selector}); e.value={value}; e.dispatchEvent(new Event('input',{{bubbles:true}})); return true;}})()"))?;
    Ok(())
}
fn ipc(window: &WebviewWindow, command: &str, args: Value) -> Result<Value> {
    let command = serde_json::to_string(command)?;
    evaluate(window, &format!("globalThis.__postmenQaResult=null; window.__TAURI_INTERNALS__.invoke({command},{args}).then(value=>globalThis.__postmenQaResult={{ok:true,value}},error=>globalThis.__postmenQaResult={{ok:false,error}}); true"))?;
    wait_for(window, "globalThis.__postmenQaResult !== null")?;
    evaluate(window, "globalThis.__postmenQaResult")
}
fn geometry(window: &WebviewWindow) -> Result<Value> {
    evaluate(
        window,
        r#"(() => ({viewport:{width:innerWidth,height:innerHeight},dpr:devicePixelRatio,theme:document.documentElement.dataset.theme,userAgent:navigator.userAgent,elements:['.app-titlebar','.status-bar','[data-testid="sidebar"]','.query-url-wrapper','[data-testid="request-pane"]','[data-testid="response-pane"]'].flatMap(selector=>{const e=document.querySelector(selector);if(!e)return [];const r=e.getBoundingClientRect();const s=getComputedStyle(e);return [{selector,x:r.x,y:r.y,width:r.width,height:r.height,background:s.backgroundColor,font:s.fontFamily}];})}))()"#,
    )
}
fn run(app: &AppHandle, output: PathBuf) -> Result<()> {
    use crate::db::{repository as repo, Database};
    let window = app.get_webview_window("main").ok_or("No main window")?;
    wait_for(
        &window,
        "document.querySelector('[data-testid=\"app-shell\"]')?.dataset.connection === 'connected'",
    )?;
    let restore = std::env::var("POSTMEN_SMOKE_RESTORE").is_ok_and(|v| v == "1");
    let db = app.state::<Database>();
    let mut checks = vec![
        "native-bootstrap-round-trip",
        "real-sqlite-not-browser-fixture",
    ];
    let body = "{\n  \"name\": \"Native 日本語\",\n  \"active\": true\n}";
    if restore {
        wait_for(&window, "document.querySelector('[aria-label=\"Request URL\"]')?.value === '/native/saved' && document.querySelector('.cm-content')?.textContent.includes('Native 日本語') === true")?;
        db.run(|c| {
            let workspace = repo::workspace(c)?;
            assert_eq!(workspace.collections.len(), 1);
            assert_eq!(workspace.requests.len(), 1);
            assert_eq!(workspace.session.tab_ids.len(), 1);
            let request = repo::get_request(c, &workspace.requests[0].id)?;
            assert_eq!(request.body, body);
            assert_eq!(request.url, "/native/saved");
            assert_eq!(request.headers[0].name, "X-Native");
            assert_eq!(request.headers[0].value, "kept");
            Ok(())
        })?;
        checks.push("second-native-process-restores-sqlite-request-tabs-body-headers");
    } else {
        wait_for(
            &window,
            "document.body.innerText.includes('No collections yet')",
        )?;
        db.run(|c| {
            assert!(repo::workspace(c)?.collections.is_empty());
            Ok(())
        })?;
        checks.push("fresh-empty-new-database");
        snapshot(&window, output.join("native-empty.tiff"))?;
        click(&window, "[aria-label=\"Create collection\"]")?;
        input(&window, "[aria-label=\"Item name\"]", "Native QA")?;
        evaluate(
            &window,
            "document.querySelector('.tree-create-form').requestSubmit(); true",
        )?;
        wait_for(
            &window,
            "document.querySelector('.data-tree-row')?.textContent.includes('Native QA') === true",
        )?;
        click(&window, ".request-tabs-bar > [aria-label=\"New request\"]")?;
        wait_for(&window, "!!document.querySelector('.new-request-form')")?;
        input(&window, "[aria-label=\"Request Name\"]", "Native request")?;
        evaluate(
            &window,
            "document.querySelector('.new-request-form').requestSubmit(); true",
        )?;
        wait_for(&window, "document.querySelector('.new-request-form')===null && !!document.querySelector('[aria-label=\"Request URL\"]')")?;
        input(&window, "[aria-label=\"Request URL\"]", "/native/saved")?;
        evaluate(&window, "Array.from(document.querySelectorAll('[role=tab]')).find(e=>e.textContent.trim()==='Headers').click(); true")?;
        wait_for(&window, "Array.from(document.querySelectorAll('button')).some(e=>e.textContent.trim()==='Add header')")?;
        evaluate(&window, "Array.from(document.querySelectorAll('button')).find(e=>e.textContent.trim()==='Add header').click(); true")?;
        input(
            &window,
            "[aria-label=\"Request headers name 1\"]",
            "X-Native",
        )?;
        input(&window, "[aria-label=\"Request headers value 1\"]", "kept")?;
        evaluate(&window, "Array.from(document.querySelectorAll('[role=tab]')).find(e=>e.textContent.trim()==='Body').click(); true")?;
        wait_for(
            &window,
            "!!document.querySelector('[aria-label=\"Body type\"]')",
        )?;
        evaluate(&window, "(() => {const e=document.querySelector('[aria-label=\"Body type\"]');e.value='json';e.dispatchEvent(new Event('change',{bubbles:true}));return true;})()")?;
        wait_for(&window, "!!document.querySelector('.cm-content')")?;
        evaluate(&window, &format!("document.querySelector('.cm-content').focus();document.execCommand('insertText',false,{});true", serde_json::to_string(body)?))?;
        wait_for(
            &window,
            "document.querySelector('.cm-content')?.textContent.includes('Native 日本語') === true",
        )?;
        app.emit_to("main", "shell-action", "save-request")?;
        wait_for(&window, "!document.querySelector('.dirty-dot') && !document.querySelector('[aria-label=\"Saving request\"]')")?;
        let workspace = db.run(repo::workspace)?;
        let request = db.run(|c| repo::get_request(c, &workspace.requests[0].id))?;
        if request.body != body || request.url != "/native/saved" || request.headers.len() != 1 {
            return Err("Native UI edits were not saved verbatim in SQLite".into());
        }
        checks.push("vue-create-collection-request-json-header-to-sqlite");
        checks.push("native-menu-save-event-round-trip");
        // Inject a scoped failure into the temporary QA database only.
        db.run(|c| {c.execute_batch("CREATE TRIGGER qa_save_failure BEFORE UPDATE ON requests BEGIN SELECT RAISE(ABORT,'qa failure'); END;")?;Ok(())})?;
        input(&window, "[aria-label=\"Request URL\"]", "/native/unsaved")?;
        app.emit_to("main", "shell-action", "save-request")?;
        wait_for(&window, "!!document.querySelector('.error-notice') && !!document.querySelector('.dirty-dot') && !document.querySelector('[aria-label=\"Saving request\"]')")?;
        if db.run(|c| repo::get_request(c, &request.id))?.url != "/native/saved" {
            return Err("Failed save changed the stored request".into());
        }
        snapshot(&window, output.join("native-save-failure.tiff"))?;
        db.run(|c| {
            c.execute_batch("DROP TRIGGER qa_save_failure")?;
            Ok(())
        })?;
        click(&window, "[aria-label=\"Dismiss error\"]")?;
        app.emit_to("main", "shell-action", "close-request")?;
        wait_for(&window, "document.querySelector('[role=dialog]')?.textContent.includes('Unsaved Changes') === true")?;
        snapshot(&window, output.join("native-unsaved-close.tiff"))?;
        evaluate(&window, "Array.from(document.querySelectorAll('[role=dialog] button')).find(e=>e.textContent.trim()==='Cancel').click(); true")?;
        wait_for(&window, "!document.querySelector('[role=dialog]')")?;
        wait_for(
            &window,
            "document.querySelector('[aria-label=\"Request URL\"]')?.value === '/native/unsaved'",
        )?;
        input(&window, "[aria-label=\"Request URL\"]", "/native/saved")?;
        app.emit_to("main", "shell-action", "save-request")?;
        wait_for(&window, "!document.querySelector('.dirty-dot') && !document.querySelector('[aria-label=\"Saving request\"]')")?;
        checks.push("failed-sqlite-save-keeps-draft-and-saved-record");
        checks.push("native-close-event-dirty-modal-cancel-keeps-draft");
        let invalid = ipc(
            &window,
            "save_environment",
            json!({"input":{"id":null,"collectionId":null,"name":"","variables":[],"revision":null}}),
        )?;
        if invalid["ok"] != false || invalid["error"]["code"] != "INVALID_INPUT" {
            return Err("Invalid input was not rejected over native IPC".into());
        }
        let environment = ipc(
            &window,
            "save_environment",
            json!({"input":{"id":null,"collectionId":null,"name":"Temporary QA","variables":[],"revision":null}}),
        )?;
        if environment["ok"] != true {
            return Err("Environment IPC failed".into());
        }
        let deleted = ipc(
            &window,
            "delete_environment",
            json!({"id":environment["value"]["id"]}),
        )?;
        if deleted["ok"] != true {
            return Err("Environment delete IPC failed".into());
        }
        let workspace = ipc(&window, "load_workspace", json!({}))?;
        if workspace["ok"] != true || workspace["value"]["attachments"] != json!([]) {
            return Err("Attachment metadata IPC failed".into());
        }
        checks.push("native-typed-error-environment-crud-and-attachment-metadata-ipc");
        // Wait on the actual stored session instead of assuming a debounce delay.
        let started = Instant::now();
        while db.run(repo::workspace)?.session.tab_ids.len() != 1 {
            if started.elapsed() > Duration::from_secs(10) {
                return Err("Session not persisted".into());
            }
            thread::sleep(Duration::from_millis(100));
        }
    }
    let mut captures = Vec::new();
    for theme in ["Light", "Dark"] {
        click(&window, "[aria-label=\"Change theme\"]")?;
        wait_for(&window, "!!document.querySelector('[role=\"menu\"]')")?;
        evaluate(&window, &format!("Array.from(document.querySelectorAll('[role=\"menuitemradio\"]')).find(e => e.textContent.trim() === '{theme}').click(); true"))?;
        wait_for(&window, &format!("document.documentElement.dataset.theme === '{}' && document.fonts.status === 'loaded'", theme.to_lowercase()))?;
        captures.push(geometry(&window)?);
        snapshot(
            &window,
            output.join(format!("native-editor-{}.tiff", theme.to_lowercase())),
        )?;
    }
    checks.push("light-dark-native-codemirror-rendering");
    app.emit_to("main", "shell-action", "about")?;
    wait_for(
        &window,
        "document.querySelector('[role=\"dialog\"]')?.textContent.includes('Tauri · M2') === true",
    )?;
    snapshot(&window, output.join("native-about-dark.tiff"))?;
    click(&window, "[aria-label=\"Close dialog\"]")?;
    wait_for(&window, "!document.querySelector('[role=\"dialog\"]')")?;
    app.emit_to("main", "shell-action", "toggle-sidebar")?;
    wait_for(
        &window,
        "!document.querySelector('[data-testid=\"sidebar\"]')",
    )?;
    app.emit_to("main", "shell-action", "toggle-sidebar")?;
    wait_for(
        &window,
        "!!document.querySelector('[data-testid=\"sidebar\"]')",
    )?;
    checks.push("native-shell-action-sidebar-round-trip");
    window.set_size(tauri::LogicalSize::new(700.0, 400.0))?;
    wait_for(&window, "innerWidth === 700 && innerHeight === 400")?;
    snapshot(&window, output.join("native-small-dark.tiff"))?;
    window.minimize()?;
    thread::sleep(Duration::from_millis(250));
    if !window.is_minimized()? {
        return Err("Native minimize failed".into());
    }
    window.unminimize()?;
    checks.push("native-resize-and-minimize-restore");
    let report = json!({"milestone":"M2","restoreProcess":restore,"nativeDesktop":true,"runtime":"Tauri / macOS WKWebView","checks":checks,"captures":captures,"limitations":["WKWebView snapshots exclude native traffic lights.","UI DOM input and Rust menu event dispatch tested, not physical OS menu shortcuts or titlebar drag.","Native file picker is implemented; selecting/cancelling through OS dialog needs manual QA.","No HTTP or full native unsaved-Quit guard until M3."]});
    std::fs::write(
        output.join("native-smoke.json"),
        serde_json::to_string_pretty(&report)?,
    )?;
    println!("POSTMEN_NATIVE_SMOKE_OK {}", output.display());
    Ok(())
}

/// Called before registering the database or allowing the renderer to initialize it.
pub fn prepare() -> Result<PathBuf> {
    let output = PathBuf::from(std::env::var("POSTMEN_SMOKE_DIR")?);
    let database = PathBuf::from(std::env::var("POSTMEN_SMOKE_DATABASE_DIR")?);
    let temporary = std::env::temp_dir().canonicalize()?;
    for path in [&output, &database] {
        if !path.is_absolute()
            || !path.is_dir()
            || !path.canonicalize()?.starts_with(&temporary)
            || !path.file_name().is_some_and(|n| {
                n.to_string_lossy().starts_with("postmen-m2-")
                    || n.to_string_lossy().starts_with("postmen-m3-")
                    || n.to_string_lossy().starts_with("postmen-m4-")
            })
        {
            return Err("Native smoke requires explicit postmen-m2-* directories under the OS temporary directory".into());
        }
    }
    if output == database || std::fs::read_dir(&output)?.next().is_some() {
        return Err(
            "POSTMEN_SMOKE_DIR must be empty and separate from the QA database directory".into(),
        );
    }
    Ok(database)
}
pub fn start(app: AppHandle) -> Result<()> {
    let output = PathBuf::from(std::env::var("POSTMEN_SMOKE_DIR")?);
    thread::spawn(move || {
        if std::env::var("POSTMEN_SMOKE_MILESTONE").is_ok_and(|value| value == "M4_OS") {
            if let Err(error) = os::run(&app, output) {
                eprintln!("POSTMEN_NATIVE_SMOKE_FAILED: {error}");
                app.exit(1);
            }
            return;
        }
        if std::env::var("POSTMEN_SMOKE_MILESTONE").is_ok_and(|value| value == "M4") {
            if let Err(error) = m4::run(&app, output) {
                eprintln!("POSTMEN_NATIVE_SMOKE_FAILED: {error}");
                app.exit(1);
            }
            return;
        }
        if std::env::var("POSTMEN_SMOKE_MILESTONE").is_ok_and(|value| value == "M3") {
            if let Err(error) = m3::run(&app, output) {
                eprintln!("POSTMEN_NATIVE_SMOKE_FAILED: {error}");
                app.exit(1);
            }
            // M3 must terminate via the real close guard / finish_quit command.
            return;
        }
        let result = run(&app, output);
        let code = if let Err(error) = result {
            eprintln!("POSTMEN_NATIVE_SMOKE_FAILED: {error}");
            1
        } else {
            0
        };
        app.exit(code);
    });
    Ok(())
}
