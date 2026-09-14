use crate::db::validation::diagnostic_name;
use serde_json::Value;

// Search only template-bearing request fields. Do not include values, URLs,
// scripts, file paths or descriptions in any returned diagnostic.
fn references(value: &Value, name: &str) -> bool {
    match value {
        Value::String(text) => [("{{", "}}"), ("<<", ">>")].iter().any(|(open, close)| {
            let mut rest = text.as_str();
            while let Some(start) = rest.find(open) {
                let tail = &rest[start + open.len()..];
                let Some(end) = tail.find(close) else {
                    break;
                };
                if tail[..end].trim() == name {
                    return true;
                }
                rest = &tail[end + close.len()..];
            }
            false
        }),
        Value::Array(items) => items.iter().any(|item| references(item, name)),
        Value::Object(fields) => fields.iter().any(|(key, value)| {
            !["description", "src"].contains(&key.as_str()) && references(value, name)
        }),
        _ => false,
    }
}
pub(super) fn usage_details(root: &Value, name: &str) -> String {
    struct Search {
        name: String,
        locations: Vec<String>,
        visited: usize,
        limited: bool,
    }
    impl Search {
        fn items(&mut self, items: &Value, parents: &[String], path: &str, depth: usize) {
            let Some(items) = items.as_array() else {
                return;
            };
            for (index, item) in items.iter().enumerate() {
                if depth > 32 || self.visited >= 2000 || self.locations.len() >= 10 {
                    self.limited = true;
                    return;
                }
                self.visited += 1;
                let name = item["name"]
                    .as_str()
                    .map(diagnostic_name)
                    .unwrap_or_else(|| "(unnamed)".into());
                let path = format!("{path}[{index}]");
                if item.get("item").is_some() {
                    let mut parents = parents.to_vec();
                    parents.push(format!("Folder {name}"));
                    self.items(&item["item"], &parents, &format!("{path}.item"), depth + 1);
                    continue;
                }
                let request = &item["request"];
                let mut fields = Vec::new();
                if request.is_string() && references(request, &self.name) {
                    fields.push("URL");
                }
                for (key, label) in [
                    ("url", "URL / Params"),
                    ("header", "Headers"),
                    ("body", "Body"),
                    ("auth", "Auth"),
                ] {
                    if references(&request[key], &self.name) {
                        fields.push(label);
                    }
                }
                if !fields.is_empty() {
                    let mut location = parents.to_vec();
                    location.push(format!("Request {name}"));
                    self.locations.push(format!(
                        "- {} — {} ({path}.request)",
                        location.join(" > "),
                        fields.join(", ")
                    ));
                }
            }
        }
    }
    let mut search = Search {
        name: name.trim().to_owned(),
        locations: vec![],
        visited: 0,
        limited: false,
    };
    search.items(&root["item"], &[], "item", 0);
    let mut result = if search.locations.is_empty() {
        "\nNo matching request references found in URL, Params, Headers, Body or Auth. This variable is declared at collection level, not inside a request.".to_owned()
    } else {
        format!(
            "\nReferenced by (within this collection):\n{}",
            search.locations.join("\n")
        )
    };
    if search.limited {
        result.push_str("\nReference list limited to 10 matches / 2000 items / 32 folder levels; additional references may exist.");
    }
    result
}
