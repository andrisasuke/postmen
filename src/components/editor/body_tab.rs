use dioxus::prelude::*;
use crate::models::{BodyType, FormDataField, FormFieldType};
use crate::services::HttpService;

#[component]
pub fn BodyTab(
    body: String,
    body_type: BodyType,
    form_data: Vec<FormDataField>,
    json_error: Option<String>,
    error_line: Option<usize>,
    on_update: EventHandler<String>,
    on_body_type_change: EventHandler<BodyType>,
    on_form_data_change: EventHandler<Vec<FormDataField>>,
    on_error: EventHandler<(String, usize)>,
    on_clear_error: EventHandler<()>,
) -> Element {
    let line_count = body.lines().count().max(1);

    rsx! {
        div { class: "body-tab",
            // Body type selector
            div { class: "body-type-selector",
                button {
                    class: if body_type == BodyType::Json { "body-type-btn active" } else { "body-type-btn" },
                    onclick: move |_| on_body_type_change.call(BodyType::Json),
                    "JSON"
                }
                button {
                    class: if body_type == BodyType::MultipartFormData { "body-type-btn active" } else { "body-type-btn" },
                    onclick: move |_| on_body_type_change.call(BodyType::MultipartFormData),
                    "Multipart Form"
                }
            }

            // Conditional content based on body type
            if body_type == BodyType::Json {
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
            } else {
                // Multipart Form Data UI
                FormDataEditor {
                    form_data: form_data,
                    on_change: on_form_data_change,
                }
            }
        }
    }
}

#[component]
fn FormDataEditor(
    form_data: Vec<FormDataField>,
    on_change: EventHandler<Vec<FormDataField>>,
) -> Element {
    rsx! {
        div { class: "params-tab",
            div { class: "table-header",
                span { class: "col-key", "Key" }
                span { class: "col-type", "Type" }
                span { class: "col-value", "Value" }
                span { class: "col-desc", "Description" }
                span { class: "col-action" }
            }
            for (idx, field) in form_data.iter().enumerate() {
                FormDataRow {
                    key: "{field.id}",
                    field: field.clone(),
                    on_update: {
                        let form_data = form_data.clone();
                        move |updated: FormDataField| {
                            let mut data = form_data.clone();
                            if let Some(f) = data.get_mut(idx) {
                                *f = updated;
                            }
                            on_change.call(data);
                        }
                    },
                    on_delete: {
                        let form_data = form_data.clone();
                        move |_| {
                            let mut data = form_data.clone();
                            data.remove(idx);
                            on_change.call(data);
                        }
                    },
                }
            }
            button {
                class: "add-row-btn",
                title: "Add field",
                onclick: {
                    let form_data = form_data.clone();
                    move |_| {
                        let mut data = form_data.clone();
                        let mut new_field = FormDataField::new(String::new());
                        new_field.sort_order = data.len() as i32;
                        data.push(new_field);
                        on_change.call(data);
                    }
                },
                "+ Add Field"
            }
        }
    }
}

#[component]
fn FormDataRow(
    field: FormDataField,
    on_update: EventHandler<FormDataField>,
    on_delete: EventHandler<()>,
) -> Element {
    let mut show_type_dropdown = use_signal(|| false);

    rsx! {
        div { class: "table-row",
            // Click outside overlay
            if *show_type_dropdown.read() {
                div {
                    class: "dropdown-overlay",
                    onclick: move |_| show_type_dropdown.set(false),
                }
            }

            // Key input
            input {
                class: "table-input input-key",
                placeholder: "key",
                value: "{field.key}",
                spellcheck: "false",
                autocapitalize: "off",
                oninput: {
                    let field = field.clone();
                    move |e: Event<FormData>| {
                        let mut f = field.clone();
                        f.key = e.value();
                        on_update.call(f);
                    }
                }
            }

            // Type dropdown
            div { class: "type-dropdown-container",
                button {
                    class: "type-dropdown-btn",
                    onclick: move |_| show_type_dropdown.set(!show_type_dropdown()),
                    span { class: "type-text",
                        if field.field_type == FormFieldType::File { "File" } else { "Text" }
                    }
                    span { class: "dropdown-arrow", "▼" }
                }
                if *show_type_dropdown.read() {
                    div { class: "type-dropdown-menu",
                        button {
                            class: if field.field_type == FormFieldType::Text { "type-option selected" } else { "type-option" },
                            onclick: {
                                let field = field.clone();
                                move |_| {
                                    let mut f = field.clone();
                                    if f.field_type != FormFieldType::Text {
                                        f.field_type = FormFieldType::Text;
                                        f.value = String::new();
                                    }
                                    on_update.call(f);
                                    show_type_dropdown.set(false);
                                }
                            },
                            if field.field_type == FormFieldType::Text { "✓ " } else { "" }
                            "Text"
                        }
                        button {
                            class: if field.field_type == FormFieldType::File { "type-option selected" } else { "type-option" },
                            onclick: {
                                let field = field.clone();
                                move |_| {
                                    let mut f = field.clone();
                                    if f.field_type != FormFieldType::File {
                                        f.field_type = FormFieldType::File;
                                        f.value = String::new();
                                    }
                                    on_update.call(f);
                                    show_type_dropdown.set(false);
                                }
                            },
                            if field.field_type == FormFieldType::File { "✓ " } else { "" }
                            "File"
                        }
                    }
                }
            }

            // Value input or file picker
            div { class: "value-cell",
                if field.field_type == FormFieldType::File {
                    div { class: "file-picker-wrapper",
                        button {
                            class: "file-picker-btn",
                            onclick: {
                                let field = field.clone();
                                move |_| {
                                    let field = field.clone();
                                    spawn(async move {
                                        if let Some(file_path) = rfd::AsyncFileDialog::new()
                                            .set_title("Select File")
                                            .pick_file()
                                            .await
                                        {
                                            let mut f = field.clone();
                                            f.value = file_path.path().to_string_lossy().to_string();
                                            on_update.call(f);
                                        }
                                    });
                                }
                            },
                            "Choose File"
                        }
                        span { class: "file-name",
                            if field.value.is_empty() {
                                "No file chosen"
                            } else {
                                {
                                    std::path::Path::new(&field.value)
                                        .file_name()
                                        .and_then(|n| n.to_str())
                                        .unwrap_or(&field.value)
                                }
                            }
                        }
                    }
                } else {
                    input {
                        class: "table-input value-input",
                        placeholder: "value",
                        value: "{field.value}",
                        spellcheck: "false",
                        autocapitalize: "off",
                        oninput: {
                            let field = field.clone();
                            move |e: Event<FormData>| {
                                let mut f = field.clone();
                                f.value = e.value();
                                on_update.call(f);
                            }
                        }
                    }
                }
            }

            // Description input
            input {
                class: "table-input input-desc",
                placeholder: "description",
                value: "{field.description}",
                spellcheck: "false",
                autocapitalize: "off",
                oninput: {
                    let field = field.clone();
                    move |e: Event<FormData>| {
                        let mut f = field.clone();
                        f.description = e.value();
                        on_update.call(f);
                    }
                }
            }

            // Delete button
            button {
                class: "delete-row-btn",
                title: "Delete field",
                onclick: move |_| on_delete.call(()),
                "🗑"
            }
        }
    }
}
