use dioxus::prelude::*;
use crate::models::{Project, Request};
use super::RequestItem;

#[component]
pub fn ProjectItem(
    project: Project,
    requests: Vec<Request>,
    search_query: String,
    selected_request_id: Option<String>,
    on_toggle: EventHandler<String>,
    on_add_request: EventHandler<String>,
    on_select_request: EventHandler<Request>,
    on_rename_project: EventHandler<(String, String)>,
    on_delete_project: EventHandler<(String, String)>,
    on_rename_request: EventHandler<(String, String)>,
    on_delete_request: EventHandler<(String, String)>,
) -> Element {
    let mut show_project_menu = use_signal(|| false);

    // Filter requests by search
    let filtered_requests: Vec<Request> = if search_query.is_empty() {
        requests.clone()
    } else {
        requests.iter()
            .filter(|r| r.name.to_lowercase().contains(&search_query.to_lowercase()))
            .cloned()
            .collect()
    };

    // Skip project if no matching requests and search is active
    if !search_query.is_empty() && filtered_requests.is_empty() {
        return rsx! {};
    }

    rsx! {
        if *show_project_menu.read() {
            div {
                class: "menu-overlay",
                onclick: move |_| show_project_menu.set(false),
            }
        }
        div { class: "project-item",
            div {
                class: "project-header",
                onclick: {
                    let id = project.id.clone();
                    move |_| on_toggle.call(id.clone())
                },
                span { class: "project-toggle", if project.is_expanded { "−" } else { "+" } }
                span { class: "project-name", "{project.name}" }
                div { class: "project-actions",
                    button {
                        class: "icon-btn",
                        title: "Add request",
                        onclick: {
                            let id = project.id.clone();
                            move |e: Event<MouseData>| {
                                e.stop_propagation();
                                on_add_request.call(id.clone());
                            }
                        },
                        "+"
                    }
                    div { class: "menu-container",
                        button {
                            class: "icon-btn menu-btn",
                            title: "More options",
                            onclick: move |e: Event<MouseData>| {
                                e.stop_propagation();
                                show_project_menu.set(!show_project_menu());
                            },
                            "..."
                        }
                        if *show_project_menu.read() {
                            div {
                                class: "dropdown-menu",
                                onclick: |e| e.stop_propagation(),
                                button {
                                    class: "menu-item",
                                    onclick: {
                                        let id = project.id.clone();
                                        let name = project.name.clone();
                                        move |e: Event<MouseData>| {
                                            e.stop_propagation();
                                            show_project_menu.set(false);
                                            on_rename_project.call((id.clone(), name.clone()));
                                        }
                                    },
                                    "Rename"
                                }
                                button {
                                    class: "menu-item delete",
                                    onclick: {
                                        let id = project.id.clone();
                                        let name = project.name.clone();
                                        move |e: Event<MouseData>| {
                                            e.stop_propagation();
                                            show_project_menu.set(false);
                                            on_delete_project.call((id.clone(), name.clone()));
                                        }
                                    },
                                    "Delete"
                                }
                            }
                        }
                    }
                }
            }

            if project.is_expanded {
                div { class: "project-requests",
                    for req in filtered_requests.iter() {
                        RequestItem {
                            request: req.clone(),
                            is_selected: selected_request_id.as_ref() == Some(&req.id),
                            on_select: on_select_request.clone(),
                            on_rename: on_rename_request.clone(),
                            on_delete: on_delete_request.clone(),
                        }
                    }
                }
            }
        }
    }
}
