use dioxus::prelude::*;

#[component]
pub fn DeleteModal(
    item_type: String,
    name: String,
    on_confirm: EventHandler<()>,
    on_cancel: EventHandler<()>,
) -> Element {
    rsx! {
        div { class: "modal-overlay",
            onclick: move |_| on_cancel.call(()),
            div {
                class: "modal delete-modal",
                onclick: |e| e.stop_propagation(),
                h2 { class: "modal-title", "Delete {item_type}?" }
                p { class: "delete-message",
                    "Are you sure you want to delete \""
                    strong { "{name}" }
                    "\"? This action cannot be undone."
                }
                div { class: "modal-actions",
                    button {
                        class: "btn-cancel",
                        onclick: move |_| on_cancel.call(()),
                        "Cancel"
                    }
                    button {
                        class: "btn-delete-confirm",
                        onclick: move |_| on_confirm.call(()),
                        "Delete"
                    }
                }
            }
        }
    }
}
