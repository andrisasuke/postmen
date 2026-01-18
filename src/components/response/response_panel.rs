use dioxus::prelude::*;
use crate::models::HttpResponse;
use crate::state::ResponseTab;
use crate::services::HttpService;

#[component]
pub fn ResponsePanel(
    response: Option<HttpResponse>,
    response_tab: ResponseTab,
    is_loading: bool,
    width: i32,
    on_tab_change: EventHandler<ResponseTab>,
    on_clear: EventHandler<()>,
    on_cancel: EventHandler<()>,
) -> Element {
    rsx! {
        div {
            class: "response-panel",
            style: "flex: 0 0 {width}px; width: {width}px;",
            div { class: "response-tabs",
                button {
                    class: if response_tab == ResponseTab::Result { "response-tab active" } else { "response-tab" },
                    onclick: move |_| on_tab_change.call(ResponseTab::Result),
                    "Result"
                }
                button {
                    class: if response_tab == ResponseTab::Headers { "response-tab active" } else { "response-tab" },
                    onclick: move |_| on_tab_change.call(ResponseTab::Headers),
                    "Headers"
                }
                if response.is_some() {
                    button {
                        class: "clear-response-btn",
                        title: "Clear response",
                        onclick: move |_| on_clear.call(()),
                        dangerous_inner_html: r#"<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>"#,
                    }
                }
            }

            if is_loading {
                div { class: "response-loading",
                    div { class: "loading-spinner" }
                    span { "Sending request..." }
                    button {
                        class: "cancel-request-btn",
                        onclick: move |_| on_cancel.call(()),
                        "Cancel"
                    }
                }
            } else if let Some(res) = response {
                div { class: "response-status",
                    span { class: "status-code {res.status_class()}", "{res.status_display()}" }
                    span { class: "response-time", "{res.time_ms}ms" }
                    span { class: "response-size", "{res.size_bytes}bytes" }
                }

                div { class: "response-content",
                    match response_tab {
                        ResponseTab::Result => rsx! {
                            div { class: "response-body",
                                pre { class: "json-content",
                                    code {
                                        {format_json_with_colors(&res.body)}
                                    }
                                }
                            }
                        },
                        ResponseTab::Headers => rsx! {
                            div { class: "response-headers-list",
                                for (key, value) in res.headers.iter() {
                                    div { class: "header-row",
                                        span { class: "header-key", "{key}" }
                                        span { class: "header-value", "{value}" }
                                    }
                                }
                            }
                        },
                    }
                }
            } else {
                div { class: "response-empty",
                    div { class: "empty-dragon-ball small",
                        div { class: "empty-ball-shine" }
                        div { class: "empty-star empty-star-1" }
                        div { class: "empty-star empty-star-2" }
                        div { class: "empty-star empty-star-3" }
                        div { class: "empty-star empty-star-4" }
                    }
                    p { "Send a request to see the response" }
                }
            }
        }
    }
}

fn format_json_with_colors(json_str: &str) -> String {
    if let Ok(formatted) = HttpService::format_json(json_str) {
        formatted
    } else {
        json_str.to_string()
    }
}
