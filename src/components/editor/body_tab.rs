use dioxus::prelude::*;
use crate::services::HttpService;

#[component]
pub fn BodyTab(
    body: String,
    json_error: Option<String>,
    error_line: Option<usize>,
    on_update: EventHandler<String>,
    on_error: EventHandler<(String, usize)>,
    on_clear_error: EventHandler<()>,
) -> Element {
    let line_count = body.lines().count().max(1);

    rsx! {
        div { class: "body-tab",
            div { class: "code-editor",
                button {
                    class: "prettier-btn",
                    title: "Format JSON",
                    onclick: {
                        let body = body.clone();
                        move |_| {
                            match HttpService::format_json_with_line(&body) {
                                Ok(formatted) => {
                                    on_clear_error.call(());
                                    on_update.call(formatted);
                                }
                                Err((err, line)) => {
                                    on_error.call((err, line));
                                }
                            }
                        }
                    },
                    svg {
                        width: "12",
                        height: "12",
                        view_box: "0 0 24 24",
                        fill: "none",
                        stroke: "currentColor",
                        stroke_width: "2",
                        stroke_linecap: "round",
                        stroke_linejoin: "round",
                        // Braces icon for JSON formatting
                        path { d: "M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1" }
                        path { d: "M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1" }
                    }
                }
                div { class: "editor-with-lines",
                    div { class: "line-numbers",
                        for i in 1..=line_count {
                            div {
                                class: if error_line == Some(i) { "line-number error-line" } else { "line-number" },
                                "{i}"
                            }
                        }
                    }
                    textarea {
                        class: "body-textarea",
                        placeholder: "{{ \"key\": \"value\" }}",
                        value: "{body}",
                        spellcheck: "false",
                        autocapitalize: "off",
                        oninput: move |e| {
                            on_update.call(e.value());
                        }
                    }
                }
                if let Some(err) = json_error.clone() {
                    div { class: "json-error-toast",
                        span { class: "error-icon", "⚠" }
                        span { class: "error-message", "{err}" }
                        button {
                            class: "error-close",
                            onclick: move |_| {
                                on_clear_error.call(());
                            },
                            "×"
                        }
                    }
                }
            }
        }
    }
}
