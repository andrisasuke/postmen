use dioxus::prelude::*;
use crate::models::{Request, Hostname, HttpMethod};

#[component]
pub fn RequestUrlBar(
    request: Request,
    hostnames: Vec<Hostname>,
    on_update_request: EventHandler<Request>,
    on_open_hostnames: EventHandler<()>,
) -> Element {
    let mut show_method_dropdown = use_signal(|| false);
    let mut show_hostname_dropdown = use_signal(|| false);

    let selected_hostname = request.hostname_id.as_ref()
        .and_then(|id| hostnames.iter().find(|h| &h.id == id))
        .map(|h| h.name.clone());

    rsx! {
        div {
            class: "url-bar-container",
            tabindex: "0",
            onkeydown: move |e: Event<KeyboardData>| {
                if e.key() == Key::Escape {
                    show_method_dropdown.set(false);
                    show_hostname_dropdown.set(false);
                }
            },

            if *show_method_dropdown.read() || *show_hostname_dropdown.read() {
                div {
                    class: "dropdown-overlay",
                    onclick: move |_| {
                        show_method_dropdown.set(false);
                        show_hostname_dropdown.set(false);
                    }
                }
            }

            div { class: "url-bar",
                div { class: "method-dropdown-container",
                    button {
                        class: "method-dropdown-btn {request.method.css_class()}",
                        onclick: move |_| {
                            show_hostname_dropdown.set(false);
                            show_method_dropdown.set(!show_method_dropdown());
                        },
                        "{request.method}"
                        span { class: "dropdown-arrow", "▼" }
                    }
                    if *show_method_dropdown.read() {
                        div { class: "method-dropdown-menu",
                            for method in [HttpMethod::GET, HttpMethod::POST, HttpMethod::PUT, HttpMethod::DELETE, HttpMethod::OPTIONS] {
                                button {
                                    class: if request.method == method {
                                        format!("method-option {} selected", method.css_class())
                                    } else {
                                        format!("method-option {}", method.css_class())
                                    },
                                    onclick: {
                                        let req = request.clone();
                                        move |_| {
                                            let mut r = req.clone();
                                            r.method = method;
                                            on_update_request.call(r);
                                            show_method_dropdown.set(false);
                                        }
                                    },
                                    if request.method == method { "✓ " } else { "" }
                                    "{method}"
                                }
                            }
                        }
                    }
                }

                div { class: "hostname-dropdown-container",
                    button {
                        class: "hostname-dropdown-btn",
                        onclick: move |_| {
                            show_method_dropdown.set(false);
                            show_hostname_dropdown.set(!show_hostname_dropdown());
                        },
                        span { class: "hostname-text",
                            if let Some(ref name) = selected_hostname {
                                "{name}"
                            } else {
                                "Select hostname..."
                            }
                        }
                        span { class: "dropdown-arrow", "▼" }
                    }
                    if *show_hostname_dropdown.read() {
                        div { class: "hostname-dropdown-menu",
                            button {
                                class: if request.hostname_id.is_none() { "hostname-option selected" } else { "hostname-option" },
                                onclick: {
                                    let req = request.clone();
                                    move |_| {
                                        let mut r = req.clone();
                                        r.hostname_id = None;
                                        on_update_request.call(r);
                                        show_hostname_dropdown.set(false);
                                    }
                                },
                                if request.hostname_id.is_none() { "✓ " } else { "" }
                                "None"
                            }
                            for h in hostnames.iter() {
                                button {
                                    class: if request.hostname_id.as_ref() == Some(&h.id) { "hostname-option selected" } else { "hostname-option" },
                                    onclick: {
                                        let req = request.clone();
                                        let hostname_id = h.id.clone();
                                        move |_| {
                                            let mut r = req.clone();
                                            r.hostname_id = Some(hostname_id.clone());
                                            on_update_request.call(r);
                                            show_hostname_dropdown.set(false);
                                        }
                                    },
                                    if request.hostname_id.as_ref() == Some(&h.id) { "✓ " } else { "" }
                                    "{h.name}"
                                }
                            }
                        }
                    }
                    button {
                        class: "hostname-settings-btn",
                        title: "Manage hostnames",
                        onclick: move |_| on_open_hostnames.call(()),
                        "⚙"
                    }
                }

                input {
                    class: "path-input",
                    r#type: "text",
                    placeholder: if request.hostname_id.is_none() { "https://api.example.com/endpoint" } else { "/api/endpoint" },
                    value: "{request.path}",
                    spellcheck: "false",
                    autocapitalize: "off",
                    oninput: {
                        let req = request.clone();
                        move |e: Event<FormData>| {
                            let mut r = req.clone();
                            r.path = e.value();
                            on_update_request.call(r);
                        }
                    }
                }
            }
        }
    }
}
