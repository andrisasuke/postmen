use dioxus::prelude::*;
use crate::models::Request;

#[component]
pub fn RequestItem(
    request: Request,
    is_selected: bool,
    on_select: EventHandler<Request>,
    on_rename: EventHandler<(String, String)>,
    on_delete: EventHandler<(String, String)>,
) -> Element {
    let mut show_menu = use_signal(|| false);

    rsx! {
        if *show_menu.read() {
            div {
                class: "menu-overlay",
                onclick: move |_| show_menu.set(false),
            }
        }
        div {
            class: if is_selected { "request-item selected" } else { "request-item" },
            onclick: {
                let req = request.clone();
                move |_| on_select.call(req.clone())
            },
            span { class: "method-badge {request.method.css_class()}", "{request.method}" }
            span { class: "request-name", "- {request.name}" }
            div { class: "menu-container",
                button {
                    class: "icon-btn menu-btn request-menu",
                    title: "More options",
                    onclick: move |e: Event<MouseData>| {
                        e.stop_propagation();
                        show_menu.set(!show_menu());
                    },
                    "..."
                }
                if *show_menu.read() {
                    div {
                        class: "dropdown-menu",
                        onclick: |e| e.stop_propagation(),
                        button {
                            class: "menu-item",
                            onclick: {
                                let id = request.id.clone();
                                let name = request.name.clone();
                                move |e: Event<MouseData>| {
                                    e.stop_propagation();
                                    show_menu.set(false);
                                    on_rename.call((id.clone(), name.clone()));
                                }
                            },
                            "Rename"
                        }
                        button {
                            class: "menu-item delete",
                            onclick: {
                                let id = request.id.clone();
                                let name = request.name.clone();
                                move |e: Event<MouseData>| {
                                    e.stop_propagation();
                                    show_menu.set(false);
                                    on_delete.call((id.clone(), name.clone()));
                                }
                            },
                            "Delete"
                        }
                    }
                }
            }
        }
    }
}
