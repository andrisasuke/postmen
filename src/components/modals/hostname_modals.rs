use dioxus::prelude::*;
use crate::models::Hostname;

#[component]
pub fn HostnameUniverseModal(
    hostnames: Vec<Hostname>,
    on_add: EventHandler<()>,
    on_edit: EventHandler<(String, String, String)>,
    on_delete: EventHandler<(String, String)>,
    on_close: EventHandler<()>,
) -> Element {
    rsx! {
        div { class: "modal-overlay",
            onclick: move |_| on_close.call(()),
            div {
                class: "modal hostname-modal",
                onclick: |e| e.stop_propagation(),
                h2 { class: "modal-title", "Hostnames" }
                div { class: "hostname-list",
                    for hostname in hostnames.iter() {
                        div { class: "hostname-item",
                            div { class: "hostname-info",
                                span { class: "hostname-name", "{hostname.name}" }
                                span { class: "hostname-url", "{hostname.url}" }
                            }
                            div { class: "hostname-actions",
                                button {
                                    class: "hostname-edit-btn",
                                    onclick: {
                                        let id = hostname.id.clone();
                                        let name = hostname.name.clone();
                                        let url = hostname.url.clone();
                                        move |_| on_edit.call((id.clone(), name.clone(), url.clone()))
                                    },
                                    "✏"
                                }
                                button {
                                    class: "hostname-delete-btn",
                                    onclick: {
                                        let id = hostname.id.clone();
                                        let name = hostname.name.clone();
                                        move |_| on_delete.call((id.clone(), name.clone()))
                                    },
                                    "🗑"
                                }
                            }
                        }
                    }
                }
                button {
                    class: "btn-add-hostname",
                    onclick: move |_| on_add.call(()),
                    "Add New Hostname"
                }
            }
        }
    }
}

#[component]
pub fn AddEditHostnameModal(
    title: String,
    name: String,
    url: String,
    on_save: EventHandler<(String, String)>,
    on_cancel: EventHandler<()>,
) -> Element {
    let mut hostname_name = use_signal(|| name.clone());
    let mut hostname_url = use_signal(|| url.clone());

    rsx! {
        div { class: "modal-overlay",
            onclick: move |_| on_cancel.call(()),
            div {
                class: "modal add-hostname-modal",
                onclick: |e| e.stop_propagation(),
                h2 { class: "modal-title", "{title}" }
                div { class: "form-group",
                    label { "Name" }
                    input {
                        class: "modal-input",
                        r#type: "text",
                        placeholder: "e.g. Development",
                        value: "{hostname_name}",
                        spellcheck: "false",
                        autocapitalize: "off",
                        oninput: move |e| hostname_name.set(e.value())
                    }
                }
                div { class: "form-group",
                    label { "URL" }
                    input {
                        class: "modal-input",
                        r#type: "text",
                        placeholder: "e.g. https://api.example.com",
                        value: "{hostname_url}",
                        spellcheck: "false",
                        autocapitalize: "off",
                        oninput: move |e| hostname_url.set(e.value())
                    }
                }
                div { class: "modal-actions",
                    button {
                        class: "btn-cancel",
                        onclick: move |_| on_cancel.call(()),
                        "Cancel"
                    }
                    button {
                        class: "btn-save",
                        onclick: move |_| on_save.call((hostname_name(), hostname_url())),
                        "Save"
                        span { class: "flame-icon small" }
                    }
                }
            }
        }
    }
}
