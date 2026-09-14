use super::validation;
use crate::{
    error::{AppError, AppResult},
    models::*,
};
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::{BTreeMap, HashSet};

fn scope(conn: &Connection, collection: Option<&str>) -> AppResult<()> {
    if let Some(id) = collection {
        validation::id(id)?;
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM collections WHERE id=?1)",
            [id],
            |r| r.get(0),
        )?;
        if !exists {
            return Err(AppError::missing());
        }
    }
    Ok(())
}
pub fn variable_name(name: &str) -> bool {
    let mut chars = name.chars();
    name.len() <= 200
        && chars
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
}
pub(crate) fn variable_name_issue(variables: &[KeyValue]) -> Option<(usize, AppError)> {
    let mut names = BTreeMap::new();
    for (index, variable) in variables.iter().enumerate() {
        let label = format!(
            "Variable #{} {}",
            index + 1,
            validation::diagnostic_name(&variable.name)
        );
        let reason = if variable.name.is_empty() {
            Some("The variable name is empty.".to_owned())
        } else if variable.name.len() > 200 {
            Some("The variable name exceeds the 200-byte limit.".to_owned())
        } else if !variable_name(&variable.name) {
            Some("Start with A–Z, a–z or _. Use only ASCII letters, numbers, _, . or -; spaces are not allowed.".to_owned())
        } else {
            names.insert(&variable.name, index).map(|first| format!("Duplicate name; first declared at variable #{}. Disabled variables also count.", first + 1))
        };
        if let Some(reason) = reason {
            return Some((index, AppError::invalid(format!("{label}: {reason}"))));
        }
    }
    None
}
pub(crate) fn validate_variables(variables: &[KeyValue]) -> AppResult<String> {
    if variables.len() > 500 {
        return Err(AppError::invalid(
            "An environment supports at most 500 variables.",
        ));
    }
    if let Some((_, error)) = variable_name_issue(variables) {
        return Err(error);
    }
    let mut ids = HashSet::new();
    for (index, v) in variables.iter().enumerate() {
        validation::id(&v.id)?;
        let label = format!(
            "Variable #{} {}",
            index + 1,
            validation::diagnostic_name(&v.name)
        );
        if !ids.insert(&v.id) {
            return Err(AppError::invalid(format!(
                "{label}: Duplicate row identifier. Recreate this row."
            )));
        }
        if v.value.len() > 65536 || v.description.len() > 8192 {
            return Err(AppError::invalid(format!(
                "{label}: A variable value is limited to 64 KiB and its description to 8 KiB."
            )));
        }
    }
    let json =
        serde_json::to_string(variables).map_err(|_| AppError::invalid("Invalid variables."))?;
    if json.len() > 1024 * 1024 {
        return Err(AppError::invalid("An environment is limited to 1 MiB."));
    }
    Ok(json)
}
pub fn list(conn: &Connection) -> AppResult<Vec<Environment>> {
    let mut stmt = conn.prepare(
        "SELECT id,collection_id,name,variables_json,revision FROM environments ORDER BY name,id",
    )?;
    let raw = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, i64>(4)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    raw.into_iter()
        .map(|(id, collection_id, name, json, revision)| {
            Ok(Environment {
                id,
                collection_id,
                name,
                revision,
                variables: serde_json::from_str(&json).map_err(|_| {
                    AppError::new(
                        "DATABASE_ERROR",
                        "Saved environment variables could not be read.",
                    )
                })?,
            })
        })
        .collect()
}
pub fn selections(conn: &Connection) -> AppResult<Vec<EnvironmentSelection>> {
    let mut stmt = conn.prepare(
        "SELECT collection_id,environment_id FROM environment_selections ORDER BY scope",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(EnvironmentSelection {
                collection_id: r.get(0)?,
                environment_id: r.get(1)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}
pub fn save(conn: &mut Connection, input: SaveEnvironment) -> AppResult<Environment> {
    let name = validation::name(&input.name)?;
    let json = validate_variables(&input.variables)?;
    let tx = conn.transaction()?;
    scope(&tx, input.collection_id.as_deref())?;
    let duplicate: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM environments WHERE collection_id IS ?1 AND name=?2 AND (?3 IS NULL OR id != ?3))", params![input.collection_id,name,input.id], |r| r.get(0))?;
    if duplicate {
        return Err(AppError::invalid(
            "An environment with that name already exists in this scope.",
        ));
    }
    let (id, revision) = if let Some(id) = input.id {
        validation::id(&id)?;
        let (collection, revision): (Option<String>, i64) = tx.query_row(
            "SELECT collection_id,revision FROM environments WHERE id=?1",
            [&id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        if collection != input.collection_id {
            return Err(AppError::invalid("An environment cannot change scope."));
        }
        if Some(revision) != input.revision {
            return Err(AppError::new(
                "CONFLICT",
                "This environment changed. Reset to the saved version before retrying.",
            ));
        }
        tx.execute(
            "UPDATE environments SET name=?1,variables_json=?2,revision=revision+1 WHERE id=?3",
            params![name, json, id],
        )?;
        (id, revision + 1)
    } else {
        let count: i64 = tx.query_row("SELECT count(*) FROM environments", [], |r| r.get(0))?;
        if count >= 1000 {
            return Err(AppError::invalid("At most 1000 environments can be saved."));
        }
        let id = uuid::Uuid::new_v4().to_string();
        tx.execute(
            "INSERT INTO environments VALUES (?1,?2,?3,?4,1)",
            params![id, input.collection_id, name, json],
        )?;
        (id, 1)
    };
    tx.commit()?;
    Ok(Environment {
        id,
        collection_id: input.collection_id,
        name,
        variables: input.variables,
        revision,
    })
}
pub fn delete(conn: &mut Connection, id: &str) -> AppResult<()> {
    validation::id(id)?;
    if conn.execute("DELETE FROM environments WHERE id=?1", [id])? == 0 {
        return Err(AppError::missing());
    }
    Ok(())
}
pub fn select(
    conn: &mut Connection,
    input: EnvironmentSelection,
) -> AppResult<EnvironmentSelection> {
    let tx = conn.transaction()?;
    scope(&tx, input.collection_id.as_deref())?;
    if let Some(id) = &input.environment_id {
        validation::id(id)?;
        let collection: Option<String> = tx.query_row(
            "SELECT collection_id FROM environments WHERE id=?1",
            [id],
            |r| r.get(0),
        )?;
        if collection != input.collection_id {
            return Err(AppError::invalid(
                "Select an environment from the current scope.",
            ));
        }
    }
    tx.execute("INSERT INTO environment_selections VALUES (?1,?2,?3) ON CONFLICT(scope) DO UPDATE SET environment_id=excluded.environment_id", params![input.collection_id.as_deref().unwrap_or("global"),input.collection_id,input.environment_id])?;
    tx.commit()?;
    Ok(input)
}
pub(crate) fn active_variables(
    conn: &Connection,
    collection: Option<&str>,
) -> AppResult<Vec<KeyValue>> {
    let json: Option<String> = conn.query_row("SELECT e.variables_json FROM environments e JOIN environment_selections s ON s.environment_id=e.id WHERE s.scope=?1 AND e.collection_id IS ?2", params![collection.unwrap_or("global"),collection], |r| r.get(0)).optional()?;
    json.map(|json| serde_json::from_str(&json).map_err(|_| AppError::database()))
        .unwrap_or_else(|| Ok(vec![]))
}
fn expand(
    text: &str,
    variables: &BTreeMap<String, String>,
    stack: &mut Vec<String>,
) -> AppResult<String> {
    let mut output = String::new();
    let mut rest = text;
    while let Some(start) = rest.find("<<") {
        output.push_str(&rest[..start]);
        let tail = &rest[start + 2..];
        let end = tail.find(">>").ok_or_else(|| {
            AppError::new(
                "INVALID_VARIABLE",
                "Close each variable placeholder with >>.",
            )
        })?;
        let name = &tail[..end];
        if !variable_name(name) {
            return Err(AppError::new(
                "INVALID_VARIABLE",
                "Use a variable placeholder such as <<api_url>>.",
            ));
        }
        let value = variables.get(name).ok_or_else(|| {
            AppError::new(
                "VARIABLE_NOT_FOUND",
                format!("Variable <<{name}>> is not enabled in the selected environments."),
            )
        })?;
        if stack.iter().any(|item| item == name) || stack.len() >= 16 {
            return Err(AppError::new(
                "VARIABLE_CYCLE",
                "Environment variables contain a cycle or exceed 16 nested references.",
            ));
        }
        stack.push(name.into());
        output.push_str(&expand(value, variables, stack)?);
        stack.pop();
        if output.len() > 65536 {
            return Err(AppError::invalid(
                "Expanded variable content exceeds 64 KiB.",
            ));
        }
        rest = &tail[end + 2..];
    }
    output.push_str(rest);
    if output.len() > 65536 {
        return Err(AppError::invalid(
            "Expanded variable content exceeds 64 KiB.",
        ));
    }
    Ok(output)
}
pub fn resolve_request(conn: &Connection, mut doc: RequestDoc) -> AppResult<RequestDoc> {
    validation::request(&doc)?;
    scope(conn, Some(&doc.collection_id))?;
    let mut variables = BTreeMap::new();
    for scope in [None, Some(doc.collection_id.as_str())] {
        for v in active_variables(conn, scope)?
            .into_iter()
            .filter(|v| v.enabled)
        {
            variables.insert(v.name, v.value);
        }
    }
    doc.url = expand(&doc.url, &variables, &mut vec![])?;
    for rows in [&mut doc.params, &mut doc.headers] {
        for row in rows.iter_mut().filter(|r| r.enabled && !r.name.is_empty()) {
            row.name = expand(&row.name, &variables, &mut vec![])?;
            row.value = expand(&row.value, &variables, &mut vec![])?;
            if row.name.is_empty() {
                return Err(AppError::invalid(
                    "An expanded parameter or header name cannot be empty.",
                ));
            }
        }
    }
    validation::request(&doc)?;
    Ok(doc)
}
