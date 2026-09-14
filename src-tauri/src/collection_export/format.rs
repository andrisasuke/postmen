use crate::{
    db::{environments, repository as repo, validation},
    error::{AppError, AppResult},
    models::{Folder, KeyValue, RequestDoc},
};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashSet};

pub const MAX_FILE_BYTES: usize = 10 * 1024 * 1024;
const SCHEMA: &str = "https://schema.getpostman.com/json/collection/v2.1.0/collection.json";

fn placeholders(text: &str) -> String {
    let mut result = String::new();
    let mut rest = text;
    while let Some(start) = rest.find("<<") {
        result.push_str(&rest[..start]);
        rest = &rest[start + 2..];
        if let Some(end) = rest.find(">>") {
            if environments::variable_name(&rest[..end]) {
                result.push_str(&format!("{{{{{}}}}}", &rest[..end]));
                rest = &rest[end + 2..];
                continue;
            }
        }
        result.push_str("<<");
    }
    result.push_str(rest);
    result
}

fn row(value: &KeyValue) -> Value {
    json!({"key":placeholders(&value.name), "value":placeholders(&value.value),
        "description":value.description, "disabled":!value.enabled})
}

fn decode_query(text: &str) -> AppResult<String> {
    let mut bytes = Vec::new();
    let mut input = text.bytes();
    while let Some(byte) = input.next() {
        bytes.push(match byte {
            b'+' => b' ',
            b'%' => {
                let high = input.next().and_then(|c| (c as char).to_digit(16));
                let low = input.next().and_then(|c| (c as char).to_digit(16));
                let (Some(high), Some(low)) = (high, low) else {
                    return Err(AppError::invalid("A URL query contains an incomplete percent escape. Fix the saved URL before exporting."));
                };
                (high * 16 + low) as u8
            }
            value => value,
        });
    }
    String::from_utf8(bytes).map_err(|_| {
        AppError::invalid("A URL query is not valid UTF-8. Fix the saved URL before exporting.")
    })
}

fn request(doc: &RequestDoc, warnings: &mut BTreeSet<String>) -> AppResult<Value> {
    validation::request(doc)?;
    let address = placeholders(&doc.url);
    let (before_hash, fragment) = address.split_once('#').unwrap_or((&address, ""));
    let (base, inline) = before_hash.split_once('?').unwrap_or((before_hash, ""));
    let mut query = Vec::new();
    for part in inline.split('&').filter(|part| !part.is_empty()) {
        let (key, value) = part.split_once('=').unwrap_or((part, ""));
        let key = decode_query(key)?;
        if key.is_empty() {
            return Err(AppError::invalid(
                "A saved URL query has an empty parameter name. Fix it before exporting.",
            ));
        }
        query.push(json!({"key":key, "value":decode_query(value)?, "disabled":false}));
    }
    query.extend(doc.params.iter().filter(|r| !r.name.is_empty()).map(row));
    if !query.is_empty() {
        warnings.insert("Query parameters retain their values/order, but URL encoding and bare flags may normalize. Review signed URLs before sending.".into());
    }
    if doc
        .params
        .iter()
        .chain(&doc.headers)
        .any(|r| r.name.is_empty())
    {
        warnings.insert("Unnamed Params/Header rows are omitted, matching Send behavior.".into());
    }
    let mut encoded = url::form_urlencoded::Serializer::new(String::new());
    for item in &query {
        if item["disabled"] != true {
            encoded.append_pair(
                item["key"].as_str().unwrap_or(""),
                item["value"].as_str().unwrap_or(""),
            );
        }
    }
    let encoded = encoded
        .finish()
        .replace("%7B%7B", "{{")
        .replace("%7D%7D", "}}");
    let raw = format!(
        "{base}{}{}{}{}",
        if encoded.is_empty() { "" } else { "?" },
        encoded,
        if address.contains('#') { "#" } else { "" },
        fragment
    );
    // Postman's SDK consumes structured fields, not only url.raw.
    let (protocol, authority_path) = base
        .split_once("://")
        .map_or((None, base), |(scheme, tail)| (Some(scheme), tail));
    let (authority, path) = authority_path
        .split_once('/')
        .map_or((authority_path, None), |(host, path)| (host, Some(path)));
    if authority.contains('@') {
        return Err(AppError::invalid(
            "Move embedded URL credentials into headers before exporting.",
        ));
    }
    let port_split = if authority.starts_with('[') {
        authority.find(']').and_then(|end| {
            authority
                .get(end + 1..)
                .and_then(|tail| tail.strip_prefix(':'))
                .map(|port| (&authority[..=end], port))
        })
    } else {
        authority.rsplit_once(':')
    };
    let (host, port) = port_split.map_or((authority, None), |(host, port)| (host, Some(port)));
    let mut url = json!({"raw":raw,"host":[host],"query":query});
    if let Some(protocol) = protocol {
        url["protocol"] = json!(protocol);
    }
    if let Some(port) = port {
        url["port"] = json!(port);
    }
    if let Some(path) = path {
        url["path"] = json!(path.split('/').collect::<Vec<_>>());
    }
    if address.contains('#') {
        url["hash"] = json!(fragment);
    }
    let mut result = json!({
        "method":doc.method,
        "header":doc.headers.iter().filter(|r| !r.name.is_empty()).map(row).collect::<Vec<_>>(),
        "url":url,
    });
    match doc.body_kind.as_str() {
        "json" => {
            result["body"] =
                json!({"mode":"raw", "raw":doc.body, "options":{"raw":{"language":"json"}}});
            if !doc
                .headers
                .iter()
                .any(|h| h.enabled && h.name.eq_ignore_ascii_case("content-type"))
            {
                result["header"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"key":"Content-Type","value":"application/json"}));
            }
        }
        "multipart" => {
            let form = doc.form_data.iter().filter(|field| !field.name.is_empty()).map(|field| {
                if field.kind == "file" {
                    warnings.insert("Multipart file contents and local paths are not exported. Select those files again in Postman.".into());
                    json!({"key":field.name,"type":"file","src":[],"disabled":!field.enabled,"description":field.description})
                } else {
                    json!({"key":field.name,"type":"text","value":field.value,"disabled":!field.enabled,"description":field.description})
                }
            }).collect::<Vec<_>>();
            result["body"] = json!({"mode":"formdata","formdata":form});
        }
        _ => {}
    }
    if doc.url.trim().is_empty() {
        warnings.insert("Some saved requests have an empty URL. Set their URL before sending or reimporting them.".into());
    }
    Ok(json!({"name":doc.name,"request":result,"response":[]}))
}

