use crate::{
    db::{environments, repository},
    error::{AppError, AppResult},
    execution::http,
    models::RequestDoc,
};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Input {
    pub request: RequestDoc,
}

#[derive(Debug, Serialize)]
pub struct Output {
    pub code: String,
}

// Only an in-memory export: no save, execution reservation, HTTP or history.
pub fn generate(conn: &Connection, request: RequestDoc) -> AppResult<Output> {
    let doc = environments::resolve_request(conn, request)?;
    if doc.method == "HEAD" && doc.body_kind != "none" {
        return Err(AppError::invalid(
            "cURL export does not support HEAD with an active body. Choose No Body.",
        ));
    }
    no_nul(&doc.url)?;
    for row in doc
        .params
        .iter()
        .chain(&doc.headers)
        .filter(|r| r.enabled && !r.name.is_empty())
    {
        no_nul(&row.name)?;
        no_nul(&row.value)?;
    }
    let url = http::compose_url(&doc)?;
    let headers = http::headers(&doc)?;
    let mut lines = vec!["curl --globoff".to_owned()];
    if doc.method == "HEAD" {
        lines.push("--head".into());
    }
    lines.push(format!("--request {}", quote(&doc.method)));
    lines.push(format!("--url {}", quote(url.as_str())));
    for (name, value) in &headers {
        // Header values originated as UTF-8 strings; HeaderMap validates HTTP syntax.
        let value = std::str::from_utf8(value.as_bytes()).map_err(|_| {
            AppError::invalid("This header cannot be represented in a POSIX command.")
        })?;
        if !value.is_empty() && value.chars().all(|c| matches!(c, ' ' | '\t')) {
            return Err(AppError::invalid(
                "cURL omits whitespace-only header values. Use an empty value or a non-blank value before exporting.",
            ));
        }
        // `Name:` removes a cURL header; `Name;` sends an actual empty value.
        let argument = if value.is_empty() {
            format!("{name};")
        } else {
            format!("{name}: {value}")
        };
        lines.push(format!("--header {}", quote(&argument)));
    }
    if doc.body_kind == "json" {
        no_nul(&doc.body)?;
        lines.push(format!("--data-raw {}", quote(&doc.body)));
    }
    if doc.body_kind == "multipart" {
        let files: HashMap<_, _> = repository::execution_resources(conn, &doc)?
            .into_iter()
            .collect();
        let fields: Vec<_> = doc
            .form_data
            .iter()
            .filter(|r| r.enabled && !r.name.is_empty())
            .collect();
        if fields.is_empty() {
            return Err(AppError::invalid("cURL export needs at least one enabled multipart field. Choose No Body for an empty form."));
        }
        let mut total = 0u64;
        for field in fields {
            no_nul(&field.name)?;
            // cURL splits the name at the first '=' and offers no name escaping.
            if field.name.contains(['=', '\r', '\n']) {
                return Err(AppError::invalid(
                    "cURL multipart names cannot contain equals signs or newlines.",
                ));
            }
            if field.kind == "text" {
                no_nul(&field.value)?;
                lines.push(format!(
                    "--form-string {}",
                    quote(&format!("{}={}", field.name, field.value))
                ));
            } else {
                let path = field
                    .attachment_id
                    .as_ref()
                    .and_then(|id| files.get(id))
                    .ok_or_else(file_unavailable)?;
                let path_text = path.to_str().ok_or_else(|| {
                    AppError::invalid(
                        "The attachment path is not valid Unicode and cannot be exported.",
                    )
                })?;
                no_nul(path_text)?;
                if path_text == "-" {
                    return Err(AppError::invalid(
                        "The attachment path would make cURL read standard input.",
                    ));
                }
                // Reject nonregular replacements before opening (e.g. a FIFO
                // at a formerly selected path must not block the worker).
                let meta = std::fs::metadata(path).map_err(|_| file_unavailable())?;
                total = total.saturating_add(meta.len());
                if !meta.is_file() || total > http::UPLOAD_LIMIT {
                    return Err(AppError::new(
                        "UPLOAD_LIMIT",
                        "Multipart files must be regular files and total at most 100 MiB.",
                    ));
                }
                std::fs::File::open(path).map_err(|_| file_unavailable())?;
                // Separate cURL's form path grammar from POSIX shell quoting.
                let escaped_path = path_text.replace('\\', "\\\\").replace('"', "\\\"");
                lines.push(format!(
                    "--form {}",
                    quote(&format!("{}=@\"{}\"", field.name, escaped_path))
                ));
            }
        }
    }
    Ok(Output {
        code: lines.join(" \\\n  "),
    })
}

fn file_unavailable() -> AppError {
    AppError::new(
        "FILE_UNAVAILABLE",
        "A selected file was moved, removed, or is unreadable. Choose it again.",
    )
}
fn no_nul(value: &str) -> AppResult<()> {
    if value.contains('\0') {
        return Err(AppError::invalid(
            "NUL characters cannot be represented in a POSIX command.",
        ));
    }
    Ok(())
}
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests;
