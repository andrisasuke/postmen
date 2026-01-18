use dioxus::prelude::*;
use crate::models::RequestParam;

#[component]
pub fn ParamsTab(
    params: Vec<RequestParam>,
    request_id: String,
    on_update: EventHandler<Vec<RequestParam>>,
) -> Element {
    rsx! {
        div { class: "params-tab",
            div { class: "table-header",
                span { class: "col-key", "Key" }
                span { class: "col-value", "Value" }
                span { class: "col-desc", "Description" }
                span { class: "col-action" }
            }
            for (idx, param) in params.iter().enumerate() {
                div { class: "table-row",
                    input {
                        class: "table-input input-key",
                        placeholder: "key",
                        value: "{param.key}",
                        spellcheck: "false",
                        autocapitalize: "off",
                        oninput: {
                            let params = params.clone();
                            move |e: Event<FormData>| {
                                let mut p = params.clone();
                                if let Some(param) = p.get_mut(idx) {
                                    param.key = e.value();
                                }
                                on_update.call(p);
                            }
                        }
                    }
                    input {
                        class: "table-input input-value",
                        placeholder: "value",
                        value: "{param.value}",
                        spellcheck: "false",
                        autocapitalize: "off",
                        oninput: {
                            let params = params.clone();
                            move |e: Event<FormData>| {
                                let mut p = params.clone();
                                if let Some(param) = p.get_mut(idx) {
                                    param.value = e.value();
                                }
                                on_update.call(p);
                            }
                        }
                    }
                    input {
                        class: "table-input input-desc",
                        placeholder: "description",
                        value: "{param.description}",
                        spellcheck: "false",
                        autocapitalize: "off",
                        oninput: {
                            let params = params.clone();
                            move |e: Event<FormData>| {
                                let mut p = params.clone();
                                if let Some(param) = p.get_mut(idx) {
                                    param.description = e.value();
                                }
                                on_update.call(p);
                            }
                        }
                    }
                    button {
                        class: "delete-row-btn",
                        title: "Delete parameter",
                        onclick: {
                            let params = params.clone();
                            move |_| {
                                let mut p = params.clone();
                                p.remove(idx);
                                on_update.call(p);
                            }
                        },
                        "🗑"
                    }
                }
            }
            button {
                class: "add-row-btn",
                title: "Add parameter",
                onclick: {
                    let params = params.clone();
                    let request_id = request_id.clone();
                    move |_| {
                        let mut p = params.clone();
                        p.push(RequestParam::new(request_id.clone()));
                        on_update.call(p);
                    }
                },
                "+ Add Parameter"
            }
        }
    }
}
