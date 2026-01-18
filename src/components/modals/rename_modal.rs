use dioxus::prelude::*;

#[component]
pub fn RenameModal(
    title: String,
    current_name: String,
    on_save: EventHandler<String>,
    on_cancel: EventHandler<()>,
) -> Element {
    let mut name = use_signal(|| current_name.clone());

    rsx! {
        div { class: "modal-overlay",
            onclick: move |_| on_cancel.call(()),
            div {
                class: "modal rename-modal",
                onclick: |e| e.stop_propagation(),
                h2 { class: "modal-title", "{title}" }
                input {
                    class: "modal-input",
                    r#type: "text",
                    value: "{name}",
                    spellcheck: "false",
                    autocapitalize: "off",
                    oninput: move |e: Event<FormData>| name.set(e.value()),
                    onkeydown: {
                        let name = name.clone();
                        move |e: Event<KeyboardData>| {
                            if e.key() == Key::Enter {
                                on_save.call(name());
                            }
                        }
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
                        onclick: move |_| on_save.call(name()),
                        "Save Name"
                        span { class: "flame-icon small" }
                    }
                }
            }
        }
    }
}