pub struct Document {
    pub id: String,
    pub name: String,
    pub bytes: Vec<u8>,
    pub warnings: Vec<String>,
    pub request_count: usize,
}

pub fn collection(conn: &Connection, id: &str, include_variables: bool) -> AppResult<Document> {
    validation::id(id)?;
    let name: String = conn.query_row("SELECT name FROM collections WHERE id=?1", [id], |r| {
        r.get(0)
    })?;
    let mut stmt = conn.prepare("SELECT id,collection_id,parent_id,name,position FROM folders WHERE collection_id=?1 ORDER BY position,id LIMIT 2001")?;
    let folders = stmt
        .query_map([id], |r| {
            Ok(Folder {
                id: r.get(0)?,
                collection_id: r.get(1)?,
                parent_id: r.get(2)?,
                name: r.get(3)?,
                position: r.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut stmt = conn.prepare(
        "SELECT id FROM requests WHERE collection_id=?1 ORDER BY position,id LIMIT 2001",
    )?;
    let request_ids = stmt
        .query_map([id], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    if folders.len() + request_ids.len() > 2000 {
        return Err(AppError::invalid(
            "Export supports at most 2000 folders/requests per collection.",
        ));
    }
    let mut warnings = BTreeSet::new();
    let mut content_bytes = 0;
    let mut items: BTreeMap<Option<String>, Vec<(i64, String, Value)>> = BTreeMap::new();
    for request_id in &request_ids {
        let doc = repo::get_request(conn, request_id)?;
        let exported = request(&doc, &mut warnings).map_err(|error| {
            AppError::new(
                error.code,
                format!(
                    "Request {}: {}",
                    validation::diagnostic_name(&doc.name),
                    error.message
                ),
            )
        })?;
        content_bytes += exported.to_string().len();
        if content_bytes > MAX_FILE_BYTES {
            return Err(AppError::invalid(
                "The exported collection exceeds 10 MiB. Export a smaller collection.",
            ));
        }
        items
            .entry(doc.folder_id.clone())
            .or_default()
            .push((doc.position, doc.id, exported));
    }
    for folder in &folders {
        items.entry(folder.parent_id.clone()).or_default().push((
            folder.position,
            folder.id.clone(),
            json!({"name":folder.name,"item":[]}),
        ));
    }
    for children in items.values_mut() {
        children.sort_by(|a, b| (a.0, &a.1).cmp(&(b.0, &b.1)));
    }
    fn tree(
        parent: Option<String>,
        items: &mut BTreeMap<Option<String>, Vec<(i64, String, Value)>>,
        depth: usize,
        visited: &mut HashSet<String>,
    ) -> AppResult<Vec<Value>> {
        if depth > 32 {
            return Err(AppError::invalid(
                "Export supports at most 32 nested folder levels.",
            ));
        }
        let mut result = Vec::new();
        for (_, id, mut item) in items.remove(&parent).unwrap_or_default() {
            if !visited.insert(id.clone()) {
                return Err(AppError::invalid("Collection contains a folder cycle."));
            }
            if item.get("item").is_some() {
                item["item"] = json!(tree(Some(id), items, depth + 1, visited)?);
            }
            result.push(item);
        }
        Ok(result)
    }
    let children = tree(None, &mut items, 0, &mut HashSet::new())?;
    if !items.is_empty() {
        return Err(AppError::invalid("Collection contains orphaned or cyclic folders. Repair its structure before exporting."));
    }
    let mut variables = BTreeMap::new();
    if include_variables {
        for scope in [None, Some(id)] {
            for variable in environments::active_variables(conn, scope)?
                .into_iter()
                .filter(|v| v.enabled)
            {
                variables.insert(variable.name.clone(), json!({"key":variable.name,"value":placeholders(&variable.value),"type":"string","description":variable.description}));
            }
        }
        if variables.len() > 500 {
            return Err(AppError::invalid("The combined selected environments exceed 500 variables. Export without environment variables or reduce the selection."));
        }
        warnings.insert("Only enabled variables from the selected Global and Collection environments are included as collection variables. Collection values override Global; other environments are not exported.".into());
    }
    let document = json!({"info":{"_postman_id":id,"name":name,"schema":SCHEMA}, "item":children,"variable":variables.into_values().collect::<Vec<_>>()});
    let mut bytes = serde_json::to_vec_pretty(&document)
        .map_err(|_| AppError::invalid("Collection could not be serialized."))?;
    bytes.push(b'\n');
    if bytes.len() > MAX_FILE_BYTES {
        return Err(AppError::invalid(
            "The exported collection exceeds 10 MiB. Export a smaller collection.",
        ));
    }
    Ok(Document {
        id: id.into(),
        name,
        bytes,
        warnings: warnings.into_iter().collect(),
        request_count: request_ids.len(),
    })
}
