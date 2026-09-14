use super::*;
use crate::models::{CreateCollection, CreateRequest, SaveEnvironment};
use serde_json::{json, Value};

fn collection(name: &str) -> Value {
    json!({"info":{"name":name,"schema":"https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},"item":[
        {"name":"Get Users List","request":{"method":"GET","header":[{"key":"Accept","value":"application/json"}],"url":{"raw":"https://reqres.in","protocol":"https","host":["reqres","in"],"path":["api","users"],"query":[{"key":"page","value":"2"}]}}},
        {"name":"Create New User","request":{"method":"POST","body":{"mode":"raw","raw":"{\"name\":\"John Doe\",\"job\":\"Software Engineer\"}"},"url":"https://reqres.in/api/users"}}
    ]})
}
fn parsed(value: &Value) -> parser::Parsed {
    parser::parse(&serde_json::to_vec(value).unwrap()).unwrap()
}
fn connection() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "foreign_keys", true).unwrap();
    conn.execute_batch(include_str!("../db/schema.sql"))
        .unwrap();
    conn.execute_batch(include_str!("../db/environments.sql"))
        .unwrap();
    conn
}
fn stage(imports: &Imports, value: &Value) -> String {
    imports
        .stage(&serde_json::to_vec(value).unwrap())
        .unwrap()
        .token
}
fn input(token: String, mode: Mode, target_id: Option<String>) -> Commit {
    Commit {
        token,
        mode,
        target_id,
    }
}
fn imported(outcome: Outcome) -> (String, Box<Workspace>) {
    match outcome {
        Outcome::Imported {
            collection_id,
            workspace,
            ..
        } => (collection_id, workspace),
        _ => panic!("Expected import"),
    }
}
#[test]
fn sample_structured_url_query_headers_and_json_body() {
    let value = parsed(&collection("Sample API Collection"));
    assert_eq!(value.name, "Sample API Collection");
    assert_eq!(value.requests.len(), 2);
    assert_eq!(value.requests[0].url, "https://reqres.in/api/users");
    assert_eq!(value.requests[0].params[0].name, "page");
    assert_eq!(value.requests[0].params[0].value, "2");
    assert_eq!(value.requests[0].headers[0].name, "Accept");
    assert_eq!(value.requests[1].body_kind, "json");
    assert!(value.requests[1].body.contains("John Doe"));
}
#[test]
fn raw_query_keeps_duplicates_unicode_and_disabled_structured_rows() {
    let mut value = collection("Query");
    value["item"][0]["request"]["url"] =
        json!("https://example.test/path?tag=a%26b&tag=%E6%97%A5&q=two+words#ignored");
    let result = parsed(&value);
    let doc = &result.requests[0];
    assert_eq!(doc.url, "https://example.test/path");
    assert_eq!(
        doc.params
            .iter()
            .map(|row| row.value.as_str())
            .collect::<Vec<_>>(),
        vec!["a&b", "日", "two words"]
    );
    value["item"][0]["request"]["url"] = json!({"raw":"https://example.test/path?ignored=yes","query":[{"key":"page","value":"2","disabled":true}]});
    let result = parsed(&value);
    assert_eq!(result.requests[0].params.len(), 1);
    assert!(!result.requests[0].params[0].enabled);
}
#[test]
fn nested_order_templates_variables_and_file_placeholders() {
    let mut value = collection("Nested");
    let mut request = value["item"][0].clone();
    request["request"]["url"] = json!("{{baseUrl}}/users?q={{search}}");
    request["request"]["header"] =
        json!([{"key":"Authorization","value":"Bearer {{token}}","disabled":true}]);
    request["request"]["body"] = json!({"mode":"formdata","formdata":[{"key":"name","value":"literal {{name}}","type":"text"},{"key":"file","type":"file","src":"/never/read/credentials.json"}]});
    value["item"] = json!([{"name":"Folder","item":[{"name":"Empty","item":[]},request]}]);
    value["variable"] =
        json!([{"key":"baseUrl","value":"https://example.test"},{"key":"count","value":42}]);
    value["event"] =
        json!([{"listen":"prerequest","script":{"exec":["throw new Error('must not execute')"]}}]);
    let result = parsed(&value);
    assert_eq!(result.folders.len(), 2);
    assert_eq!(
        result.folders[1].parent_id,
        Some(result.folders[0].id.clone())
    );
    assert_eq!(result.requests[0].position, 1);
    assert_eq!(result.requests[0].url, "<<baseUrl>>/users");
    assert_eq!(result.requests[0].params[0].value, "<<search>>");
    assert_eq!(result.requests[0].headers[0].value, "Bearer <<token>>");
    assert!(!result.requests[0].headers[0].enabled);
    assert_eq!(result.requests[0].form_data[0].value, "literal {{name}}");
    assert_eq!(result.requests[0].form_data[1].attachment_id, None);
    assert!(result.requests[0].form_data[1].value.is_empty());
    assert_eq!(result.variables[1].value, "42");
    assert!(result
        .warnings
        .iter()
        .any(|warning| warning.contains("scripts")));
    assert!(result
        .warnings
        .iter()
        .any(|warning| warning.contains("File paths")));
}
#[test]
fn rejects_wrong_export_invalid_json_unsupported_body_and_invalid_params() {
    for bytes in [b"not json".as_slice(), b"{\"values\":[]}".as_slice()] {
        assert!(parser::parse(bytes).is_err());
    }
    for url in [
        "https://example.test/?=empty",
        "https://example.test/?q=%FF",
        "https://example.test/?q=%xy",
        "https://user:secret@example.test/",
    ] {
        let mut value = collection("Invalid URL");
        value["item"][0]["request"]["url"] = json!(url);
        assert!(parser::parse(&serde_json::to_vec(&value).unwrap()).is_err());
    }
    let mut value = collection("Unsupported");
    value["item"][0]["request"]["body"] = json!({"mode":"graphql","graphql":{"query":"{users}"}});
    assert!(parser::parse(&serde_json::to_vec(&value).unwrap()).is_err());
    value = collection("Bad method");
    value["item"][0]["request"]["method"] = json!("TRACE");
    assert!(parser::parse(&serde_json::to_vec(&value).unwrap()).is_err());
    assert!(parser::parse(&vec![b' '; parser::MAX_BYTES + 1]).is_err());
}
#[test]
fn accepts_v20_bom_and_empty_collections() {
    let mut value = collection("Empty");
    value["item"] = json!([]);
    value["info"]["schema"] =
        json!("https://schema.getpostman.com/json/collection/v2.0.0/collection.json");
    let mut bytes = vec![0xef, 0xbb, 0xbf];
    bytes.extend(serde_json::to_vec(&value).unwrap());
    assert!(parser::parse(&bytes).unwrap().requests.is_empty());
}
#[test]
fn preview_does_not_write_conflicts_rechecked_and_copy_increments() {
    let imports = Imports::default();
    let mut conn = connection();
    let token = stage(&imports, &collection("Same"));
    assert!(repo::workspace(&mut conn).unwrap().collections.is_empty());
    repo::create_collection(
        &mut conn,
        CreateCollection {
            name: "Same".into(),
        },
    )
    .unwrap();
    let outcome = imports
        .commit(&mut conn, input(token.clone(), Mode::Create, None))
        .unwrap();
    assert!(matches!(outcome, Outcome::Conflict { conflicts } if conflicts.len() == 1));
    assert!(repo::workspace(&mut conn).unwrap().requests.is_empty());
    let (_, workspace) = imported(
        imports
            .commit(&mut conn, input(token.clone(), Mode::Copy, None))
            .unwrap(),
    );
    assert!(workspace.collections.iter().any(|c| c.name == "Same_1"));
    assert!(imports
        .commit(&mut conn, input(token, Mode::Copy, None))
        .is_err());
    let token = stage(&imports, &collection("Same"));
    let (_, workspace) = imported(
        imports
            .commit(&mut conn, input(token, Mode::Copy, None))
            .unwrap(),
    );
    assert!(workspace.collections.iter().any(|c| c.name == "Same_2"));
}
#[test]
fn overwrite_exact_target_keeps_other_collections_and_globals() {
    let mut conn = connection();
    let imports = Imports::default();
    let first = repo::create_collection(
        &mut conn,
        CreateCollection {
            name: "Same".into(),
        },
    )
    .unwrap();
    let second = repo::create_collection(
        &mut conn,
        CreateCollection {
            name: "Same".into(),
        },
    )
    .unwrap();
    let original = repo::create_request(
        &mut conn,
        CreateRequest {
            collection_id: first.id.clone(),
            folder_id: None,
            name: "Old".into(),
            content: None,
        },
    )
    .unwrap();
    let global = environments::save(
        &mut conn,
        SaveEnvironment {
            id: None,
            collection_id: None,
            name: "Global".into(),
            variables: vec![],
            revision: None,
        },
    )
    .unwrap();
    environments::save(
        &mut conn,
        SaveEnvironment {
            id: None,
            collection_id: Some(first.id.clone()),
            name: "Old Local".into(),
            variables: vec![],
            revision: None,
        },
    )
    .unwrap();
    let mut value = collection("Same");
    value["variable"] = json!([{"key":"baseUrl","value":"https://example.test"}]);
    let token = stage(&imports, &value);
    let outcome = imports
        .commit(&mut conn, input(token.clone(), Mode::Create, None))
        .unwrap();
    assert!(matches!(outcome, Outcome::Conflict { conflicts } if conflicts.len() == 2));
    let (id, workspace) = imported(
        imports
            .commit(
                &mut conn,
                input(token, Mode::Overwrite, Some(first.id.clone())),
            )
            .unwrap(),
    );
    assert_eq!(id, first.id);
    assert_eq!(workspace.collections.len(), 2);
    assert!(workspace.collections.iter().any(|c| c.id == second.id));
    assert!(!workspace.requests.iter().any(|r| r.id == original.id));
    assert_eq!(workspace.requests.len(), 2);
    assert_eq!(workspace.environments.len(), 2);
    assert!(workspace.environments.iter().any(|e| e.id == global.id));
    assert!(workspace
        .environments
        .iter()
        .any(|e| e.name == "Imported" && e.collection_id.as_deref() == Some(&id)));
    assert_eq!(
        workspace.environment_selections[0].collection_id.as_deref(),
        Some(id.as_str())
    );
}
#[test]
fn failed_overwrite_rolls_back_and_preview_can_retry() {
    let mut conn = connection();
    let imports = Imports::default();
    let first = repo::create_collection(
        &mut conn,
        CreateCollection {
            name: "Same".into(),
        },
    )
    .unwrap();
    let old = repo::create_request(
        &mut conn,
        CreateRequest {
            collection_id: first.id.clone(),
            folder_id: None,
            name: "Old".into(),
            content: None,
        },
    )
    .unwrap();
    conn.execute_batch("CREATE TRIGGER fail_import BEFORE INSERT ON requests BEGIN SELECT RAISE(ABORT,'test failure'); END;").unwrap();
    let token = stage(&imports, &collection("Same"));
    assert!(imports
        .commit(
            &mut conn,
            input(token.clone(), Mode::Overwrite, Some(first.id.clone()))
        )
        .is_err());
    assert_eq!(repo::workspace(&mut conn).unwrap().requests[0].id, old.id);
    conn.execute_batch("DROP TRIGGER fail_import").unwrap();
    assert!(imports
        .commit(&mut conn, input(token, Mode::Overwrite, Some(first.id)))
        .is_ok());
}
#[test]
fn discard_expiration_and_wrong_target_never_write() {
    let mut conn = connection();
    let imports = Imports::default();
    let token = stage(&imports, &collection("One"));
    assert!(imports
        .commit(
            &mut conn,
            input(
                token.clone(),
                Mode::Overwrite,
                Some(uuid::Uuid::new_v4().to_string())
            )
        )
        .is_err());
    imports.discard(&token).unwrap();
    assert!(imports
        .commit(&mut conn, input(token, Mode::Create, None))
        .is_err());
    let token = stage(&imports, &collection("One"));
    imports.0.lock().unwrap().as_mut().unwrap().at = Instant::now() - Duration::from_secs(901);
    assert!(imports
        .commit(&mut conn, input(token, Mode::Create, None))
        .is_err());
    assert!(repo::workspace(&mut conn).unwrap().collections.is_empty());
}
#[test]
fn unicode_copy_name_respects_name_limit_and_existing_suffixes() {
    let mut conn = connection();
    let name = "日".repeat(200);
    repo::create_collection(&mut conn, CreateCollection { name: name.clone() }).unwrap();
    let candidate = copy_name(&conn, &name).unwrap();
    assert_eq!(candidate.chars().count(), 200);
    assert!(candidate.ends_with("_1"));
    repo::create_collection(&mut conn, CreateCollection { name: candidate }).unwrap();
    assert!(copy_name(&conn, &name).unwrap().ends_with("_2"));
}

