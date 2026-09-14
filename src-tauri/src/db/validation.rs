use crate::{
    error::{AppError, AppResult},
    models::*,
};
use std::collections::HashSet;

pub fn id(value: &str) -> AppResult<()> {
    uuid::Uuid::parse_str(value).map_err(|_| AppError::invalid("Invalid item identifier."))?;
    Ok(())
}
// Quote names for diagnostics so whitespace/control characters are visible, with a
// bounded label. Callers must never pass variable values, URLs or body contents.
pub(crate) fn diagnostic_name(value: &str) -> String {
    let mut chars = value.chars();
    let mut label: String = chars.by_ref().take(200).collect();
    if chars.next().is_some() {
        label.push('…');
    }
    format!("{label:?}")
}
pub fn name(value: &str) -> AppResult<String> {
    let result = value.trim();
    if result.is_empty() || result.chars().count() > 200 || result.chars().any(char::is_control) {
        return Err(AppError::invalid(
            "Use a name between 1 and 200 characters without control characters.",
        ));
    }
    Ok(result.into())
}
pub fn request(doc: &RequestDoc) -> AppResult<()> {
    id(&doc.id)?;
    id(&doc.collection_id)?;
    name(&doc.name)?;
    if let Some(value) = &doc.folder_id {
        id(value)?;
    }
    if !["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].contains(&doc.method.as_str())
    {
        return Err(AppError::invalid("Unsupported HTTP method."));
    }
    if !["none", "json", "multipart"].contains(&doc.body_kind.as_str()) {
        return Err(AppError::invalid("Unsupported body type."));
    }
    if doc.revision < 1 || doc.url.len() > 8192 || doc.url.chars().any(char::is_control) {
        return Err(AppError::invalid(
            "Invalid revision or URL (maximum 8192 bytes, no control characters).",
        ));
    }
    if doc.body.len() > 2 * 1024 * 1024 {
        return Err(AppError::new(
            "LIMIT_EXCEEDED",
            "The saved request body is limited to 2 MiB.",
        ));
    }
    for rows in [&doc.params, &doc.headers] {
        if rows.len() > 500 {
            return Err(AppError::new(
                "LIMIT_EXCEEDED",
                "Each table supports at most 500 rows.",
            ));
        }
        let mut ids = HashSet::new();
        for row in rows {
            id(&row.id)?;
            if !ids.insert(&row.id)
                || row.name.len() > 8192
                || row.value.len() > 65536
                || row.description.len() > 8192
            {
                return Err(AppError::invalid(
                    "Duplicate row ID or oversized table value.",
                ));
            }
        }
    }
    if doc.form_data.len() > 500 {
        return Err(AppError::new(
            "LIMIT_EXCEEDED",
            "Multipart supports at most 500 fields.",
        ));
    }
    let mut ids = HashSet::new();
    for row in &doc.form_data {
        id(&row.id)?;
        if !ids.insert(&row.id)
            || !["text", "file"].contains(&row.kind.as_str())
            || row.name.len() > 8192
            || row.value.len() > 65536
            || row.description.len() > 8192
        {
            return Err(AppError::invalid("Invalid multipart field."));
        }
        if let Some(value) = &row.attachment_id {
            id(value)?;
            if row.kind != "file" {
                return Err(AppError::invalid(
                    "Only file fields can reference an attachment.",
                ));
            }
        }
    }
    if serde_json::to_vec(doc)
        .map_err(|_| AppError::invalid("Invalid request."))?
        .len()
        > 4 * 1024 * 1024
    {
        return Err(AppError::new(
            "LIMIT_EXCEEDED",
            "The saved request is limited to 4 MiB in total.",
        ));
    }
    Ok(())
}
pub fn session(value: &Session) -> AppResult<()> {
    if value.tab_ids.len() > 100 || value.views.len() > 100 {
        return Err(AppError::new(
            "LIMIT_EXCEEDED",
            "At most 100 open tabs can be restored.",
        ));
    }
    for id_value in &value.tab_ids {
        id(id_value)?;
    }
    if let Some(value) = &value.active_id {
        id(value)?;
    }
    for (key, view) in &value.views {
        id(key)?;
        if !["params", "body", "headers"].contains(&view.section.as_str())
            || !["horizontal", "vertical"].contains(&view.pane.orientation.as_str())
            || (view.pane.request_collapsed && view.pane.response_collapsed)
        {
            return Err(AppError::invalid("Invalid tab view state."));
        }
        if !view.pane.request_height.is_finite()
            || !(150.0..=10000.0).contains(&view.pane.request_height)
            || view
                .pane
                .request_width
                .is_some_and(|x| !x.is_finite() || !(350.0..=10000.0).contains(&x))
            || [view.scroll.top, view.scroll.left]
                .iter()
                .any(|x| !x.is_finite() || !(0.0..=1e9).contains(x))
        {
            return Err(AppError::invalid("Invalid pane or scroll size."));
        }
    }
    Ok(())
}
