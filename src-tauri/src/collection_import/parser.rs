use crate::{
    db::{environments, validation},
    error::{AppError, AppResult},
    models::{Folder, FormField, KeyValue, RequestDoc},
};
use serde_json::Value;
use std::collections::BTreeSet;

pub const MAX_BYTES: usize = 10 * 1024 * 1024;
pub struct Parsed {
    pub name: String,
    pub folders: Vec<Folder>,
    pub requests: Vec<RequestDoc>,
    pub variables: Vec<KeyValue>,
    pub warnings: BTreeSet<String>,
}
fn invalid() -> AppError {
    AppError::invalid(
        "Invalid Postman collection structure. Export a Collection v2.0 or v2.1 JSON file.",
    )
}
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn string(value: &Value) -> AppResult<&str> {
    value.as_str().ok_or_else(invalid)
}
fn optional_string(value: &Value) -> AppResult<&str> {
    if value.is_null() {
        Ok("")
    } else {
        string(value)
    }
}
fn array(value: &Value) -> AppResult<&[Value]> {
    if value.is_null() {
        Ok(&[])
    } else {
        value.as_array().map(Vec::as_slice).ok_or_else(invalid)
    }
}
fn description(value: &Value) -> AppResult<String> {
    optional_string(if value.is_object() {
        &value["content"]
    } else {
        value
    })
    .map(str::to_owned)
}
fn enabled(value: &Value) -> AppResult<bool> {
    match value.get("disabled") {
        None | Some(Value::Null) => Ok(true),
        Some(Value::Bool(disabled)) => Ok(!disabled),
        _ => Err(invalid()),
    }
}
fn warn(warnings: &mut BTreeSet<String>, message: String) {
    if warnings.len() < 100 {
        warnings.insert(message);
    } else {
        warnings.insert("Additional import warnings omitted (limit: 100). Correct the reported issues and choose the file again.".into());
    }
}
fn located(error: AppError, location: &str) -> AppError {
    AppError::new(error.code, format!("{location}\n{}", error.message))
}
fn note_trim(warnings: &mut BTreeSet<String>) {
    warnings.insert("Leading/trailing whitespace in variable names and placeholders was trimmed automatically. Variable values were not trimmed.".into());
}
fn placeholder(text: &str, warnings: &mut BTreeSet<String>, location: &str) -> String {
    let mut output = String::new();
    let mut rest = text;
    while let Some((start, close)) = [("{{", "}}"), ("<<", ">>")]
        .into_iter()
        .filter_map(|(open, close)| rest.find(open).map(|start| (start, close)))
        .min_by_key(|(start, _)| *start)
    {
        output.push_str(&rest[..start]);
        let tail = &rest[start + 2..];
        let Some(end) = tail.find(close) else {
            warn(warnings, format!("{location}: Unclosed variable placeholder. Add the missing {close} delimiter; the field value is not shown."));
            output.push_str(&rest[start..]);
            return output;
        };
        let original_name = &tail[..end];
        let name = original_name.trim();
        if environments::variable_name(name) {
            if name != original_name {
                note_trim(warnings);
            }
            output.push_str(&format!("<<{name}>>"));
        } else {
            warn(warnings, format!("{location}: Variable {} has a dynamic or unsupported name. The placeholder is kept literally; replace it before sending.", validation::diagnostic_name(name)));
            output.push_str(&rest[start..start + 2 + end + 2]);
        }
        rest = &tail[end + 2..];
    }
    output.push_str(rest);
    output
}
fn row(value: &Value, warnings: &mut BTreeSet<String>, location: &str) -> AppResult<KeyValue> {
    if !value.is_object() {
        return Err(invalid());
    }
    Ok(KeyValue {
        id: id(),
        enabled: enabled(value)?,
        name: placeholder(
            string(&value["key"])?,
            warnings,
            &format!("{location} > Name"),
        ),
        value: placeholder(
            optional_string(&value["value"])?,
            warnings,
            &format!("{location} > Value"),
        ),
        description: description(&value["description"])?,
    })
}
fn joined(value: &Value, delimiter: &str) -> AppResult<String> {
    if let Some(text) = value.as_str() {
        return Ok(text.into());
    }
    array(value)?
        .iter()
        .map(|part| {
            if part.is_object() {
                string(&part["value"])
            } else {
                string(part)
            }
        })
        .collect::<AppResult<Vec<_>>>()
        .map(|parts| parts.join(delimiter))
}
fn decode_query(value: &str) -> AppResult<String> {
    // Reject malformed escapes/UTF-8 instead of lossy replacement in credentials.
    let mut bytes = Vec::with_capacity(value.len());
    let mut input = value.bytes();
    while let Some(byte) = input.next() {
        bytes.push(match byte {
            b'+' => b' ',
            b'%' => {
                let high = input
                    .next()
                    .and_then(|c| (c as char).to_digit(16))
                    .ok_or_else(invalid)?;
                let low = input
                    .next()
                    .and_then(|c| (c as char).to_digit(16))
                    .ok_or_else(invalid)?;
                (high * 16 + low) as u8
            }
            other => other,
        });
    }
    String::from_utf8(bytes).map_err(|_| invalid())
}
fn request_url(
    value: &Value,
    warnings: &mut BTreeSet<String>,
    location: &str,
) -> AppResult<(String, Vec<KeyValue>)> {
    if !value.is_string() && !value.is_object() {
        return Err(invalid());
    }
    let raw = if value.is_string() {
        string(value)?
    } else {
        optional_string(&value["raw"])?
    };
    let (raw_base, fragment) = raw.split_once('#').unwrap_or((raw, ""));
    let (raw_base, raw_query) = raw_base.split_once('?').unwrap_or((raw_base, ""));
    let mut base = raw_base.to_owned();
    // Structured components take precedence. Some exports have an incomplete raw URL.
    if value.is_object() && !value["host"].is_null() {
        let host = joined(&value["host"], ".")?;
        if host.is_empty() {
            return Err(invalid());
        }
        let explicit_protocol = optional_string(&value["protocol"])?;
        let protocol = if explicit_protocol.is_empty() {
            raw_base
                .split_once("://")
                .map(|(scheme, _)| scheme)
                .unwrap_or("")
        } else {
            explicit_protocol
        };
        base = if protocol.is_empty() {
            host
        } else {
            format!("{protocol}://{host}")
        };
        let port = optional_string(&value["port"])?;
        if !port.is_empty() {
            base.push(':');
            base.push_str(port);
        }
        if !value["path"].is_null() {
            base.push('/');
            base.push_str(joined(&value["path"], "/")?.trim_start_matches('/'));
        } else if let Some((_, tail)) = raw_base.split_once("://") {
            if let Some((_, path)) = tail.split_once('/') {
                base.push('/');
                base.push_str(path);
            }
        }
    } else if value.is_object() && !value["path"].is_null() && !base.is_empty() {
        let authority_end = base.find("://").map(|i| i + 3).unwrap_or(0);
        if let Some(index) = base[authority_end..].find('/') {
            base.truncate(authority_end + index);
        }
        base.push('/');
        base.push_str(joined(&value["path"], "/")?.trim_start_matches('/'));
    }
    if base.trim().is_empty() {
        return Err(AppError::invalid("Each imported request must have a URL."));
    }
    if raw_base.split_once("://").is_some_and(|(_, tail)| {
        tail.split('/')
            .next()
            .is_some_and(|authority| authority.contains('@'))
    }) {
        return Err(AppError::invalid("URLs containing embedded credentials are not supported by collection import. Move credentials into headers before exporting."));
    }
    let mut params = vec![];
    if value.is_object() && value.get("query").is_some() {
        for (index, item) in array(&value["query"])?.iter().enumerate() {
            let param = row(
                item,
                warnings,
                &format!("{location} > Params row #{}", index + 1),
            )?;
            if param.name.is_empty() {
                if param.value.is_empty() && param.description.is_empty() {
                    warn(warnings, format!("{location} > Params row #{}: Skipped a completely empty row from the exported query table.", index + 1));
                    continue;
                }
                return Err(AppError::invalid(format!("Params row #{} has no name but contains a value or description. Add a name or remove this row from the export. It was not discarded automatically.", index + 1)));
            }
            params.push(param);
        }
    } else if !raw_query.is_empty() {
        for (index, part) in raw_query
            .split('&')
            .filter(|part| !part.is_empty())
            .enumerate()
        {
            let (name, value) = part.split_once('=').unwrap_or((part, ""));
            params.push(KeyValue {
                id: id(),
                enabled: true,
                name: placeholder(
                    &decode_query(name)?,
                    warnings,
                    &format!("{location} > Params row #{} > Name", index + 1),
                ),
                value: placeholder(
                    &decode_query(value)?,
                    warnings,
                    &format!("{location} > Params row #{} > Value", index + 1),
                ),
                description: String::new(),
            });
        }
    }
    if let Some(index) = params.iter().position(|row| row.name.is_empty()) {
        return Err(AppError::invalid(format!("Params row #{} from the raw URL has no name. Only completely empty rows in the exported query table are skipped; add a name or remove the parameter from the URL.", index + 1)));
    }
    if !params.is_empty() {
        warnings.insert("Query parameters are moved to Params; percent encoding and bare query flags may normalize when sent.".into());
    }
    if !fragment.is_empty() || !value["hash"].is_null() {
        warnings
            .insert("URL fragments are omitted because they are not sent in HTTP requests.".into());
    }
    if !value["variable"].is_null() && !array(&value["variable"])?.is_empty() {
        warnings.insert(
            "URL path variables are not resolved. Replace :name segments manually before sending."
                .into(),
        );
    }
    Ok((
        placeholder(&base, warnings, &format!("{location} > URL")),
        params,
    ))
}
impl Parsed {
    fn location(&self, parent: Option<&str>, kind: &str, name: &str) -> String {
        let mut folders = vec![];
        let mut current = parent;
        while let Some(folder) =
            current.and_then(|id| self.folders.iter().find(|folder| folder.id == id))
        {
            folders.push(format!(
                "Folder {}",
                validation::diagnostic_name(&folder.name)
            ));
            current = folder.parent_id.as_deref();
        }
        folders.reverse();
        let mut parts = vec![format!(
            "Collection {}",
            validation::diagnostic_name(&self.name)
        )];
        parts.extend(folders);
        parts.push(format!("{kind} {}", validation::diagnostic_name(name)));
        parts.join(" > ")
    }
    fn notices(&mut self, node: &Value, root: bool, location: &str) -> AppResult<()> {
        if !node["auth"].is_null() && node["auth"]["type"].as_str() != Some("noauth") {
            self.warnings.insert("Authentication helpers are not imported. Configure Authorization headers or query credentials manually.".into());
        }
        if !array(&node["event"])?.is_empty() {
            self.warnings
                .insert("Pre-request scripts and tests are not imported or executed.".into());
        }
        if !node["description"].is_null() {
            self.warnings.insert("Collection, folder and request descriptions are not stored; table row descriptions are retained.".into());
        }
        if !array(&node["response"])?.is_empty() {
            self.warnings
                .insert("Saved response examples are not imported.".into());
        }
        if !root {
            for (index, variable) in array(&node["variable"])?.iter().enumerate() {
                let name = variable["key"]
                    .as_str()
                    .map(validation::diagnostic_name)
                    .unwrap_or_else(|| "(missing name)".into());
                warn(&mut self.warnings, format!("{location} > Variable #{} {name}: Folder/request-local variables are not imported. Add this variable to an environment manually.", index + 1));
            }
        }
        if ["protocolProfileBehavior", "proxy", "certificate"]
            .iter()
            .any(|key| !node[key].is_null())
        {
            self.warnings.insert("Postman proxy, certificate and protocol settings are not imported; PostMen execution settings apply.".into());
        }
        Ok(())
    }
    fn items(
        &mut self,
        items: &[Value],
        collection: &str,
        parent: Option<&str>,
        depth: usize,
    ) -> AppResult<()> {
        if depth > 32 {
            return Err(AppError::invalid(
                "Collection folders are limited to 32 levels.",
            ));
        }
        for (position, item) in items.iter().enumerate() {
            if self.folders.len() + self.requests.len() >= 2000 {
                return Err(AppError::invalid(
                    "Import supports at most 2000 folders and requests per file.",
                ));
            }
            let name = validation::name(string(&item["name"])?)?;
            let location = self.location(
                parent,
                if item.get("item").is_some() {
                    "Folder"
                } else {
                    "Request"
                },
                &name,
            );
            self.notices(item, false, &location)
                .map_err(|error| located(error, &location))?;
            if let Some(children) = item.get("item") {
                if item.get("request").is_some() {
                    return Err(invalid());
                }
                let children = children.as_array().ok_or_else(invalid)?;
                let folder_id = id();
                self.folders.push(Folder {
                    id: folder_id.clone(),
                    collection_id: collection.into(),
                    parent_id: parent.map(str::to_owned),
                    name,
                    position: position as i64,
                });
                self.items(children, collection, Some(&folder_id), depth + 1)?;
                continue;
            }
            let request = &item["request"];
            self.notices(request, false, &location)
                .map_err(|error| located(error, &location))?;
            let (method, url_value) = if request.is_string() {
                ("GET", request)
            } else {
                (string(&request["method"])?, &request["url"])
            };
            let (url, params) = request_url(url_value, &mut self.warnings, &location)
                .map_err(|error| located(error, &location))?;
            let headers = array(&request["header"])?
                .iter()
                .enumerate()
                .map(|(index, item)| {
                    let location = format!("{location} > Headers row #{}", index + 1);
                    row(item, &mut self.warnings, &location)
                        .map_err(|error| located(error, &location))
                })
                .collect::<AppResult<Vec<_>>>()?;
            let mut doc = RequestDoc {
                id: id(),
                collection_id: collection.into(),
                folder_id: parent.map(str::to_owned),
                name,
                method: method.into(),
                url,
                body_kind: "none".into(),
                body: String::new(),
                params,
                headers,
                form_data: vec![],
                position: position as i64,
                revision: 1,
                created_at: 0,
                updated_at: 0,
            };
            let body = &request["body"];
            if !body.is_null() {
                if !body.is_object() {
                    return Err(invalid());
                }
                match optional_string(&body["mode"])? {
                    "" => {},
                    "raw" => {
                        let body_location = format!("{location} > Body (raw)");
                        let raw = optional_string(&body["raw"]).map_err(|error| located(error, &body_location))?;
                        if raw.len() > 2 * 1024 * 1024 {
                            return Err(located(AppError::new("LIMIT_EXCEEDED", "The saved request body is limited to 2 MiB."), &body_location));
                        }
                        let cleaned = super::raw_body::strip_block_comments(raw);
                        if cleaned.removed_comments != 0 {
                            warn(&mut self.warnings, format!("{body_location}: Removed {} block comment(s) /* ... */ outside strings. Whitespace and line endings were retained; other body content was not reformatted.", cleaned.removed_comments));
                        }
                        if cleaned.unterminated_comment {
                            warn(&mut self.warnings, format!("{body_location}: Unclosed block comment /* ... was kept to avoid discarding the rest of the body. Review it before sending."));
                        }
                        doc.body = cleaned.text;
                        if !doc.body.is_empty() {
                            // The existing JSON editor stores/sends body text verbatim;
                            // its linter is advisory. Do not reject or reformat raw data.
                            if let Err(error) = serde_json::from_str::<Value>(&doc.body) {
                                warn(&mut self.warnings, format!("{body_location}: Not a single valid JSON document (line {}, column {}). Raw body imported without syntax repairs or reformatting, except removed block comments. Review the body and Content-Type before sending; the JSON editor may show lint warnings.", error.line(), error.column()));
                            }
                            doc.body_kind = "json".into();
                        }
                    }
                    "formdata" => {
                        doc.body_kind = "multipart".into();
                        for field in array(&body["formdata"])? {
                            let kind = field["type"].as_str().unwrap_or("text");
                            if !["text", "file"].contains(&kind) { return Err(invalid()); }
                            if kind == "file" { self.warnings.insert("Multipart files must be selected again after import. File paths from the JSON are never read.".into()); }
                            if !field["contentType"].is_null() { self.warnings.insert("Per-field multipart content types are not imported.".into()); }
                            doc.form_data.push(FormField { id: id(), enabled: enabled(field)?, name: string(&field["key"])?.into(), kind: kind.into(),
                                value: if kind == "text" { optional_string(&field["value"])?.into() } else { String::new() },
                                attachment_id: None, description: description(&field["description"])? });
                        }
                    }
                    _ => return Err(located(AppError::invalid("Unsupported body mode. Import currently supports raw bodies and multipart form-data only."), &format!("{location} > Body"))),
                }
                if doc.body.contains("{{")
                    || doc
                        .form_data
                        .iter()
                        .any(|field| field.name.contains("{{") || field.value.contains("{{"))
                {
                    self.warnings.insert("Variables in request bodies and multipart fields are kept literally; interpolation is only supported in URL, Params and Headers.".into());
                }
                if !enabled(body)? {
                    return Err(AppError::invalid("Disabled bodies are not supported. Remove or enable the body before exporting."));
                }
            }
            validation::request(&doc)?;
            self.requests.push(doc);
        }
        Ok(())
    }
}
pub fn parse(bytes: &[u8]) -> AppResult<Parsed> {
    if bytes.len() > MAX_BYTES {
        return Err(AppError::invalid("Collection files are limited to 10 MiB."));
    }
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    let root: Value = serde_json::from_slice(bytes).map_err(|_| {
        AppError::invalid("The file is not valid UTF-8 JSON, or exceeds the JSON nesting limit.")
    })?;
    let schema = string(&root["info"]["schema"])?;
    let schema_url = url::Url::parse(schema).map_err(|_| invalid())?;
    if !["http", "https"].contains(&schema_url.scheme())
        || !matches!(
            schema_url.host_str(),
            Some("schema.getpostman.com" | "schema.postman.com")
        )
        || ![
            "/json/collection/v2.1.0/collection.json",
            "/json/collection/v2.0.0/collection.json",
        ]
        .contains(&schema_url.path())
    {
        return Err(AppError::invalid("Choose a Postman Collection v2.0 or v2.1 export (not an environment or workspace export)."));
    }
    let mut parsed = Parsed {
        name: validation::name(string(&root["info"]["name"])?)?,
        folders: vec![],
        requests: vec![],
        variables: vec![],
        warnings: BTreeSet::new(),
    };
    let location = format!("Collection {}", validation::diagnostic_name(&parsed.name));
    parsed.notices(&root, true, &location)?;
    parsed.notices(&root["info"], true, &location)?;
    let variable_location = format!("{location} > Collection variables (variable)");
    let variables = array(&root["variable"]).map_err(|error| located(error, &variable_location))?;
    if variables.len() > 500 {
        return Err(AppError::invalid(format!(
            "{variable_location}\nAn environment supports at most 500 variables."
        )));
    }
    for (index, variable) in variables.iter().enumerate() {
        let row_location = format!(
            "{variable_location} > Variable #{} (variable[{index}])",
            index + 1
        );
        let mut normalized = variable.clone();
        let original_name =
            string(&variable["key"]).map_err(|error| located(error, &row_location))?;
        let name = original_name.trim();
        if name != original_name {
            note_trim(&mut parsed.warnings);
        }
        normalized["key"] = Value::String(name.to_owned());
        if !variable["value"].is_null() && !variable["value"].is_string() {
            normalized["value"] = Value::String(variable["value"].to_string());
            parsed
                .warnings
                .insert("Non-string collection variables are converted to JSON text.".into());
        }
        let mut mapped = row(&normalized, &mut parsed.warnings, &row_location)
            .map_err(|error| located(error, &row_location))?;
        mapped.name = string(&normalized["key"])?.into();
        parsed.variables.push(mapped);
    }
    if let Some((index, error)) = environments::variable_name_issue(&parsed.variables) {
        return Err(AppError::new(
            error.code,
            format!(
                "{variable_location}\n{}\nJSON location: variable[{index}].key{}",
                error.message,
                super::diagnostics::usage_details(&root, &parsed.variables[index].name)
            ),
        ));
    }
    environments::validate_variables(&parsed.variables)
        .map_err(|error| located(error, &variable_location))?;
    if !parsed.variables.is_empty() {
        parsed.warnings.insert("Collection variables will be saved and selected in an Imported environment. Global selections remain unchanged. Values are stored as plaintext.".into());
    }
    let items = root["item"].as_array().ok_or_else(invalid)?;
    parsed.items(items, &id(), None, 0)?;
    Ok(parsed)
}
