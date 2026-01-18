use dioxus::prelude::*;

#[component]
pub fn UnsavedChangesModal(
    tab_name: String,
    on_dont_save: EventHandler<()>,
    on_cancel: EventHandler<()>,
    on_save: EventHandler<()>,
) -> Element {
    rsx! {
        div { class: "modal-overlay",
            // No onclick on overlay - modal can only be dismissed by action buttons
            div {
                class: "modal unsaved-modal",
                h2 { class: "modal-title", "Unsaved Changes" }
                p { class: "unsaved-message",
                    "Do you want to save changes to \""
                    strong { "{tab_name}" }
                    "\"?"
                }
                div { class: "modal-actions unsaved-actions",
                    button {
                        class: "btn-dont-save",
                        onclick: move |_| on_dont_save.call(()),
                        "Don't Save"
                    }
                    div { class: "actions-right",
                        button {
                            class: "btn-cancel",
                            onclick: move |_| on_cancel.call(()),
                            "Cancel"
                        }
                        button {
                            class: "btn-save",
                            onclick: move |_| on_save.call(()),
                            "Save"
                        }
                    }
                }
            }
        }
    }
}