fn import_error(value: &Value) -> String {
    parser::parse(&serde_json::to_vec(value).unwrap())
        .err()
        .unwrap()
        .message
}
#[test]
fn variable_name_error_identifies_declaration_and_nested_request_references() {
    let mut value = collection("My API");
    value["variable"] = json!([{"key":"base url ","value":"PRIVATE_VARIABLE_VALUE"}]);
    value["item"] = json!([{"name":"Accounts","item":[{"name":"Admin","item":[
        {"name":"List users","request":{"method":"GET","url":"{{base url }}/users?secret=PRIVATE_QUERY_VALUE","header":[{"key":"Authorization","value":"PRIVATE_HEADER_VALUE {{base url }}"}]}}
    ]}]}]);
    let error = import_error(&value);
    assert!(error.contains("Collection \"My API\" > Collection variables"));
    assert!(error.contains("Variable #1 \"base url\""));
    assert!(error.contains("spaces are not allowed"));
    assert!(error.contains("variable[0].key"));
    assert!(error.contains("Folder \"Accounts\" > Folder \"Admin\" > Request \"List users\""));
    assert!(error.contains("URL / Params, Headers"));
    assert!(error.contains("item[0].item[0].item[0].request"));
    assert!(!error.contains("PRIVATE_"));
}
#[test]
fn duplicate_variable_error_includes_both_row_numbers_even_when_disabled() {
    let mut value = collection("Duplicates");
    value["variable"] = json!([{"key":"token","value":"FIRST_SECRET"},{"key":"token","value":"SECOND_SECRET","disabled":true}]);
    value["item"][0]["request"]["header"] =
        json!([{"key":"Authorization","value":"Bearer {{token}}"}]);
    let error = import_error(&value);
    assert!(error.contains("Variable #2 \"token\""));
    assert!(error.contains("Duplicate name; first declared at variable #1"));
    assert!(error.contains("Disabled variables also count"));
    assert!(error.contains("variable[1].key"));
    assert!(error.contains("Request \"Get Users List\" — Headers (item[0].request)"));
    assert!(!error.contains("Folder"));
    assert!(!error.contains("SECRET"));
    value["variable"][1]["key"] = json!("Token");
    assert!(parser::parse(&serde_json::to_vec(&value).unwrap()).is_ok());
}
#[test]
fn unused_empty_variable_and_control_characters_have_readable_safe_labels() {
    let mut value = collection("Empty variable");
    value["variable"] = json!([{"key":"","value":"DO_NOT_DISPLAY"}]);
    let error = import_error(&value);
    assert!(error.contains("Variable #1 \"\": The variable name is empty."));
    assert!(error.contains("No matching request references"));
    assert!(error.contains("collection level, not inside a request"));
    assert!(!error.contains("DO_NOT_DISPLAY"));
    value["variable"][0]["key"] = json!("bad\nname");
    let error = import_error(&value);
    assert!(error.contains("\"bad\\nname\""));
    assert!(!error.contains("bad\nname"));
}
#[test]
fn unsupported_placeholder_warnings_identify_folder_request_field_and_variable() {
    let mut value = collection("Warnings");
    value["item"] = json!([{"name":"Users","item":[{"name":"Get users","request":{
        "method":"GET","url":"https://example.test/?q={{bad query}}&secret=NEVER_SHOW_QUERY",
        "header":[{"key":"Authorization","value":"NEVER_SHOW_HEADER {{bad token}}"}]
    }}]}]);
    let result = parsed(&value);
    assert!(result.warnings.iter().any(|warning| warning.contains("Collection \"Warnings\" > Folder \"Users\" > Request \"Get users\" > Headers row #1 > Value: Variable \"bad token\"")));
    assert!(result
        .warnings
        .iter()
        .any(|warning| warning.contains("Params row #1 > Value: Variable \"bad query\"")));
    assert!(result
        .warnings
        .iter()
        .all(|warning| !warning.contains("NEVER_SHOW")));
}
#[test]
fn unclosed_placeholder_does_not_echo_the_field_tail() {
    let mut value = collection("Unclosed");
    value["item"][0]["request"]["header"] =
        json!([{"key":"X-Test","value":"{{incomplete NEVER_SHOW_THIS"}]);
    let result = parsed(&value);
    let warning = result
        .warnings
        .iter()
        .find(|warning| warning.contains("Unclosed variable placeholder"))
        .unwrap();
    assert!(warning.contains("Request \"Get Users List\" > Headers row #1 > Value"));
    assert!(warning.contains("missing }} delimiter"));
    assert!(!warning.contains("NEVER_SHOW_THIS"));
}
#[test]
fn reference_diagnostics_are_bounded_and_skip_descriptions_and_file_paths() {
    let mut value = collection("Many references");
    value["variable"] = json!([{"key":"bad name","value":"NEVER_SHOW"}]);
    value["item"] = json!((0..12).map(|index| json!({"name":format!("Request {index}"),"request":{"method":"GET","url":"{{bad name}}/users"}})).collect::<Vec<_>>());
    let error = import_error(&value);
    assert_eq!(error.matches("\n- Request").count(), 10);
    assert!(error.contains("Reference list limited"));
    value["item"] = json!([{"name":"Not a reference","request":{"method":"GET","url":"https://example.test","description":"{{bad name}}","body":{"mode":"formdata","formdata":[{"key":"file","type":"file","src":"/{{bad name}}/file"}]}}}]);
    assert!(import_error(&value).contains("No matching request references"));
}
#[test]
fn skipped_local_variable_warnings_identify_their_scope_and_name() {
    let mut value = collection("Local variables");
    value["item"] = json!([{"name":"Folder","variable":[{"key":"local_token","value":"NEVER_SHOW"}],"item":[]}]);
    let result = parsed(&value);
    assert!(result
        .warnings
        .iter()
        .any(|warning| warning.contains("Folder \"Folder\" > Variable #1 \"local_token\"")));
    assert!(result
        .warnings
        .iter()
        .all(|warning| !warning.contains("NEVER_SHOW")));
}

