#![allow(non_snake_case)]

use dioxus::prelude::*;
use dioxus::desktop::{use_wry_event_handler, use_muda_event_handler, tao::event::WindowEvent, window};
use std::collections::HashMap;
use std::sync::Arc;

use crate::models::*;
use crate::services::{Database, HttpService};
use crate::state::*;
use crate::components::*;

#[component]
pub fn App() -> Element {
    // Initialize database
    let db = use_signal(|| Arc::new(Database::new().expect("Failed to initialize database")));

    // State
    let mut projects = use_signal(Vec::<Project>::new);
    let mut requests_map = use_signal(HashMap::<String, Vec<Request>>::new);
    let mut hostnames = use_signal(Vec::<Hostname>::new);
    let mut tabs = use_signal(Vec::<Tab>::new);
    let mut active_tab_index = use_signal(|| 0usize);
    let mut active_request = use_signal(|| None::<Request>);
    let mut responses = use_signal(HashMap::<String, HttpResponse>::new);
    let mut loading_requests = use_signal(HashMap::<String, bool>::new);
    let mut modal = use_signal(|| ModalType::None);
    let mut editor_tab = use_signal(|| EditorTab::Params);
    let mut response_tab = use_signal(|| ResponseTab::Result);
    let mut search_query = use_signal(String::new);
    let mut response_panel_width = use_signal(|| 380i32);
    let mut is_resizing = use_signal(|| false);
    let mut resize_start_x = use_signal(|| 0i32);
    let mut resize_start_width = use_signal(|| 380i32);
    let mut request_generations = use_signal(HashMap::<String, u64>::new);

    // Handle window close event - check for unsaved tabs
    use_wry_event_handler(move |event, _| {
        if let dioxus::desktop::tao::event::Event::WindowEvent {
            event: WindowEvent::CloseRequested,
            ..
        } = event
        {
            // Find all unsaved tabs
            let unsaved_indices: Vec<usize> = tabs
                .read()
                .iter()
                .enumerate()
                .filter(|(_, tab)| tab.is_dirty)
                .map(|(idx, _)| idx)
                .collect();

            if unsaved_indices.is_empty() {
                // No unsaved tabs, close immediately
                std::process::exit(0);
            } else {
                // Start confirmation process with first unsaved tab
                let mut remaining = unsaved_indices;
                let first_idx = remaining.remove(0);
                let tab_name = tabs.read().get(first_idx).map(|t| t.name.clone()).unwrap_or_default();
                modal.set(ModalType::ExitUnsavedChanges {
                    tab_index: first_idx,
                    tab_name,
                    remaining_indices: remaining,
                });

                // Show window again with minimal delay
                spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(3)).await;
                    window().set_visible(true);
                    window().set_focus();
                });
            }
        }
    });

    // Handle menu quit event - intercept custom "postmen-quit" menu item
    use_muda_event_handler(move |event| {
        if event.id().0.as_str() == "postmen-quit" {
            // Find all unsaved tabs
            let unsaved_indices: Vec<usize> = tabs
                .read()
                .iter()
                .enumerate()
                .filter(|(_, tab)| tab.is_dirty)
                .map(|(idx, _)| idx)
                .collect();

            if unsaved_indices.is_empty() {
                // No unsaved tabs, exit immediately
                std::process::exit(0);
            } else {
                // Start confirmation process with first unsaved tab
                let mut remaining = unsaved_indices;
                let first_idx = remaining.remove(0);
                let tab_name = tabs.read().get(first_idx).map(|t| t.name.clone()).unwrap_or_default();
                modal.set(ModalType::ExitUnsavedChanges {
                    tab_index: first_idx,
                    tab_name,
                    remaining_indices: remaining,
                });

                // Show window again with minimal delay
                spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(3)).await;
                    window().set_visible(true);
                    window().set_focus();
                });
            }
        }
    });

    // Load initial data
    use_effect(move || {
        let db = db.read().clone();
        spawn(async move {
            if let Ok(p) = db.get_all_projects() {
                projects.set(p.clone());
                let mut map = HashMap::new();
                for project in p.iter() {
                    if let Ok(reqs) = db.get_requests_by_project(&project.id) {
                        map.insert(project.id.clone(), reqs);
                    }
                }
                requests_map.set(map.clone());

                // Load saved tabs
                if let Ok(saved_tab_ids) = db.get_open_tabs() {
                    let mut loaded_tabs = Vec::new();
                    for request_id in saved_tab_ids {
                        if let Ok(Some(req)) = db.get_request_by_id(&request_id) {
                            loaded_tabs.push(Tab {
                                id: uuid::Uuid::new_v4().to_string(),
                                request_id: req.id.clone(),
                                name: req.name.clone(),
                                method: req.method,
                                is_dirty: false,
                            });
                        }
                    }
                    if !loaded_tabs.is_empty() {
                        tabs.set(loaded_tabs.clone());

                        // Load active tab index
                        let saved_index = db.get_active_tab_index().ok().flatten().unwrap_or(0);
                        let idx = if saved_index < loaded_tabs.len() { saved_index } else { 0 };
                        active_tab_index.set(idx);

                        // Load active request
                        if let Some(tab) = loaded_tabs.get(idx) {
                            if let Ok(Some(req)) = db.get_request_by_id(&tab.request_id) {
                                active_request.set(Some(req));
                            }
                        }
                    }
                }
            }
            if let Ok(h) = db.get_all_hostnames() {
                hostnames.set(h);
            }
        });
    });

    // Save tabs when they change
    use_effect(move || {
        let current_tabs = tabs.read().clone();
        let current_idx = *active_tab_index.read();
        let db = db.read().clone();

        spawn(async move {
            let request_ids: Vec<String> = current_tabs.iter().map(|t| t.request_id.clone()).collect();
            let _ = db.save_open_tabs(&request_ids);
            let _ = db.save_active_tab_index(current_idx);
        });
    });

    // Get current request data
    let current_request = active_request.read().clone();
    let current_tabs = tabs.read().clone();
    let current_tab_idx = *active_tab_index.read();
    let selected_request_id = current_tabs.get(current_tab_idx).map(|t| t.request_id.clone());
    let current_hostnames = hostnames.read().clone();
    let current_editor_tab = *editor_tab.read();
    let current_response_tab = *response_tab.read();
    let current_modal = modal.read().clone();

    // Get response and loading state for current request
    let current_response = current_request.as_ref()
        .and_then(|req| responses.read().get(&req.id).cloned());
    let current_is_loading = current_request.as_ref()
        .map(|req| *loading_requests.read().get(&req.id).unwrap_or(&false))
        .unwrap_or(false);

    // Embed CSS at compile time for reliable loading in bundled app
    const MAIN_CSS: &str = include_str!("../assets/styles/main.css");
    // Embed dragon ball image as base64 data URL
    const DRAGON_BALL_PNG: &str = concat!("data:image/png;base64,", include_str!("../assets/images/dragon-ball.base64"));

    rsx! {
        style { {MAIN_CSS} }

        div { class: "app-container",
            // Header
            header { class: "header",
                div { class: "logo-section",
                    img {
                        class: "dragon-ball-logo",
                        src: "{DRAGON_BALL_PNG}",
                        alt: "Dragon Ball"
                    }
                    h1 { class: "app-title", "PostMen" }
                }
                div { class: "header-actions",
                    button {
                        class: "header-icon-btn",
                        title: "Manage Hostnames",
                        onclick: move |_| modal.set(ModalType::HostnameUniverse),
                        svg {
                            width: "18",
                            height: "18",
                            view_box: "0 0 24 24",
                            fill: "none",
                            stroke: "currentColor",
                            stroke_width: "2",
                            stroke_linecap: "round",
                            stroke_linejoin: "round",
                            circle { cx: "12", cy: "12", r: "10" }
                            line { x1: "2", y1: "12", x2: "22", y2: "12" }
                            path { d: "M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" }
                        }
                    }
                }
            }

            // Main content
            div { class: "app-content",
                // Sidebar
                aside { class: "sidebar",
                    div { class: "search-container",
                        input {
                            class: "search-input",
                            r#type: "text",
                            placeholder: "Search request...",
                            value: "{search_query}",
                            spellcheck: "false",
                            autocapitalize: "off",
                            oninput: move |e| search_query.set(e.value())
                        }
                        button {
                            class: "add-button",
                            title: "Add new project",
                            onclick: move |_| {
                                let db = db.read().clone();
                                let new_project = Project::new("New Project".to_string());
                                if db.create_project(&new_project).is_ok() {
                                    let mut p = projects.read().clone();
                                    p.push(new_project.clone());
                                    projects.set(p);
                                    requests_map.write().insert(new_project.id.clone(), Vec::new());
                                }
                            },
                            "+"
                        }
                    }

                    div { class: "project-tree",
                        for project in projects.read().iter() {
                            ProjectItem {
                                project: project.clone(),
                                requests: requests_map.read().get(&project.id).cloned().unwrap_or_default(),
                                search_query: search_query.read().clone(),
                                selected_request_id: selected_request_id.clone(),
                                on_toggle: move |id: String| {
                                    let mut p = projects.read().clone();
                                    if let Some(proj) = p.iter_mut().find(|x| x.id == id) {
                                        proj.is_expanded = !proj.is_expanded;
                                    }
                                    projects.set(p);
                                },
                                on_add_request: move |project_id: String| {
                                    let db = db.read().clone();
                                    let new_request = Request::new(project_id.clone(), "New Request".to_string());
                                    if db.create_request(&new_request).is_ok() {
                                        let mut map = requests_map.read().clone();
                                        map.entry(project_id).or_default().push(new_request);
                                        requests_map.set(map);
                                    }
                                },
                                on_select_request: move |req: Request| {
                                    let mut t = tabs.read().clone();
                                    let existing = t.iter().position(|x| x.request_id == req.id);
                                    if let Some(idx) = existing {
                                        active_tab_index.set(idx);
                                    } else {
                                        t.push(Tab {
                                            id: uuid::Uuid::new_v4().to_string(),
                                            request_id: req.id.clone(),
                                            name: req.name.clone(),
                                            method: req.method,
                                            is_dirty: false,
                                        });
                                        active_tab_index.set(t.len() - 1);
                                        tabs.set(t);
                                    }

                                    let db = db.read().clone();
                                    let req_id = req.id.clone();
                                    spawn(async move {
                                        if let Ok(Some(full_req)) = db.get_request_by_id(&req_id) {
                                            active_request.set(Some(full_req));
                                        } else {
                                            active_request.set(Some(req));
                                        }
                                    });
                                },
                                on_rename_project: move |(id, name): (String, String)| {
                                    modal.set(ModalType::RenameProject { id, current_name: name });
                                },
                                on_delete_project: move |(id, name): (String, String)| {
                                    modal.set(ModalType::DeleteProject { id, name });
                                },
                                on_rename_request: move |(id, name): (String, String)| {
                                    modal.set(ModalType::RenameRequest { id, current_name: name });
                                },
                                on_delete_request: move |(id, name): (String, String)| {
                                    modal.set(ModalType::DeleteRequest { id, name });
                                },
                            }
                        }
                    }
                }

                // Main area
                div { class: "main-area",
                    div { class: "request-tabs-bar",
                        for (idx, tab) in current_tabs.iter().enumerate() {
                            button {
                                class: if idx == current_tab_idx { format!("request-tab active {}", tab.method.css_class()) } else { "request-tab".to_string() },
                                onclick: move |_| {
                                    active_tab_index.set(idx);
                                    let t = tabs.read().clone();
                                    if let Some(tab) = t.get(idx) {
                                        let db = db.read().clone();
                                        let req_id = tab.request_id.clone();
                                        spawn(async move {
                                            if let Ok(Some(req)) = db.get_request_by_id(&req_id) {
                                                active_request.set(Some(req));
                                            }
                                        });
                                    }
                                },
                                span { class: "tab-name", "{tab.name}" }
                                span {
                                    class: "tab-close",
                                    onclick: {
                                        let tab_name = tab.name.clone();
                                        let is_dirty = tab.is_dirty;
                                        move |e: Event<MouseData>| {
                                            e.stop_propagation();
                                            // Check if tab has unsaved changes
                                            if is_dirty {
                                                modal.set(ModalType::UnsavedChanges {
                                                    tab_index: idx,
                                                    tab_name: tab_name.clone()
                                                });
                                            } else {
                                                // Close tab directly
                                                let mut t = tabs.read().clone();
                                                let closed_req_id = t.get(idx).map(|tab| tab.request_id.clone());
                                                t.remove(idx);
                                                tabs.set(t.clone());

                                                if let Some(req_id) = closed_req_id {
                                                    responses.write().remove(&req_id);
                                                    loading_requests.write().remove(&req_id);
                                                    request_generations.write().remove(&req_id);
                                                }

                                                if t.is_empty() {
                                                    active_request.set(None);
                                                } else {
                                                    let new_idx = if idx >= t.len() { t.len() - 1 } else { idx };
                                                    active_tab_index.set(new_idx);
                                                    if let Some(tab) = t.get(new_idx) {
                                                        let db = db.read().clone();
                                                        let req_id = tab.request_id.clone();
                                                        spawn(async move {
                                                            if let Ok(Some(req)) = db.get_request_by_id(&req_id) {
                                                                active_request.set(Some(req));
                                                            }
                                                        });
                                                    }
                                                }
                                            }
                                        }
                                    },
                                    "×"
                                }
                            }
                        }
                    }

                    if current_request.is_some() {
                        div { class: "editor-response-container",
                            RequestUrlBar {
                                request: current_request.clone().unwrap(),
                                hostnames: current_hostnames.clone(),
                                on_update_request: move |req: Request| {
                                    active_request.set(Some(req));
                                    let mut t = tabs.read().clone();
                                    if let Some(tab) = t.get_mut(current_tab_idx) {
                                        tab.is_dirty = true;
                                    }
                                    tabs.set(t);
                                },
                                on_open_hostnames: move |_| {
                                    modal.set(ModalType::HostnameUniverse);
                                },
                            }
                            div {
                                class: if *is_resizing.read() { "editor-content-area resizing" } else { "editor-content-area" },
                                onmousemove: move |e: Event<MouseData>| {
                                    if !*is_resizing.read() {
                                        return;
                                    }
                                    e.prevent_default();
                                    e.stop_propagation();
                                    let current_width = *response_panel_width.read();
                                    let mouse_x = e.client_coordinates().x as i32;
                                    let start_x = *resize_start_x.read();
                                    let start_width = *resize_start_width.read();
                                    let delta = start_x - mouse_x;
                                    let new_width = (start_width + delta).max(380).min(800);

                                    if current_width != new_width {
                                        response_panel_width.set(new_width);
                                        // Reset anchor when hitting boundary
                                        if new_width == 800 || new_width == 380 {
                                            resize_start_x.set(mouse_x);
                                            resize_start_width.set(new_width);
                                        }
                                    }
                                },
                                onmouseup: move |_| {
                                    is_resizing.set(false);
                                },
                                onmouseleave: move |_| {
                                    is_resizing.set(false);
                                },
                                RequestEditor {
                                    request: current_request.clone().unwrap(),
                                    editor_tab: current_editor_tab,
                                    is_loading: current_is_loading,
                                    on_update_request: move |req: Request| {
                                        active_request.set(Some(req));
                                        let mut t = tabs.read().clone();
                                        if let Some(tab) = t.get_mut(current_tab_idx) {
                                            tab.is_dirty = true;
                                        }
                                        tabs.set(t);
                                    },
                                    on_tab_change: move |tab: EditorTab| {
                                        editor_tab.set(tab);
                                    },
                                    on_send: move |_| {
                                        if let Some(req) = active_request.read().clone() {
                                            let req_id = req.id.clone();

                                            // Increment generation for this specific request
                                            let current_gen = *request_generations.read().get(&req_id).unwrap_or(&0) + 1;
                                            request_generations.write().insert(req_id.clone(), current_gen);

                                            // Set loading state for this request
                                            loading_requests.write().insert(req_id.clone(), true);

                                            let db = db.read().clone();
                                            let hostnames = hostnames.read().clone();

                                            spawn(async move {
                                                let base_url = req.hostname_id
                                                    .as_ref()
                                                    .and_then(|id| hostnames.iter().find(|h| &h.id == id))
                                                    .map(|h| h.url.clone())
                                                    .unwrap_or_default();
                                                let full_url = format!("{}{}", base_url, req.path);

                                                let url_with_params = if req.params.is_empty() {
                                                    full_url
                                                } else {
                                                    let params: Vec<String> = req.params
                                                        .iter()
                                                        .filter(|p| p.enabled && !p.key.is_empty())
                                                        .map(|p| format!("{}={}", p.key, p.value))
                                                        .collect();
                                                    if params.is_empty() {
                                                        full_url
                                                    } else {
                                                        format!("{}?{}", full_url, params.join("&"))
                                                    }
                                                };

                                                let headers: Vec<(String, String)> = req.headers
                                                    .iter()
                                                    .filter(|h| h.enabled && !h.key.is_empty())
                                                    .map(|h| (h.key.clone(), h.value.clone()))
                                                    .collect();

                                                // Send request based on body type
                                                let result = match req.body_type {
                                                    BodyType::MultipartFormData => {
                                                        HttpService::send_multipart_request(
                                                            req.method,
                                                            &url_with_params,
                                                            &headers,
                                                            &req.form_data,
                                                        ).await
                                                    }
                                                    BodyType::Json => {
                                                        let body = if req.body.is_empty() { None } else { Some(req.body.as_str()) };
                                                        HttpService::send_request(req.method, &url_with_params, &headers, body).await
                                                    }
                                                };
                                                match result {
                                                    Ok(res) => {
                                                        // Only update if this request wasn't cancelled
                                                        let is_valid = *request_generations.read().get(&req_id).unwrap_or(&0) == current_gen;
                                                        if is_valid {
                                                            responses.write().insert(req_id.clone(), res.clone());
                                                            loading_requests.write().insert(req_id.clone(), false);

                                                            let mut history = RequestHistory::new(
                                                                Some(req.id.clone()),
                                                                req.method.to_string(),
                                                                url_with_params,
                                                                serde_json::to_string(&headers).unwrap_or_default(),
                                                                req.body.clone(),
                                                            );
                                                            history.response_status = Some(res.status);
                                                            history.response_time_ms = Some(res.time_ms);
                                                            history.response_size_bytes = Some(res.size_bytes);
                                                            history.response_headers = Some(serde_json::to_string(&res.headers).unwrap_or_default());
                                                            history.response_body = Some(res.body.clone());
                                                            let _ = db.save_history(&history);
                                                        }
                                                    }
                                                    Err(e) => {
                                                        // Only update if this request wasn't cancelled
                                                        let is_valid = *request_generations.read().get(&req_id).unwrap_or(&0) == current_gen;
                                                        if is_valid {
                                                            responses.write().insert(req_id.clone(), HttpResponse {
                                                                status: 0,
                                                                status_text: "Error".to_string(),
                                                                time_ms: 0,
                                                                size_bytes: e.len(),
                                                                headers: HashMap::new(),
                                                                body: e,
                                                            });
                                                            loading_requests.write().insert(req_id.clone(), false);
                                                        }
                                                    }
                                                }
                                            });
                                        }
                                    },
                                    on_save: move |_| {
                                        if let Some(req) = active_request.read().clone() {
                                            let db = db.read().clone();
                                            spawn(async move {
                                                let _ = db.update_request(&req);
                                                let _ = db.save_request_params(&req.id, &req.params);
                                                let _ = db.save_request_headers(&req.id, &req.headers);
                                                let _ = db.save_form_data_fields(&req.id, &req.form_data);

                                                let mut t = tabs.write();
                                                if let Some(tab) = t.iter_mut().find(|t| t.request_id == req.id) {
                                                    tab.name = req.name.clone();
                                                    tab.method = req.method;
                                                    tab.is_dirty = false;
                                                }

                                                let mut map = requests_map.write();
                                                if let Some(reqs) = map.get_mut(&req.project_id) {
                                                    if let Some(r) = reqs.iter_mut().find(|r| r.id == req.id) {
                                                        *r = req;
                                                    }
                                                }
                                            });
                                        }
                                    },
                                }

                                div {
                                    class: "resize-handle",
                                    onmousedown: move |e: Event<MouseData>| {
                                        e.prevent_default();
                                        resize_start_x.set(e.client_coordinates().x as i32);
                                        resize_start_width.set(*response_panel_width.read());
                                        is_resizing.set(true);
                                    },
                                }

                                ResponsePanel {
                                    response: current_response.clone(),
                                    response_tab: current_response_tab,
                                    is_loading: current_is_loading,
                                    width: *response_panel_width.read(),
                                    on_tab_change: move |tab: ResponseTab| {
                                        response_tab.set(tab);
                                    },
                                    on_clear: move |_| {
                                        if let Some(req) = active_request.read().clone() {
                                            responses.write().remove(&req.id);
                                        }
                                    },
                                    on_cancel: move |_| {
                                        if let Some(req) = active_request.read().clone() {
                                            // Increment generation to invalidate pending request
                                            let new_gen = *request_generations.read().get(&req.id).unwrap_or(&0) + 1;
                                            request_generations.write().insert(req.id.clone(), new_gen);
                                            loading_requests.write().insert(req.id.clone(), false);
                                        }
                                    },
                                }
                            }
                        }
                    } else {
                        div { class: "empty-state",
                            div { class: "empty-dragon-ball",
                                div { class: "empty-ball-shine" }
                                div { class: "empty-star empty-star-1" }
                                div { class: "empty-star empty-star-2" }
                                div { class: "empty-star empty-star-3" }
                                div { class: "empty-star empty-star-4" }
                            }
                            p { "Select a request or create a new one to get started" }
                        }
                    }
                }
            }

            // Modals
            match current_modal {
                ModalType::None => rsx! {},
                ModalType::RenameProject { ref id, ref current_name } => rsx! {
                    RenameModal {
                        title: "Rename Project".to_string(),
                        current_name: current_name.clone(),
                        on_save: {
                            let id = id.clone();
                            move |new_name: String| {
                                let db = db.read().clone();
                                let id = id.clone();
                                spawn(async move {
                                    let mut p = projects.read().clone();
                                    if let Some(proj) = p.iter_mut().find(|x| x.id == id) {
                                        proj.name = new_name;
                                        let _ = db.update_project(proj);
                                    }
                                    projects.set(p);
                                    modal.set(ModalType::None);
                                });
                            }
                        },
                        on_cancel: move |_| modal.set(ModalType::None),
                    }
                },
                ModalType::RenameRequest { ref id, ref current_name } => rsx! {
                    RenameModal {
                        title: "Rename Item".to_string(),
                        current_name: current_name.clone(),
                        on_save: {
                            let id = id.clone();
                            move |new_name: String| {
                                let db = db.read().clone();
                                let id = id.clone();
                                spawn(async move {
                                    if let Ok(Some(mut req)) = db.get_request_by_id(&id) {
                                        req.name = new_name.clone();
                                        let _ = db.update_request(&req);

                                        let mut map = requests_map.write();
                                        if let Some(reqs) = map.get_mut(&req.project_id) {
                                            if let Some(r) = reqs.iter_mut().find(|r| r.id == id) {
                                                r.name = new_name.clone();
                                            }
                                        }

                                        let mut t = tabs.write();
                                        if let Some(tab) = t.iter_mut().find(|t| t.request_id == id) {
                                            tab.name = new_name;
                                        }

                                        if let Some(ref mut active) = *active_request.write() {
                                            if active.id == id {
                                                active.name = req.name;
                                            }
                                        }
                                    }
                                    modal.set(ModalType::None);
                                });
                            }
                        },
                        on_cancel: move |_| modal.set(ModalType::None),
                    }
                },
                ModalType::HostnameUniverse => rsx! {
                    HostnameUniverseModal {
                        hostnames: current_hostnames.clone(),
                        on_add: move |_| modal.set(ModalType::AddHostname),
                        on_edit: move |(id, name, url): (String, String, String)| {
                            modal.set(ModalType::EditHostname { id, name, url });
                        },
                        on_delete: move |(id, name): (String, String)| {
                            modal.set(ModalType::DeleteHostname { id, name });
                        },
                        on_close: move |_| modal.set(ModalType::None),
                    }
                },
                ModalType::AddHostname => rsx! {
                    AddEditHostnameModal {
                        title: "Add New Hostname".to_string(),
                        name: String::new(),
                        url: String::new(),
                        on_save: move |(name, url): (String, String)| {
                            let db = db.read().clone();
                            let new_hostname = Hostname::new(name, url);
                            spawn(async move {
                                if db.create_hostname(&new_hostname).is_ok() {
                                    let mut h = hostnames.read().clone();
                                    h.push(new_hostname);
                                    hostnames.set(h);
                                }
                                modal.set(ModalType::HostnameUniverse);
                            });
                        },
                        on_cancel: move |_| modal.set(ModalType::HostnameUniverse),
                    }
                },
                ModalType::EditHostname { ref id, ref name, ref url } => rsx! {
                    AddEditHostnameModal {
                        title: "Edit Hostname".to_string(),
                        name: name.clone(),
                        url: url.clone(),
                        on_save: {
                            let id = id.clone();
                            move |(name, url): (String, String)| {
                                let db = db.read().clone();
                                let id = id.clone();
                                spawn(async move {
                                    let mut h = hostnames.read().clone();
                                    if let Some(hostname) = h.iter_mut().find(|x| x.id == id) {
                                        hostname.name = name;
                                        hostname.url = url;
                                        let _ = db.update_hostname(hostname);
                                    }
                                    hostnames.set(h);
                                    modal.set(ModalType::HostnameUniverse);
                                });
                            }
                        },
                        on_cancel: move |_| modal.set(ModalType::HostnameUniverse),
                    }
                },
                ModalType::DeleteProject { ref id, ref name } => rsx! {
                    DeleteModal {
                        item_type: "project".to_string(),
                        name: name.clone(),
                        on_confirm: {
                            let id = id.clone();
                            move |_| {
                                let db = db.read().clone();
                                let id = id.clone();
                                spawn(async move {
                                    // Get request IDs for this project before deleting
                                    let project_request_ids: Vec<String> = requests_map.read()
                                        .get(&id)
                                        .map(|reqs| reqs.iter().map(|r| r.id.clone()).collect())
                                        .unwrap_or_default();

                                    if db.delete_project(&id).is_ok() {
                                        let p: Vec<Project> = projects.read().iter().filter(|x| x.id != id).cloned().collect();
                                        projects.set(p);
                                        requests_map.write().remove(&id);

                                        // Close tabs and clean up state for all requests in the deleted project
                                        for req_id in &project_request_ids {
                                            responses.write().remove(req_id);
                                            loading_requests.write().remove(req_id);
                                            request_generations.write().remove(req_id);
                                        }

                                        let mut t = tabs.write();
                                        t.retain(|tab| !project_request_ids.contains(&tab.request_id));

                                        if t.is_empty() {
                                            active_request.set(None);
                                        } else {
                                            // Reset to first tab if current is gone
                                            let current_idx = *active_tab_index.read();
                                            if current_idx >= t.len() {
                                                active_tab_index.set(0);
                                                if let Some(tab) = t.first() {
                                                    let db = db.clone();
                                                    let req_id = tab.request_id.clone();
                                                    if let Ok(Some(req)) = db.get_request_by_id(&req_id) {
                                                        active_request.set(Some(req));
                                                    }
                                                }
                                            }
                                        }
                                    }
                                    modal.set(ModalType::None);
                                });
                            }
                        },
                        on_cancel: move |_| modal.set(ModalType::None),
                    }
                },
                ModalType::DeleteRequest { ref id, ref name } => rsx! {
                    DeleteModal {
                        item_type: "request".to_string(),
                        name: name.clone(),
                        on_confirm: {
                            let id = id.clone();
                            move |_| {
                                let db = db.read().clone();
                                let id = id.clone();
                                spawn(async move {
                                    if let Ok(Some(req)) = db.get_request_by_id(&id) {
                                        if db.delete_request(&id).is_ok() {
                                            let mut map = requests_map.write();
                                            if let Some(reqs) = map.get_mut(&req.project_id) {
                                                reqs.retain(|r| r.id != id);
                                            }

                                            // Clean up response and loading state
                                            responses.write().remove(&id);
                                            loading_requests.write().remove(&id);
                                            request_generations.write().remove(&id);

                                            let mut t = tabs.write();
                                            if let Some(idx) = t.iter().position(|t| t.request_id == id) {
                                                t.remove(idx);
                                                if t.is_empty() {
                                                    active_request.set(None);
                                                } else {
                                                    // Switch to another tab
                                                    let new_idx = if idx >= t.len() { t.len() - 1 } else { idx };
                                                    active_tab_index.set(new_idx);
                                                    if let Some(tab) = t.get(new_idx) {
                                                        let db = db.clone();
                                                        let req_id = tab.request_id.clone();
                                                        if let Ok(Some(new_req)) = db.get_request_by_id(&req_id) {
                                                            active_request.set(Some(new_req));
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                    modal.set(ModalType::None);
                                });
                            }
                        },
                        on_cancel: move |_| modal.set(ModalType::None),
                    }
                },
                ModalType::DeleteHostname { ref id, ref name } => rsx! {
                    DeleteModal {
                        item_type: "hostname".to_string(),
                        name: name.clone(),
                        on_confirm: {
                            let id = id.clone();
                            move |_| {
                                let db = db.read().clone();
                                let id = id.clone();
                                spawn(async move {
                                    if db.delete_hostname(&id).is_ok() {
                                        let h: Vec<Hostname> = hostnames.read().iter().filter(|x| x.id != id).cloned().collect();
                                        hostnames.set(h);
                                    }
                                    modal.set(ModalType::HostnameUniverse);
                                });
                            }
                        },
                        on_cancel: move |_| modal.set(ModalType::HostnameUniverse),
                    }
                },
                ModalType::UnsavedChanges { tab_index, ref tab_name } => rsx! {
                    UnsavedChangesModal {
                        tab_name: tab_name.clone(),
                        on_dont_save: {
                            let idx = tab_index;
                            move |_: ()| {
                                // Close tab without saving
                                let mut t = tabs.read().clone();
                                let closed_req_id = t.get(idx).map(|tab| tab.request_id.clone());
                                t.remove(idx);
                                tabs.set(t.clone());

                                if let Some(req_id) = closed_req_id {
                                    responses.write().remove(&req_id);
                                    loading_requests.write().remove(&req_id);
                                    request_generations.write().remove(&req_id);
                                }

                                if t.is_empty() {
                                    active_request.set(None);
                                } else {
                                    let new_idx = if idx >= t.len() { t.len() - 1 } else { idx };
                                    active_tab_index.set(new_idx);
                                    if let Some(tab) = t.get(new_idx) {
                                        let db = db.read().clone();
                                        let req_id = tab.request_id.clone();
                                        spawn(async move {
                                            if let Ok(Some(req)) = db.get_request_by_id(&req_id) {
                                                active_request.set(Some(req));
                                            }
                                        });
                                    }
                                }
                                modal.set(ModalType::None);
                            }
                        },
                        on_cancel: move |_: ()| modal.set(ModalType::None),
                        on_save: {
                            let idx = tab_index;
                            move |_: ()| {
                                // Save then close tab
                                if let Some(req) = active_request.read().clone() {
                                    let db = db.read().clone();
                                    spawn(async move {
                                        let _ = db.update_request(&req);
                                        let _ = db.save_request_params(&req.id, &req.params);
                                        let _ = db.save_request_headers(&req.id, &req.headers);
                                        let _ = db.save_form_data_fields(&req.id, &req.form_data);

                                        // Close the tab after saving
                                        let mut t = tabs.read().clone();
                                        let closed_req_id = t.get(idx).map(|tab| tab.request_id.clone());
                                        t.remove(idx);
                                        tabs.set(t.clone());

                                        if let Some(req_id) = closed_req_id {
                                            responses.write().remove(&req_id);
                                            loading_requests.write().remove(&req_id);
                                            request_generations.write().remove(&req_id);
                                        }

                                        if t.is_empty() {
                                            active_request.set(None);
                                        } else {
                                            let new_idx = if idx >= t.len() { t.len() - 1 } else { idx };
                                            active_tab_index.set(new_idx);
                                            if let Some(tab) = t.get(new_idx) {
                                                let req_id = tab.request_id.clone();
                                                if let Ok(Some(req)) = db.get_request_by_id(&req_id) {
                                                    active_request.set(Some(req));
                                                }
                                            }
                                        }
                                        modal.set(ModalType::None);
                                    });
                                }
                            }
                        },
                    }
                },
                ModalType::ExitUnsavedChanges { tab_index, ref tab_name, ref remaining_indices } => {
                    let remaining = remaining_indices.clone();
                    rsx! {
                        UnsavedChangesModal {
                            tab_name: tab_name.clone(),
                            on_dont_save: {
                                let remaining = remaining.clone();
                                move |_: ()| {
                                    // Don't save, continue to next unsaved tab or exit
                                    if remaining.is_empty() {
                                        modal.set(ModalType::None);
                                        std::process::exit(0);
                                    } else {
                                        let mut next_remaining = remaining.clone();
                                        let next_idx = next_remaining.remove(0);
                                        let next_name = tabs.read().get(next_idx).map(|t| t.name.clone()).unwrap_or_default();
                                        modal.set(ModalType::ExitUnsavedChanges {
                                            tab_index: next_idx,
                                            tab_name: next_name,
                                            remaining_indices: next_remaining,
                                        });
                                    }
                                }
                            },
                            on_cancel: move |_: ()| {
                                // Cancel exit process
                                modal.set(ModalType::None);
                            },
                            on_save: {
                                let idx = tab_index;
                                let remaining = remaining.clone();
                                move |_: ()| {
                                    // Save the current tab's data
                                    let tab_req_id = tabs.read().get(idx).map(|t| t.request_id.clone());
                                    if let Some(req_id) = tab_req_id {
                                        let db = db.read().clone();
                                        let remaining = remaining.clone();

                                        if let Some(req) = active_request.read().clone() {
                                            if req.id == req_id {
                                                spawn(async move {
                                                    let _ = db.update_request(&req);
                                                    let _ = db.save_request_params(&req.id, &req.params);
                                                    let _ = db.save_request_headers(&req.id, &req.headers);
                                                    let _ = db.save_form_data_fields(&req.id, &req.form_data);

                                                    // Mark tab as not dirty
                                                    {
                                                        let mut t = tabs.write();
                                                        if let Some(tab) = t.get_mut(idx) {
                                                            tab.is_dirty = false;
                                                        }
                                                    }

                                                    // Continue to next unsaved tab or exit
                                                    if remaining.is_empty() {
                                                        modal.set(ModalType::None);
                                                        std::process::exit(0);
                                                    } else {
                                                        let mut next_remaining = remaining.clone();
                                                        let next_idx = next_remaining.remove(0);
                                                        let next_name = tabs.read().get(next_idx).map(|t| t.name.clone()).unwrap_or_default();
                                                        modal.set(ModalType::ExitUnsavedChanges {
                                                            tab_index: next_idx,
                                                            tab_name: next_name,
                                                            remaining_indices: next_remaining,
                                                        });
                                                    }
                                                });
                                            }
                                        }
                                    }
                                }
                            },
                        }
                    }
                },
            }
        }
    }
}
