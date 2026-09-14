//! Pinned visual dataset in an isolated real SQLite database, real Rust HTTP.
use super::*;
fn command(window: &WebviewWindow, name: &str, args: Value) -> Result<Value> {
    let result = ipc(window, name, args)?;
    if result["ok"] != true {
        return Err(format!("QA command {name} failed: {result}").into());
    }
    Ok(result["value"].clone())
}
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
fn theme(window: &WebviewWindow, name: &str) -> Result<()> {
    click(window, "[aria-label=\"Change theme\"]")?;
    click(
        window,
        &format!("[role=\"menuitemradio\"][aria-label=\"{name}\"]"),
    )?;
    wait_for(
        window,
        &format!(
            "document.documentElement.dataset.theme==='{}'",
            name.to_lowercase()
        ),
    )
}
fn capture(
    window: &WebviewWindow,
    output: &std::path::Path,
    name: &str,
    captures: &mut Vec<Value>,
) -> Result<()> {
    wait_for(window, "document.fonts.status==='loaded'")?;
    thread::sleep(Duration::from_millis(300));
    let metrics = evaluate(
        window,
        r#"(() => ({ viewport:{width:innerWidth,height:innerHeight},devicePixelRatio,theme:document.documentElement.dataset.theme,elements:['.app-titlebar','.status-bar','[data-testid="sidebar"]','.query-url-wrapper','[data-testid="request-pane"]','[data-testid="response-pane"]','.pane-divider','.pane-toolbar','.cm-editor','.cm-line','[role="dialog"]'].flatMap(selector=>Array.from(document.querySelectorAll(selector)).flatMap(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width&&r.height?[{selector,text:e.textContent.trim().slice(0,80),x:r.x,y:r.y,width:r.width,height:r.height,font:s.fontFamily,fontSize:s.fontSize,lineHeight:s.lineHeight,color:s.color,background:s.backgroundColor}]:[];}))}))()"#,
    )?;
    snapshot(window, output.join(format!("{name}.tiff")))?;
    let mut entry = metrics;
    entry["name"] = json!(name);
    entry["file"] = json!(format!("{name}.png"));
    captures.push(entry);
    println!("M4 native captured {name}");
    Ok(())
}
fn send(window: &WebviewWindow, path: &str) -> Result<()> {
    wait_for(window, &format!("document.querySelector('[aria-label=\"Request URL\"]')?.value==='http://127.0.0.1:43119{path}'"))?;
    text_button(window, "Send")?;
    wait_for(
        window,
        "!!document.querySelector('[data-testid=\"response-body-text\"]')",
    )
}
pub(super) fn run(app: &AppHandle, output: PathBuf) -> Result<()> {
    let window = app.get_webview_window("main").ok_or("No main window")?;
    wait_for(&window, "document.querySelector('[data-testid=\"app-shell\"]')?.dataset.connection==='connected' && document.body.innerText.includes('No collections yet')")?;
    let initial = geometry(&window)?;
    window.set_size(tauri::LogicalSize::new(1440.0, 840.0))?;
    thread::sleep(Duration::from_millis(400));
    let resized = geometry(&window)?;
    let mut captures = Vec::new();
    for name in ["Light", "Dark"] {
        theme(&window, name)?;
        capture(
            &window,
            &output,
            &format!("empty-{}", name.to_lowercase()),
            &mut captures,
        )?;
    }
    click(&window, "[aria-label=\"Change theme\"]")?;
    capture(&window, &output, "theme-dropdown-dark", &mut captures)?;
    theme_close(&window)?;
    click(&window, "[aria-label=\"Create collection\"]")?;
    capture(
        &window,
        &output,
        "create-collection-inline-dark",
        &mut captures,
    )?;
    text_button(&window, "Cancel")?;
    let collection = command(
        &window,
        "create_collection",
        json!({"input":{"name":"PostMen Reference"}}),
    )?;
    let assets = command(
        &window,
        "create_folder",
        json!({"input":{"collectionId":collection["id"],"parentId":null,"name":"Assets"}}),
    )?;
    let users = command(
        &window,
        "create_folder",
        json!({"input":{"collectionId":collection["id"],"parentId":null,"name":"Users"}}),
    )?;
    let row = |name: &str, value: &str| json!({"id":uuid::Uuid::new_v4().to_string(),"enabled":true,"name":name,"value":value,"description":""});
    for (name, path, folder) in [
        (
            "List users",
            "/users?limit=10&active=true",
            users["id"].clone(),
        ),
        ("Create user", "/users", users["id"].clone()),
        ("Slow response", "/slow", Value::Null),
        ("Server error", "/error", Value::Null),
        ("Upload asset", "/upload", assets["id"].clone()),
    ] {
        let mut request = command(
            &window,
            "create_request",
            json!({"input":{"collectionId":collection["id"],"folderId":folder,"name":name}}),
        )?;
        request["url"] = json!(format!("http://127.0.0.1:43119{path}"));
        if name == "List users" {
            request["params"] = json!([row("limit", "10"), row("active", "true")]);
            request["headers"] = json!([
                row("Accept", "application/json"),
                row("X-Workspace", "PostMen")
            ]);
        }
        if name == "Create user" {
            request["method"] = json!("POST");
            request["bodyKind"] = json!("json");
            request["body"]=json!("{\n  \"name\": \"Alex Morgan\",\n  \"email\": \"alex@example.com\",\n  \"active\": true\n}");
            request["headers"] = json!([row("Content-Type", "application/json")]);
        }
        if name == "Upload asset" {
            request["method"] = json!("POST");
            request["bodyKind"] = json!("multipart");
            let mut field = row("description", "Profile picture");
            field["kind"] = json!("text");
            field["attachmentId"] = Value::Null;
            request["formData"] = json!([field]);
        }
        command(&window, "save_request", json!({"input":request}))?;
    }
    evaluate(&window, "location.reload(); true")?;
    wait_for(&window,"Array.from(document.querySelectorAll('.data-tree-row')).some(e=>e.textContent.trim()==='GETList users')")?;
    text_button(&window, "Assets")?;
    text_button(&window, "GETList users")?;
    wait_for(
        &window,
        "!!document.querySelector('[data-testid=\"request-pane\"]')",
    )?;
    capture(&window, &output, "params-dark", &mut captures)?;
    click(&window, "[aria-label=\"HTTP method\"]")?;
    capture(&window, &output, "method-dropdown-dark", &mut captures)?;
    theme_close(&window)?;
    send(&window, "/users?limit=10&active=true")?;
    capture(&window, &output, "response-dark", &mut captures)?;
    click(
        &window,
        "[aria-label=\"Response sections\"] [role=tab]:last-child",
    )?;
    click(
        &window,
        "[aria-label=\"Request sections\"] [role=tab]:last-child",
    )?;
    capture(&window, &output, "headers-dark", &mut captures)?;
    text_button(&window, "POSTCreate user")?;
    wait_for(
        &window,
        "!!document.querySelector('[data-testid=\"json-editor-input\"]')",
    )?;
    send(&window, "/users")?;
    for name in ["Dark", "Light"] {
        theme(&window, name)?;
        capture(
            &window,
            &output,
            &format!("json-body-response-{}", name.to_lowercase()),
            &mut captures,
        )?;
        capture(
            &window,
            &output,
            &format!("json-body-response-{}-repeat", name.to_lowercase()),
            &mut captures,
        )?;
    }
    theme(&window, "Dark")?;
    text_button(&window, "Assets")?;
    text_button(&window, "POSTUpload asset")?;
    capture(&window, &output, "multipart-dark", &mut captures)?;
    text_button(&window, "GETServer error")?;
    send(&window, "/error")?;
    capture(&window, &output, "server-error-dark", &mut captures)?;
    text_button(&window, "GETSlow response")?;
    wait_for(&window,"document.querySelector('[aria-label=\"Request URL\"]')?.value==='http://127.0.0.1:43119/slow'")?;
    text_button(&window, "Send")?;
    wait_for(
        &window,
        "document.body.innerText.includes('Sending request')",
    )?;
    capture(&window, &output, "loading-dark", &mut captures)?;
    text_button(&window, "Cancel request")?;
    text_button(&window, "POSTCreate user")?;
    evaluate(&window,"Array.from(document.querySelectorAll('.data-tree-row')).find(e=>e.textContent.trim()==='POSTCreate user').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:140,clientY:200}));true")?;
    capture(&window, &output, "request-context-menu-dark", &mut captures)?;
    click(&window, "[role=menuitem][aria-label=\"Delete request\"]")?;
    capture(&window, &output, "delete-request-modal-dark", &mut captures)?;
    text_button(&window, "Cancel")?;
    click(&window, "[aria-label=\"Toggle response layout\"]")?;
    capture(&window, &output, "vertical-layout-dark", &mut captures)?;
    click(&window, "[aria-label=\"Toggle response layout\"]")?;
    click(&window, "[aria-label=\"Toggle sidebar\"]")?;
    capture(&window, &output, "sidebar-collapsed-dark", &mut captures)?;
    let monitor = window.current_monitor()?.ok_or("No display")?;
    let area = monitor
        .work_area()
        .size
        .to_logical::<f64>(monitor.scale_factor());
    let mut additional = Vec::new();
    for (width, height) in [(1440.0, 900.0), (1920.0, 1080.0), (700.0, 400.0)] {
        if width > area.width || height > area.height {
            additional.push(json!({"width":width,"height":height,"captured":false,"reason":"Display work area too small for unclipped native screenshot"}));
            continue;
        }
        window.set_size(tauri::LogicalSize::new(width, height))?;
        window.center()?;
        thread::sleep(Duration::from_millis(400));
        let actual = geometry(&window)?;
        let exact = actual["viewport"]["width"] == width && actual["viewport"]["height"] == height;
        additional.push(json!({"width":width,"height":height,"captured":exact,"actual":actual}));
        if exact {
            capture(
                &window,
                &output,
                &format!("viewport-{width}x{height}-dark"),
                &mut captures,
            )?;
        }
    }
    std::fs::write(
        output.join("native-smoke.json"),
        serde_json::to_string_pretty(
            &json!({"milestone":"M4","nativeDesktop":true,"runtime":"Tauri macOS WKWebView","initial":initial,"afterExactResize":resized,"captures":captures,"additionalSizes":additional,"workArea":area,"checks":["temporary-real-SQLite","Vue-native-IPC-real-Rust-HTTP","pinned-reference-fixture","light-dark-code-editors","native-menu-dropdown-modal-layout","bounded-size-checks"],"limitations":["WKWebView snapshots exclude OS traffic lights. DOM input is not physical OS keyboard/picker/drag automation.","Request duration/loading timer are real and nondeterministic; screenshots are not masked."]}),
        )?,
    )?;
    window.close()?;
    text_button(&window, "Quit")?;
    thread::sleep(Duration::from_secs(12));
    Err("M4 native window did not quit".into())
}
fn theme_close(window: &WebviewWindow) -> Result<()> {
    evaluate(window,"document.querySelector('[role=menu]')?.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));true")?;
    Ok(())
}