#[test]
fn trims_imported_variable_names_and_references_without_trimming_values() {
    let mut value = collection("Shopping Collection");
    value["variable"] = json!([
        {"key":" _.elastic_url ","value":"https://example.test"},
        {"key":"\t token\u{a0}","value":"  KEEP VALUE SPACES  "},
        {"key":"users_url","value":"{{ _.elastic_url }}/users"}
    ]);
    value["item"] = json!([{"name":"Elasticsearch","item":[{"name":"local","item":[{
        "name":"delete-doc-by-term","request":{
            "method":"DELETE",
            "url":{"raw":"{{ _.elastic_url }}","host":["{{ _.elastic_url }}"],"path":["documents"],"query":[{"key":"q","value":"  {{ token }}  "}]},
            "header":[{"key":"X-Token","value":"Bearer << token >>"}],
            "body":{"mode":"raw","raw":"{\"literal\":\"{{ token }}\"}"}
        }
    }]}]}]);
    let result = parsed(&value);
    assert_eq!(result.variables[0].name, "_.elastic_url");
    assert_eq!(result.variables[1].name, "token");
    assert_eq!(result.variables[1].value, "  KEEP VALUE SPACES  ");
    assert_eq!(result.variables[2].value, "<<_.elastic_url>>/users");
    assert_eq!(result.requests[0].url, "<<_.elastic_url>>/documents");
    assert_eq!(result.requests[0].params[0].value, "  <<token>>  ");
    assert_eq!(result.requests[0].headers[0].value, "Bearer <<token>>");
    assert_eq!(result.requests[0].body, "{\"literal\":\"{{ token }}\"}");
    assert!(result
        .warnings
        .iter()
        .any(|warning| warning.contains("trimmed automatically")));
    assert!(result
        .warnings
        .iter()
        .all(|warning| !warning.contains("KEEP VALUE SPACES")));
}
#[test]
fn trimming_collisions_are_rejected_with_both_rows_and_spaced_references() {
    let mut value = collection("Collision");
    value["variable"] = json!([
        {"key":" token ","value":"FIRST_SECRET"},
        {"key":"token","value":"SECOND_SECRET","disabled":true}
    ]);
    value["item"][0]["request"]["header"] = json!([{"key":"X-Token","value":"{{ token }}"}]);
    value["item"][1]["request"]["url"] = json!("<< token >>/users");
    let error = import_error(&value);
    assert!(error.contains("Variable #2 \"token\""));
    assert!(error.contains("Duplicate name; first declared at variable #1"));
    assert!(error.contains("Request \"Get Users List\" — Headers"));
    assert!(error.contains("Request \"Create New User\" — URL"));
    assert!(!error.contains("SECRET"));
}
#[test]
fn trimming_does_not_allow_empty_names_or_remove_internal_spaces() {
    let mut value = collection("Invalid names");
    value["variable"] = json!([{"key":" \t\n ","value":"SECRET"}]);
    assert!(import_error(&value).contains("The variable name is empty"));
    value["variable"][0]["key"] = json!(" base url ");
    assert!(import_error(&value).contains("Variable #1 \"base url\""));
    value["variable"][0]["key"] = json!(" 1token ");
    assert!(import_error(&value).contains("Variable #1 \"1token\""));
}
#[test]
fn normalized_names_and_placeholders_are_persisted_and_resolve_without_network() {
    let imports = Imports::default();
    let mut conn = connection();
    let mut value = collection("Persist normalized");
    value["variable"] = json!([{"key":" _.elastic_url ","value":"https://example.test"}]);
    value["item"][0]["request"]["url"] = json!("{{ _.elastic_url }}/users");
    let token = stage(&imports, &value);
    let (_, workspace) = imported(
        imports
            .commit(&mut conn, input(token, Mode::Create, None))
            .unwrap(),
    );
    assert_eq!(workspace.environments[0].variables[0].name, "_.elastic_url");
    let summary = workspace
        .requests
        .iter()
        .find(|request| request.name == "Get Users List")
        .unwrap();
    let request = repo::get_request(&conn, &summary.id).unwrap();
    assert_eq!(request.url, "<<_.elastic_url>>/users");
    let resolved = environments::resolve_request(&conn, request).unwrap();
    assert_eq!(resolved.url, "https://example.test/users");
}

