use dioxus::prelude::*;
use crate::models::{Request, RequestParam, RequestHeader};
use crate::state::EditorTab;
use crate::services::HttpService;
use super::{ParamsTab, HeadersTab, BodyTab};

#[component]
pub fn RequestEditor(
    request: Request,
    editor_tab: EditorTab,
    is_loading: bool,
    on_update_request: EventHandler<Request>,
    on_tab_change: EventHandler<EditorTab>,
    on_send: EventHandler<()>,
    on_save: EventHandler<()>,
) -> Element {
    let params_count = request.params.len();
    let headers_count = request.headers.len();
    let mut json_error = use_signal(|| None::<String>);
    let mut error_line = use_signal(|| None::<usize>);

    rsx! {
        div { class: "editor-left-panel",
            div { class: "editor-tabs-bar",
                button {
                    class: if editor_tab == EditorTab::Params { "editor-tab active" } else { "editor-tab" },
                    onclick: move |_| on_tab_change.call(EditorTab::Params),
                    "Params"
                    if params_count > 0 {
                        span { class: "tab-count", "({params_count})" }
                    }
                }
                button {
                    class: if editor_tab == EditorTab::Headers { "editor-tab active" } else { "editor-tab" },
                    onclick: move |_| on_tab_change.call(EditorTab::Headers),
                    "Headers"
                    if headers_count > 0 {
                        span { class: "tab-count", "({headers_count})" }
                    }
                }
                button {
                    class: if editor_tab == EditorTab::Body { "editor-tab active" } else { "editor-tab" },
                    onclick: move |_| on_tab_change.call(EditorTab::Body),
                    "Body"
                }

                div { class: "editor-actions",
                    button {
                        class: "send-button",
                        title: "Send request",
                        disabled: is_loading,
                        onclick: {
                            let body = request.body.clone();
                            move |_| {
                                // Validate JSON if body is not empty
                                if !body.trim().is_empty() {
                                    match HttpService::format_json_with_line(&body) {
                                        Ok(_) => {
                                            json_error.set(None);
                                            error_line.set(None);
                                            on_send.call(());
                                        }
                                        Err((err, line)) => {
                                            json_error.set(Some(err));
                                            error_line.set(Some(line));
                                            spawn(async move {
                                                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                                                json_error.set(None);
                                                error_line.set(None);
                                            });
                                        }
                                    }
                                } else {
                                    on_send.call(());
                                }
                            }
                        },
                        if is_loading { "Sending..." } else { "Send" }
                        span { class: "flame-icon" }
                    }
                    button {
                        class: "save-button",
                        title: "Save request",
                        onclick: move |_| on_save.call(()),
                        "Save"
                    }
                }
            }

            div { class: "tab-content",
                match editor_tab {
                    EditorTab::Params => rsx! {
                        ParamsTab {
                            params: request.params.clone(),
                            request_id: request.id.clone(),
                            on_update: {
                                let req = request.clone();
                                move |params: Vec<RequestParam>| {
                                    let mut r = req.clone();
                                    r.params = params;
                                    on_update_request.call(r);
                                }
                            },
                        }
                    },
                    EditorTab::Headers => rsx! {
                        HeadersTab {
                            headers: request.headers.clone(),
                            request_id: request.id.clone(),
                            on_update: {
                                let req = request.clone();
                                move |headers: Vec<RequestHeader>| {
                                    let mut r = req.clone();
                                    r.headers = headers;
                                    on_update_request.call(r);
                                }
                            },
                        }
                    },
                    EditorTab::Body => rsx! {
                        BodyTab {
                            body: request.body.clone(),
                            json_error: json_error.read().clone(),
                            error_line: *error_line.read(),
                            on_update: {
                                let req = request.clone();
                                move |body: String| {
                                    json_error.set(None);
                                    error_line.set(None);
                                    let mut r = req.clone();
                                    r.body = body;
                                    on_update_request.call(r);
                                }
                            },
                            on_error: move |(err, line): (String, usize)| {
                                json_error.set(Some(err));
                                error_line.set(Some(line));
                                spawn(async move {
                                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                                    json_error.set(None);
                                    error_line.set(None);
                                });
                            },
                            on_clear_error: move |_| {
                                json_error.set(None);
                                error_line.set(None);
                            },
                        }
                    },
                }
            }
        }
    }
}
