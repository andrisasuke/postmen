use dioxus::prelude::*;
use crate::models::RequestHeader;

#[component]
pub fn HeadersTab(
    headers: Vec<RequestHeader>,
    request_id: String,
    on_update: EventHandler<Vec<RequestHeader>>,
) -> Element {
    rsx! {
        div { class: "headers-tab",
            div { class: "table-header",
                span { class: "col-key", "Key" }
                span { class: "col-value", "Value" }
                span { class: "col-desc", "Description" }
                span { class: "col-action" }
            }
            for (idx, header) in headers.iter().enumerate() {
                div { class: "table-row",
                    input {
                        class: "table-input input-key",
                        placeholder: "Header name",
                        value: "{header.key}",
                        spellcheck: "false",
                        autocapitalize: "off",
                        oninput: {
                            let headers = headers.clone();
                            move |e: Event<FormData>| {
                                let mut h = headers.clone();
                                if let Some(header) = h.get_mut(idx) {
                                    header.key = e.value();
                                }
                                on_update.call(h);
                            }
                        }
                    }
                    input {
                        class: "table-input input-value",
                        placeholder: "Header value",
                        value: "{header.value}",
                        spellcheck: "false",
                        autocapitalize: "off",
                        oninput: {
                            let headers = headers.clone();
                            move |e: Event<FormData>| {
                                let mut h = headers.clone();
                                if let Some(header) = h.get_mut(idx) {
                                    header.value = e.value();
                                }
                                on_update.call(h);
                            }
                        }
                    }
                    input {
                        class: "table-input input-desc",
                        placeholder: "description",
                        value: "{header.description}",
                        spellcheck: "false",
                        autocapitalize: "off",
                        oninput: {
                            let headers = headers.clone();
                            move |e: Event<FormData>| {
                                let mut h = headers.clone();
                                if let Some(header) = h.get_mut(idx) {
                                    header.description = e.value();
                                }
                                on_update.call(h);
                            }
                        }
                    }
                    button {
                        class: "delete-row-btn",
                        title: "Delete header",
                        onclick: {
                            let headers = headers.clone();
                            move |_| {
                                let mut h = headers.clone();
                                h.remove(idx);
                                on_update.call(h);
                            }
                        },
                        "🗑"
                    }
                }
            }
            button {
                class: "add-row-btn",
                title: "Add header",
                onclick: {
                    let headers = headers.clone();
                    let request_id = request_id.clone();
                    move |_| {
                        let mut h = headers.clone();
                        h.push(RequestHeader::new(request_id.clone()));
                        on_update.call(h);
                    }
                },
                "+ Add Header"
            }
        }
    }
}