fn collection_with_raw_body(raw: &str) -> Value {
    json!({"info":{"name":"Raw bodies","schema":"https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},"item":[
        {"name":"Examples","item":[{"name":"Nested","item":[{"name":"Raw request","request":{
            "method":"POST","url":"https://example.test/endpoint",
            "header":[{"key":"Content-Type","value":"application/x-ndjson"}],
            "body":{"mode":"raw","raw":raw,"options":{"raw":{"language":"json"}}}
        }}]}]}
    ]})
}
#[test]
fn imports_ndjson_and_malformed_raw_bodies_without_reformatting_or_repairs() {
    for raw in [
        "{\"index\":{}}\n{\"name\":\"Unicode 日本語\"}\n",
        "{\"one\":1}\r\n{\"two\":2}\r\n",
        "{\"count\":1}extra",
        "{\"one\":1:2}",
        "{\"name\":\"kept\",}",
        "{\"number\":{{variable}}}",
        "plain raw text, not JSON",
        "  \r\n\t ",
    ] {
        let result = parsed(&collection_with_raw_body(raw));
        assert_eq!(result.requests.len(), 1);
        assert_eq!(result.requests[0].body_kind, "json");
        assert_eq!(result.requests[0].body.as_bytes(), raw.as_bytes());
        assert_eq!(result.requests[0].headers[0].value, "application/x-ndjson");
        let warning = result
            .warnings
            .iter()
            .find(|warning| warning.contains("Not a single valid JSON document"))
            .unwrap();
        assert!(warning.contains("Collection \"Raw bodies\" > Folder \"Examples\" > Folder \"Nested\" > Request \"Raw request\" > Body (raw)"));
        assert!(warning.contains("line ") && warning.contains("column "));
        assert!(!warning.contains(raw));
    }
}
#[test]
fn removes_block_comments_but_preserves_strings_escapes_and_other_body_bytes() {
    let raw = r#"{
/* COMMENT_SECRET */
"url":"https://example.test/*literal*/",
"escaped":"quote \" /*still literal*/",
"backslash":"\\", "value":/*REMOVE_ME*/1
}"#;
    let expected = raw
        .replace(
            "/* COMMENT_SECRET */",
            &" ".repeat("/* COMMENT_SECRET */".len()),
        )
        .replace("/*REMOVE_ME*/", &" ".repeat("/*REMOVE_ME*/".len()));
    let result = parsed(&collection_with_raw_body(raw));
    assert_eq!(result.requests[0].body, expected);
    assert!(serde_json::from_str::<Value>(&result.requests[0].body).is_ok());
    assert!(result
        .warnings
        .iter()
        .any(|warning| warning.contains("Removed 2 block comment(s)")));
    assert!(result
        .warnings
        .iter()
        .all(|warning| !warning.contains("COMMENT_SECRET")
            && !warning.contains("REMOVE_ME")
            && !warning.contains("Not a single valid JSON document")));
}
#[test]
fn comments_become_whitespace_without_merging_tokens_or_removing_line_endings() {
    let raw = "{\"n\":1/*日\r\ncomment*/2}\r\n";
    let cleaned = raw_body::strip_block_comments(raw);
    assert_eq!(cleaned.removed_comments, 1);
    assert_eq!(cleaned.text.len(), raw.len());
    assert_eq!(
        cleaned
            .text
            .bytes()
            .filter(|byte| matches!(byte, b'\r' | b'\n'))
            .collect::<Vec<_>>(),
        raw.bytes()
            .filter(|byte| matches!(byte, b'\r' | b'\n'))
            .collect::<Vec<_>>()
    );
    assert!(!cleaned.text.contains("12"));
    assert!(serde_json::from_str::<Value>(&cleaned.text).is_err());
    assert_eq!(
        parsed(&collection_with_raw_body(raw)).requests[0].body,
        cleaned.text
    );
}
#[test]
fn preserves_unclosed_comments_single_quoted_literals_and_line_comments() {
    let raw = "{\"a\":1}/*completed*//*unfinished PRIVATE_TAIL";
    let result = parsed(&collection_with_raw_body(raw));
    assert_eq!(
        result.requests[0].body,
        raw.replace("/*completed*/", &" ".repeat("/*completed*/".len()))
    );
    assert!(result
        .warnings
        .iter()
        .any(|warning| warning.contains("Unclosed block comment")));
    assert!(result
        .warnings
        .iter()
        .all(|warning| !warning.contains("PRIVATE_TAIL")));
    let literals = "'/*literal*/'\n// \" /*line comment stays*/\n{}/*remove*/";
    let cleaned = raw_body::strip_block_comments(literals);
    assert_eq!(
        cleaned.text,
        literals.replace("/*remove*/", &" ".repeat("/*remove*/".len()))
    );
    assert_eq!(cleaned.removed_comments, 1);
}
#[test]
fn raw_body_limit_and_outer_file_validation_still_apply() {
    let oversized = collection_with_raw_body(&"x".repeat(2 * 1024 * 1024 + 1));
    let error = import_error(&oversized);
    assert!(error.contains("Request \"Raw request\" > Body (raw)"));
    assert!(error.contains("limited to 2 MiB"));
    assert!(parser::parse(b"{not a valid collection}").is_err());
    let mut wrong_type = collection_with_raw_body("{}");
    wrong_type["item"][0]["item"][0]["item"][0]["request"]["body"]["raw"] = json!(42);
    assert!(parser::parse(&serde_json::to_vec(&wrong_type).unwrap()).is_err());
}
#[test]
fn commit_persists_raw_bytes_and_comment_cleanup_without_reading_external_files() {
    let mut conn = connection();
    let imports = Imports::default();
    let raw = "{\"one\":1}/*REMOVE_ME*/\n{\"two\":2}\n";
    let expected = raw.replace("/*REMOVE_ME*/", &" ".repeat("/*REMOVE_ME*/".len()));
    let token = stage(&imports, &collection_with_raw_body(raw));
    let (_, workspace) = imported(
        imports
            .commit(&mut conn, input(token, Mode::Create, None))
            .unwrap(),
    );
    let request = repo::get_request(&conn, &workspace.requests[0].id).unwrap();
    assert_eq!(request.body, expected);
    assert_eq!(request.headers[0].value, "application/x-ndjson");
    assert_eq!(request.body_kind, "json");
}

#[test]
fn skips_only_completely_empty_exported_query_rows_and_keeps_other_params() {
    let mut value = collection("Shopping Collection");
    let mut request = value["item"][0].clone();
    request["name"] = json!("Sku summary duplication");
    request["request"]["url"] = json!({"raw":"https://example.test/sku","query":[
        {"key":"page","value":"2"},
        {"key":"include","value":"","disabled":true},
        {"key":"","value":""},
        {"key":"page","value":"3"},
        {"key":"","value":null,"description":{"content":""},"disabled":true}
    ]});
    value["item"] = json!([{"name":"OSS-WMS","item":[{"name":"Sku Master","item":[request]}]}]);
    let result = parsed(&value);
    let request = &result.requests[0];
    assert_eq!(request.params.len(), 3);
    assert_eq!(
        request
            .params
            .iter()
            .map(|row| (row.name.as_str(), row.value.as_str(), row.enabled))
            .collect::<Vec<_>>(),
        vec![
            ("page", "2", true),
            ("include", "", false),
            ("page", "3", true)
        ]
    );
    assert!(result.warnings.iter().any(|warning| warning.contains("Collection \"Shopping Collection\" > Folder \"OSS-WMS\" > Folder \"Sku Master\" > Request \"Sku summary duplication\" > Params row #3: Skipped a completely empty row")));
    assert!(result
        .warnings
        .iter()
        .any(|warning| warning.contains("Params row #5: Skipped a completely empty row")));
}
#[test]
fn does_not_silently_drop_nameless_query_values_or_descriptions() {
    for row in [
        json!({"key":"","value":"PRIVATE_VALUE"}),
        json!({"key":"","value":"PRIVATE_VALUE","disabled":true}),
        json!({"key":"","value":"","description":"PRIVATE_DESCRIPTION"}),
        json!({"key":"","value":" "}),
    ] {
        let mut value = collection("Meaningful unnamed row");
        value["item"][0]["request"]["url"] =
            json!({"raw":"https://example.test/","query":[{"key":"ok","value":"yes"},row]});
        let error = import_error(&value);
        assert!(error.contains("Request \"Get Users List\""));
        assert!(error.contains("Params row #2 has no name but contains a value or description"));
        assert!(!error.contains("PRIVATE_"));
    }
}
#[test]
fn blank_table_can_import_but_raw_url_empty_names_and_malformed_rows_still_fail() {
    let mut value = collection("Blank table");
    value["item"][0]["request"]["url"] =
        json!({"raw":"https://example.test/","query":[{"key":"","value":""}]});
    assert!(parsed(&value).requests[0].params.is_empty());
    value["item"][0]["request"]["url"] = json!("https://example.test/?=");
    assert!(import_error(&value).contains("from the raw URL has no name"));
    value["item"][0]["request"]["url"] =
        json!({"raw":"https://example.test/","query":[{"value":""}]});
    assert!(parser::parse(&serde_json::to_vec(&value).unwrap()).is_err());
}
