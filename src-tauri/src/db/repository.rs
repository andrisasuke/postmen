use super::validation;
use crate::{
    error::{AppError, AppResult},
    models::*,
};
use rusqlite::{params, Connection, OptionalExtension, Params, Row};
use std::{
    collections::HashSet,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

pub(crate) fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

type ExecutionResources = Vec<(String, std::path::PathBuf)>;
pub fn execution_resources(conn: &Connection, doc: &RequestDoc) -> AppResult<ExecutionResources> {
    let mut paths = vec![];
    if doc.body_kind == "multipart" {
        for field in doc
            .form_data
            .iter()
            .filter(|f| f.enabled && !f.name.is_empty() && f.kind == "file")
        {
            let id = field.attachment_id.as_ref().ok_or_else(|| {
                AppError::new(
                    "FILE_UNAVAILABLE",
                    "Choose a file for each enabled multipart file field.",
                )
            })?;
            let path: String = conn
                .query_row("SELECT path FROM attachments WHERE id=?1", [id], |r| {
                    r.get(0)
                })
                .map_err(|_| {
                    AppError::new(
                        "FILE_UNAVAILABLE",
                        "A selected file is no longer registered. Choose it again.",
                    )
                })?;
            paths.push((id.clone(), path.into()));
        }
    }
    Ok(paths)
}
// JSON escaping and character decoding can expand the one MiB preview substantially.
const MAX_SNAPSHOT_JSON_BYTES: usize = 16 * 1024 * 1024;

// Decoding may replace each invalid byte with a three-byte replacement character.
fn valid_snapshot(result: &crate::execution::models::ExecutionResult) -> bool {
    // Lossy UTF-8 decoding can expand each invalid header byte to U+FFFD.
    let headers_valid = result.headers.len() <= 1000
        && result.headers.iter().all(|header| {
            reqwest::header::HeaderName::from_bytes(header.name.as_bytes()).is_ok()
                && header.value.len() <= 3 * 65536
        })
        && result
            .headers
            .iter()
            .map(|header| {
                header.name.len() + header.value.len() - 2 * header.value.matches('�').count()
            })
            .sum::<usize>()
            <= 65536;
    let common = validation::id(&result.request_id).is_ok()
        && validation::id(&result.execution_id).is_ok()
        && result.preview_bytes <= crate::execution::http::PREVIEW_LIMIT
        && (!result.truncated || result.preview_bytes == crate::execution::http::PREVIEW_LIMIT)
        && result.duration_ms <= 9_007_199_254_740_991
        && result.body.len() <= 3 * result.preview_bytes
        && result.body_encoding.len() <= 64
        && encoding_rs::Encoding::for_label(result.body_encoding.as_bytes()).is_some()
        && result.status_text.len() <= 128
        && result.error_code.as_ref().is_none_or(|s| s.len() <= 128)
        && result.message.as_ref().is_none_or(|s| s.len() <= 4096)
        && headers_valid;
    common
        && match result.outcome.as_str() {
            "success" => {
                result
                    .status
                    .is_some_and(|status| (100..=999).contains(&status))
                    && result.error_code.is_none()
                    && result.message.is_none()
            }
            "error" | "cancelled" => {
                result.status.is_none()
                    && result.status_text.is_empty()
                    && result.headers.is_empty()
                    && !result.headers_truncated
                    && result.body.is_empty()
                    && result.preview_bytes == 0
                    && !result.truncated
                    && !result.binary
                    && result.error_code.as_ref().is_some_and(|s| !s.is_empty())
                    && result.message.as_ref().is_some_and(|s| !s.is_empty())
                    && (result.outcome == "cancelled")
                        == (result.error_code.as_deref() == Some("CANCELLED"))
            }
            _ => false,
        }
}

pub fn save_last_execution(
    conn: &Connection,
    result: &crate::execution::models::ExecutionResult,
    completed_at: i64,
) -> AppResult<()> {
    if !valid_snapshot(result) {
        return Err(AppError::invalid("Invalid execution snapshot."));
    }
    if completed_at < 0 {
        return Err(AppError::invalid("Invalid completion timestamp."));
    }
    let mut stored = result.clone();
    stored.history_warning = None;
    stored.snapshot_warning = None;
    let json = serde_json::to_string(&stored).map_err(|_| AppError::database())?;
    if json.len() > MAX_SNAPSHOT_JSON_BYTES {
        return Err(AppError::invalid(
            "The execution snapshot exceeds the storage limit.",
        ));
    }
    conn.execute(
        "INSERT INTO last_executions(request_id, execution_id, completed_at, result_json) SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM requests WHERE id=?1) ON CONFLICT(request_id) DO UPDATE SET execution_id=excluded.execution_id, completed_at=excluded.completed_at, result_json=excluded.result_json WHERE excluded.completed_at >= last_executions.completed_at",
        params![result.request_id, result.execution_id, completed_at, json],
    )?;
    Ok(())
}

pub fn get_last_execution(
    conn: &Connection,
    request_id: &str,
) -> AppResult<Option<crate::execution::models::LastExecution>> {
    use crate::execution::models::{ExecutionResult, LastExecution};
    validation::id(request_id)?;
    let raw: Option<(String, i64, String)> = conn.query_row(
        "SELECT execution_id, completed_at, result_json FROM last_executions WHERE request_id=?1",
        [request_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    ).optional()?;
    raw.map(|(execution_id, completed_at, json)| {
        let corrupt = || {
            AppError::new(
                "DATABASE_ERROR",
                "The saved execution could not be decoded.",
            )
        };
        if json.len() > MAX_SNAPSHOT_JSON_BYTES
            || completed_at < 0
            || validation::id(&execution_id).is_err()
        {
            return Err(corrupt());
        }
        let mut result: ExecutionResult = serde_json::from_str(&json).map_err(|_| corrupt())?;
        if result.request_id != request_id
            || result.execution_id != execution_id
            || !valid_snapshot(&result)
        {
            return Err(corrupt());
        }
        result.history_warning = None;
        result.snapshot_warning = None;
        Ok(LastExecution {
            completed_at,
            result,
        })
    })
    .transpose()
}
pub fn record_execution(
    conn: &mut Connection,
    result: &crate::execution::models::ExecutionResult,
    method: &str,
) -> AppResult<()> {
    use crate::execution::models::HistorySummary;
    let tx = conn.transaction()?;
    let request_id: Option<String> = tx
        .query_row(
            "SELECT id FROM requests WHERE id=?1",
            [&result.request_id],
            |r| r.get(0),
        )
        .optional()?;
    let summary = HistorySummary {
        execution_id: result.execution_id.clone(),
        method: method.into(),
        status: result.status,
        duration_ms: result.duration_ms,
        preview_bytes: result.preview_bytes,
        truncated: result.truncated,
        error_code: result.error_code.clone(),
    };
    let payload = serde_json::to_string(&summary).map_err(|_| AppError::database())?;
    tx.execute("INSERT INTO request_history(id,request_id,outcome,created_at,summary_json) VALUES (?1,?2,?3,?4,?5)",params![result.execution_id,request_id,result.outcome,now(),payload])?;
    tx.execute("DELETE FROM request_history WHERE id NOT IN (SELECT id FROM request_history ORDER BY created_at DESC,rowid DESC LIMIT 500)",[])?;
    tx.commit()?;
    Ok(())
}
pub fn list_history(
    conn: &Connection,
    input: crate::execution::models::HistoryQuery,
) -> AppResult<Vec<crate::execution::models::HistoryItem>> {
    use crate::execution::models::{HistoryItem, HistorySummary};
    if input.limit == 0 || input.limit > 100 || input.offset > 500 {
        return Err(AppError::invalid(
            "History pages support 1–100 rows and an offset up to 500.",
        ));
    }
    if let Some(id) = &input.request_id {
        validation::id(id)?;
    }
    let raw=rows(conn,"SELECT id,request_id,outcome,created_at,summary_json FROM request_history WHERE (?1 IS NULL OR request_id=?1) ORDER BY created_at DESC,rowid DESC LIMIT ?2 OFFSET ?3",params![input.request_id,input.limit,input.offset],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,String>(2)?,r.get::<_,i64>(3)?,r.get::<_,String>(4)?)))?;
    raw.into_iter()
        .map(|(id, request_id, outcome, created_at, json)| {
            Ok(HistoryItem {
                id,
                request_id,
                outcome,
                created_at,
                summary: serde_json::from_str::<HistorySummary>(&json).map_err(|_| {
                    AppError::new("DATABASE_ERROR", "A history record could not be decoded.")
                })?,
            })
        })
        .collect()
}
fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn rows<T>(
    conn: &Connection,
    sql: &str,
    args: impl Params,
    f: impl FnMut(&Row<'_>) -> rusqlite::Result<T>,
) -> AppResult<Vec<T>> {
    let mut statement = conn.prepare(sql)?;
    let values = statement
        .query_map(args, f)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(values)
}
fn collection_row(r: &Row<'_>) -> rusqlite::Result<Collection> {
    Ok(Collection {
        id: r.get(0)?,
        name: r.get(1)?,
        position: r.get(2)?,
        created_at: r.get(3)?,
        updated_at: r.get(4)?,
    })
}
fn folder_row(r: &Row<'_>) -> rusqlite::Result<Folder> {
    Ok(Folder {
        id: r.get(0)?,
        collection_id: r.get(1)?,
        parent_id: r.get(2)?,
        name: r.get(3)?,
        position: r.get(4)?,
    })
}
fn require_collection(conn: &Connection, id: &str) -> AppResult<()> {
    validation::id(id)?;
    conn.query_row("SELECT id FROM collections WHERE id=?1", [id], |_| Ok(()))?;
    Ok(())
}
fn require_parent(conn: &Connection, collection: &str, parent: Option<&str>) -> AppResult<()> {
    require_collection(conn, collection)?;
    if let Some(id) = parent {
        validation::id(id)?;
        if !conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM folders WHERE id=?1 AND collection_id=?2)",
            params![id, collection],
            |r| r.get::<_, bool>(0),
        )? {
            return Err(AppError::invalid(
                "The destination folder must belong to this collection.",
            ));
        }
    }
    Ok(())
}
fn next_position(conn: &Connection, collection: &str, parent: Option<&str>) -> AppResult<i64> {
    Ok(conn.query_row("SELECT coalesce(max(position),-1)+1 FROM (SELECT position FROM folders WHERE collection_id=?1 AND parent_id IS ?2 UNION ALL SELECT position FROM requests WHERE collection_id=?1 AND folder_id IS ?2)", params![collection,parent], |r|r.get(0))?)
}
pub fn create_collection(conn: &mut Connection, input: CreateCollection) -> AppResult<Collection> {
    let item = Collection {
        id: new_id(),
        name: validation::name(&input.name)?,
        position: conn.query_row(
            "SELECT coalesce(max(position),-1)+1 FROM collections",
            [],
            |r| r.get(0),
        )?,
        created_at: now(),
        updated_at: now(),
    };
    conn.execute(
        "INSERT INTO collections VALUES (?1,?2,?3,?4,?5)",
        params![
            item.id,
            item.name,
            item.position,
            item.created_at,
            item.updated_at
        ],
    )?;
    Ok(item)
}
pub fn rename_collection(conn: &mut Connection, input: Rename) -> AppResult<Collection> {
    validation::id(&input.id)?;
    let name = validation::name(&input.name)?;
    if conn.execute(
        "UPDATE collections SET name=?1,updated_at=?2 WHERE id=?3",
        params![name, now(), input.id],
    )? == 0
    {
        return Err(AppError::missing());
    }
    Ok(conn.query_row(
        "SELECT id,name,position,created_at,updated_at FROM collections WHERE id=?1",
        [&input.id],
        collection_row,
    )?)
}
pub fn create_folder(conn: &mut Connection, input: CreateFolder) -> AppResult<Folder> {
    let tx = conn.transaction()?;
    require_parent(&tx, &input.collection_id, input.parent_id.as_deref())?;
    let item = Folder {
        id: new_id(),
        name: validation::name(&input.name)?,
        position: next_position(&tx, &input.collection_id, input.parent_id.as_deref())?,
        collection_id: input.collection_id,
        parent_id: input.parent_id,
    };
    tx.execute(
        "INSERT INTO folders VALUES (?1,?2,?3,?4,?5)",
        params![
            item.id,
            item.collection_id,
            item.parent_id,
            item.name,
            item.position
        ],
    )?;
    tx.commit()?;
    Ok(item)
}
pub fn update_folder(conn: &mut Connection, input: UpdateFolder) -> AppResult<Folder> {
    validation::id(&input.id)?;
    let tx = conn.transaction()?;
    let old = tx.query_row(
        "SELECT id,collection_id,parent_id,name,position FROM folders WHERE id=?1",
        [&input.id],
        folder_row,
    )?;
    require_parent(&tx, &old.collection_id, input.parent_id.as_deref())?;
    let position = if old.parent_id == input.parent_id {
        old.position
    } else {
        next_position(&tx, &old.collection_id, input.parent_id.as_deref())?
    };
    tx.execute(
        "UPDATE folders SET name=?1,parent_id=?2,position=?3 WHERE id=?4",
        params![
            validation::name(&input.name)?,
            input.parent_id,
            position,
            input.id
        ],
    )?;
    let result = tx.query_row(
        "SELECT id,collection_id,parent_id,name,position FROM folders WHERE id=?1",
        [&input.id],
        folder_row,
    )?;
    tx.commit()?;
    Ok(result)
}
pub fn move_folder(conn: &mut Connection, input: MoveFolder) -> AppResult<MoveFolderResult> {
    validation::id(&input.id)?;
    let tx = conn.transaction()?;
    let old = tx.query_row(
        "SELECT id,collection_id,parent_id,name,position FROM folders WHERE id=?1",
        [&input.id],
        folder_row,
    )?;
    require_parent(&tx, &old.collection_id, input.target_folder_id.as_deref())?;
    if let Some(anchor_id) = &input.anchor_id {
        validation::id(anchor_id)?;
        let anchor_exists = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM requests WHERE id=?1 AND collection_id=?2 AND folder_id IS ?3)",
            params![anchor_id, old.collection_id, input.target_folder_id],
            |row| row.get::<_, bool>(0),
        )?;
        if !anchor_exists {
            return Err(AppError::invalid(
                "The request you dropped beside is no longer in the destination folder.",
            ));
        }
    }
    let mut destination = Vec::new();
    {
        let mut statement = tx.prepare(
            "SELECT 'folder', id, position FROM folders WHERE collection_id=?1 AND parent_id IS ?2 UNION ALL SELECT 'request', id, position FROM requests WHERE collection_id=?1 AND folder_id IS ?2 ORDER BY 3, 2",
        )?;
        let rows = statement
            .query_map(params![old.collection_id, input.target_folder_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
        for row in rows {
            let (kind, id) = row?;
            if kind != "folder" || id != old.id {
                destination.push(TreeRef { kind, id });
            }
        }
    }
    let insertion = if let Some(anchor_id) = &input.anchor_id {
        destination
            .iter()
            .position(|item| item.kind == "request" && item.id == *anchor_id)
            .ok_or_else(|| {
                AppError::invalid(
                    "The request you dropped beside is no longer in the destination folder.",
                )
            })?
            + usize::from(input.insert_after)
    } else {
        destination.len()
    };
    destination.insert(
        insertion,
        TreeRef {
            kind: "folder".into(),
            id: old.id.clone(),
        },
    );
    // The schema trigger rejects self/descendant moves; this transaction then rolls back intact.
    tx.execute(
        "UPDATE folders SET parent_id=?1 WHERE id=?2",
        params![input.target_folder_id, old.id],
    )?;
    for (position, item) in destination.iter().enumerate() {
        match item.kind.as_str() {
            "folder" => {
                tx.execute(
                    "UPDATE folders SET position=?1 WHERE id=?2",
                    params![position as i64, item.id],
                )?;
            }
            "request" => {
                tx.execute(
                    "UPDATE requests SET position=?1 WHERE id=?2",
                    params![position as i64, item.id],
                )?;
            }
            _ => return Err(AppError::invalid("Invalid destination item.")),
        };
    }
    let folder = tx.query_row(
        "SELECT id,collection_id,parent_id,name,position FROM folders WHERE id=?1",
        [&old.id],
        folder_row,
    )?;
    tx.commit()?;
    Ok(MoveFolderResult {
        folder,
        items: destination,
    })
}
pub fn create_request(conn: &mut Connection, input: CreateRequest) -> AppResult<RequestDoc> {
    let tx = conn.transaction()?;
    require_parent(&tx, &input.collection_id, input.folder_id.as_deref())?;
    let id = new_id();
    let position = next_position(&tx, &input.collection_id, input.folder_id.as_deref())?;
    let content = input.content.unwrap_or(NewRequestContent {
        method: "GET".into(),
        url: String::new(),
        body_kind: "none".into(),
        body: String::new(),
        params: vec![],
        headers: vec![],
        form_data: vec![],
    });
    let timestamp = now();
    let doc = RequestDoc {
        id,
        collection_id: input.collection_id,
        folder_id: input.folder_id,
        name: validation::name(&input.name)?,
        method: content.method,
        url: content.url,
        body_kind: content.body_kind,
        body: content.body,
        params: content.params,
        headers: content.headers,
        form_data: content.form_data,
        position,
        revision: 1,
        created_at: timestamp,
        updated_at: timestamp,
    };
    validation::request(&doc)?;
    // Create the request and all imported rows in ONE transaction. No placeholder
    // request may survive a failed import or be duplicated when the user retries.
    tx.execute("INSERT INTO requests (id,collection_id,folder_id,name,method,url,body_kind,body,position,revision,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,1,?10,?10)", params![doc.id,doc.collection_id,doc.folder_id,doc.name,doc.method,doc.url,doc.body_kind,doc.body,doc.position,timestamp])?;
    write_request_rows(&tx, &doc)?;
    tx.commit()?;
    Ok(doc)
}
pub fn get_request(conn: &Connection, id: &str) -> AppResult<RequestDoc> {
    validation::id(id)?;
    let mut doc = conn.query_row("SELECT id,collection_id,folder_id,name,method,url,body_kind,body,position,revision,created_at,updated_at FROM requests WHERE id=?1", [id], |r| Ok(RequestDoc {
        id:r.get(0)?,collection_id:r.get(1)?,folder_id:r.get(2)?,name:r.get(3)?,method:r.get(4)?,url:r.get(5)?,body_kind:r.get(6)?,body:r.get(7)?,position:r.get(8)?,revision:r.get(9)?,created_at:r.get(10)?,updated_at:r.get(11)?,params:vec![],headers:vec![],form_data:vec![],
    }))?;
    let kv = |r: &Row<'_>| {
        Ok(KeyValue {
            id: r.get(0)?,
            enabled: r.get(1)?,
            name: r.get(2)?,
            value: r.get(3)?,
            description: r.get(4)?,
        })
    };
    doc.params = rows(conn,"SELECT id,enabled,name,value,description FROM request_params WHERE request_id=?1 ORDER BY position",[id],kv)?;
    doc.headers = rows(conn,"SELECT id,enabled,name,value,description FROM request_headers WHERE request_id=?1 ORDER BY position",[id],kv)?;
    doc.form_data = rows(conn,"SELECT id,enabled,name,kind,value,attachment_id,description FROM form_data_fields WHERE request_id=?1 ORDER BY position",[id],|r|Ok(FormField {id:r.get(0)?,enabled:r.get(1)?,name:r.get(2)?,kind:r.get(3)?,value:r.get(4)?,attachment_id:r.get(5)?,description:r.get(6)?}))?;
    Ok(doc)
}
pub fn save_request(conn: &mut Connection, doc: RequestDoc) -> AppResult<RequestDoc> {
    validation::request(&doc)?;
    let tx = conn.transaction()?;
    let (collection, folder, position, revision): (String, Option<String>, i64, i64) = tx
        .query_row(
            "SELECT collection_id,folder_id,position,revision FROM requests WHERE id=?1",
            [&doc.id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )?;
    if collection != doc.collection_id {
        return Err(AppError::invalid(
            "Requests cannot move between collections.",
        ));
    }
    if revision != doc.revision {
        return Err(AppError::new("CONFLICT", "This request changed in another operation. Your draft was kept; reload the saved version or copy your edits before retrying."));
    }
    require_parent(&tx, &collection, doc.folder_id.as_deref())?;
    let position = if folder == doc.folder_id {
        position
    } else {
        next_position(&tx, &collection, doc.folder_id.as_deref())?
    };
    tx.execute("UPDATE requests SET folder_id=?1,name=?2,method=?3,url=?4,body_kind=?5,body=?6,position=?7,revision=revision+1,updated_at=?8 WHERE id=?9", params![doc.folder_id,validation::name(&doc.name)?,doc.method,doc.url,doc.body_kind,doc.body,position,now(),doc.id])?;
    write_request_rows(&tx, &doc)?;
    let saved = get_request(&tx, &doc.id)?;
    tx.commit()?;
    Ok(saved)
}
pub fn save_and_move_requests(
    conn: &mut Connection,
    input: SaveAndMoveRequests,
) -> AppResult<SaveAndMoveRequestsResult> {
    if input.requests.is_empty() || input.requests.len() > 100 {
        return Err(AppError::invalid(
            "Choose between 1 and 100 requests to move.",
        ));
    }
    let tx = conn.transaction()?;
    let mut seen = HashSet::new();
    let mut collection: Option<String> = None;
    let mut originals = Vec::with_capacity(input.requests.len());
    for item in &input.requests {
        validation::id(&item.id)?;
        if !seen.insert(&item.id) {
            return Err(AppError::invalid("A request was selected more than once."));
        }
        let original = get_request(&tx, &item.id)?;
        if original.revision != item.revision {
            return Err(AppError::new(
                "CONFLICT",
                "A selected request changed in another operation. Your drafts were kept.",
            ));
        }
        if let Some(draft) = &item.draft {
            if draft.id != original.id
                || draft.collection_id != original.collection_id
                || draft.revision != original.revision
            {
                return Err(AppError::new(
                    "CONFLICT",
                    "A selected request changed in another operation. Your drafts were kept.",
                ));
            }
            validation::request(draft)?;
        }
        match &collection {
            Some(id) if id != &original.collection_id => {
                return Err(AppError::invalid(
                    "Requests cannot move between collections.",
                ))
            }
            None => collection = Some(original.collection_id.clone()),
            _ => {}
        }
        originals.push((item, original));
    }
    let collection = collection.ok_or_else(|| AppError::invalid("Choose requests to move."))?;
    require_parent(&tx, &collection, input.target_folder_id.as_deref())?;
    let selected: HashSet<&str> = originals
        .iter()
        .map(|(_, original)| original.id.as_str())
        .collect();
    let mut destination = Vec::new();
    {
        let mut statement = tx.prepare(
            "SELECT 'folder', id, position FROM folders WHERE collection_id=?1 AND parent_id IS ?2 UNION ALL SELECT 'request', id, position FROM requests WHERE collection_id=?1 AND folder_id IS ?2 ORDER BY 3, 2"
        )?;
        let rows = statement.query_map(params![collection, input.target_folder_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (kind, id) = row?;
            // A selected request anchor stays in the destination list: the other
            // selected requests are inserted around it rather than replacing it.
            if input.anchor_id.is_none()
                || kind != "request"
                || !selected.contains(id.as_str())
                || input.anchor_id.as_deref() == Some(id.as_str())
            {
                destination.push(TreeRef { kind, id });
            }
        }
    }
    let insertion = if let Some(anchor_id) = &input.anchor_id {
        validation::id(anchor_id)?;
        let index = destination
            .iter()
            .position(|item| item.kind == "request" && item.id == *anchor_id)
            .ok_or_else(|| {
                AppError::invalid(
                    "The request you dropped beside is no longer in the destination folder.",
                )
            })?;
        index + usize::from(input.insert_after)
    } else {
        destination.len()
    };
    let moved = originals
        .iter()
        .filter(|(_, original)| {
            (input.anchor_id.is_some() || original.folder_id != input.target_folder_id)
                && input.anchor_id.as_deref() != Some(original.id.as_str())
        })
        .map(|(_, original)| TreeRef {
            kind: "request".into(),
            id: original.id.clone(),
        })
        .collect::<Vec<_>>();
    destination.splice(insertion..insertion, moved);
    for (item, original) in &originals {
        let moving = original.folder_id != input.target_folder_id;
        if !moving && item.draft.is_none() {
            continue;
        }
        let mut doc = item.draft.clone().unwrap_or(original.clone());
        doc.folder_id = input.target_folder_id.clone();
        doc.position = original.position;
        validation::request(&doc)?;
        tx.execute("UPDATE requests SET folder_id=?1,name=?2,method=?3,url=?4,body_kind=?5,body=?6,position=?7,revision=revision+1,updated_at=?8 WHERE id=?9", params![doc.folder_id,validation::name(&doc.name)?,doc.method,doc.url,doc.body_kind,doc.body,doc.position,now(),doc.id])?;
        if item.draft.is_some() {
            write_request_rows(&tx, &doc)?;
        }
    }
    for (position, item) in destination.iter().enumerate() {
        match item.kind.as_str() {
            "folder" => {
                tx.execute(
                    "UPDATE folders SET position=?1 WHERE id=?2",
                    params![position as i64, item.id],
                )?;
            }
            "request" => {
                tx.execute(
                    "UPDATE requests SET position=?1 WHERE id=?2",
                    params![position as i64, item.id],
                )?;
            }
            _ => return Err(AppError::invalid("Invalid destination item.")),
        };
    }
    let saved = originals
        .iter()
        .map(|(_, original)| get_request(&tx, &original.id))
        .collect::<AppResult<Vec<_>>>()?;
    tx.commit()?;
    Ok(SaveAndMoveRequestsResult {
        requests: saved,
        items: destination,
    })
}
pub(crate) fn write_request_rows(tx: &Connection, doc: &RequestDoc) -> AppResult<()> {
    for (table, values) in [
        ("request_params", &doc.params),
        ("request_headers", &doc.headers),
    ] {
        tx.execute(
            &format!("DELETE FROM {table} WHERE request_id=?1"),
            [&doc.id],
        )?;
        let mut insert = tx.prepare(&format!(
            "INSERT INTO {table} VALUES (?1,?2,?3,?4,?5,?6,?7)"
        ))?;
        for (index, row) in values.iter().enumerate() {
            insert.execute(params![
                row.id,
                doc.id,
                row.enabled,
                row.name,
                row.value,
                row.description,
                index as i64
            ])?;
        }
    }
    tx.execute(
        "DELETE FROM form_data_fields WHERE request_id=?1",
        [&doc.id],
    )?;
    for (index, row) in doc.form_data.iter().enumerate() {
        tx.execute(
            "INSERT INTO form_data_fields VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![
                row.id,
                doc.id,
                row.enabled,
                row.name,
                row.kind,
                row.value,
                row.attachment_id,
                row.description,
                index as i64
            ],
        )?;
    }
    Ok(())
}
// The table is selected in Rust, never interpolated from frontend input.
pub fn delete_item(conn: &mut Connection, kind: &str, id: &str) -> AppResult<()> {
    validation::id(id)?;
    let table = match kind {
        "collection" => "collections",
        "folder" => "folders",
        "request" => "requests",
        _ => return Err(AppError::invalid("Unsupported item type.")),
    };
    let tx = conn.transaction()?;
    if tx.execute(&format!("DELETE FROM {table} WHERE id=?1"), [id])? == 0 {
        return Err(AppError::missing());
    }
    // Folder/collection cascades remove descendants; stale tab IDs are discarded on restore.
    tx.commit()?;
    Ok(())
}
pub fn reorder(conn: &mut Connection, input: Reorder) -> AppResult<()> {
    if input.items.len() > 10000 {
        return Err(AppError::new("LIMIT_EXCEEDED", "Too many tree items."));
    }
    let tx = conn.transaction()?;
    let expected: Vec<TreeRef> = if let Some(collection) = &input.collection_id {
        require_parent(&tx, collection, input.parent_id.as_deref())?;
        rows(&tx,"SELECT 'folder',id FROM folders WHERE collection_id=?1 AND parent_id IS ?2 UNION ALL SELECT 'request',id FROM requests WHERE collection_id=?1 AND folder_id IS ?2",params![collection,input.parent_id],|r|Ok(TreeRef{kind:r.get(0)?,id:r.get(1)?}))?
    } else {
        if input.parent_id.is_some() {
            return Err(AppError::invalid("Collection order cannot have a parent."));
        }
        rows(&tx, "SELECT 'collection',id FROM collections", [], |r| {
            Ok(TreeRef {
                kind: r.get(0)?,
                id: r.get(1)?,
            })
        })?
    };
    let expected: HashSet<_> = expected.into_iter().collect();
    let supplied: HashSet<_> = input.items.iter().cloned().collect();
    if supplied.len() != input.items.len() || expected != supplied {
        return Err(AppError::invalid(
            "Reorder must include every sibling exactly once. Refresh and try again.",
        ));
    }
    for (index, item) in input.items.iter().enumerate() {
        let table = match item.kind.as_str() {
            "collection" => "collections",
            "folder" => "folders",
            "request" => "requests",
            _ => return Err(AppError::invalid("Invalid tree item.")),
        };
        tx.execute(
            &format!("UPDATE {table} SET position=?1 WHERE id=?2"),
            params![index as i64, item.id],
        )?;
    }
    tx.commit()?;
    Ok(())
}
fn clean_session(conn: &Connection, mut session: Session) -> AppResult<Session> {
    validation::session(&session)?;
    let ids: HashSet<String> = rows(conn, "SELECT id FROM requests", [], |r| r.get(0))?
        .into_iter()
        .collect();
    let mut seen = HashSet::new();
    session
        .tab_ids
        .retain(|id| ids.contains(id) && seen.insert(id.clone()));
    if session
        .active_id
        .as_ref()
        .is_some_and(|id| !session.tab_ids.contains(id))
    {
        session.active_id = session.tab_ids.first().cloned();
    }
    session.views.retain(|id, _| session.tab_ids.contains(id));
    Ok(session)
}
pub fn save_session(conn: &mut Connection, session: Session) -> AppResult<Session> {
    let session = clean_session(conn, session)?;
    let text =
        serde_json::to_string(&session).map_err(|_| AppError::invalid("Invalid session."))?;
    conn.execute("INSERT INTO app_settings VALUES ('session.v1',?1) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",[text])?;
    Ok(session)
}
pub fn workspace(conn: &mut Connection) -> AppResult<Workspace> {
    workspace_snapshot(conn)
}
pub(crate) fn workspace_snapshot(conn: &Connection) -> AppResult<Workspace> {
    // Restore display metadata from SQLite without probing files on disk.
    let attachments = rows(
        conn,
        "SELECT DISTINCT a.id,a.name,a.size FROM attachments a JOIN form_data_fields f ON f.attachment_id=a.id ORDER BY a.id",
        [],
        |r| Ok(Attachment { id: r.get(0)?, name: r.get(1)?, size: r.get::<_, i64>(2)? as u64 }),
    )?;
    let collections = rows(
        conn,
        "SELECT id,name,position,created_at,updated_at FROM collections ORDER BY position,id",
        [],
        collection_row,
    )?;
    let folders = rows(
        conn,
        "SELECT id,collection_id,parent_id,name,position FROM folders ORDER BY position,id",
        [],
        folder_row,
    )?;
    let requests=rows(conn,"SELECT id,collection_id,folder_id,name,method,position,revision FROM requests ORDER BY position,id",[],|r|Ok(RequestSummary{id:r.get(0)?,collection_id:r.get(1)?,folder_id:r.get(2)?,name:r.get(3)?,method:r.get(4)?,position:r.get(5)?,revision:r.get(6)?}))?;
    let environments = super::environments::list(conn)?;
    let environment_selections = super::environments::selections(conn)?;
    let text: Option<String> = conn
        .query_row(
            "SELECT value_json FROM app_settings WHERE key='session.v1'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    let mut warnings = vec![];
    let session = if let Some(text) = text {
        match serde_json::from_str::<Session>(&text)
            .map_err(|_| AppError::invalid("Invalid saved session."))
            .and_then(|s| clean_session(conn, s))
        {
            Ok(s) => s,
            Err(_) => {
                warnings.push("The saved tab layout could not be restored. Your collections and requests are still available.".into());
                Session::default()
            }
        }
    } else {
        Session::default()
    };
    Ok(Workspace {
        attachments,
        collections,
        folders,
        requests,
        environments,
        environment_selections,
        session,
        warnings,
    })
}
pub fn register_attachment(conn: &mut Connection, path: &Path) -> AppResult<Attachment> {
    let canonical = path.canonicalize().map_err(|_| {
        AppError::new(
            "FILE_UNAVAILABLE",
            "The selected file could not be accessed.",
        )
    })?;
    let meta = canonical.metadata().map_err(|_| {
        AppError::new(
            "FILE_UNAVAILABLE",
            "The selected file could not be inspected.",
        )
    })?;
    if !meta.is_file() || meta.len() > i64::MAX as u64 {
        return Err(AppError::invalid("Choose a regular file."));
    }
    let item = Attachment {
        id: new_id(),
        name: canonical
            .file_name()
            .ok_or_else(|| AppError::invalid("Invalid filename."))?
            .to_string_lossy()
            .into_owned(),
        size: meta.len(),
    };
    let path = canonical
        .to_str()
        .ok_or_else(|| AppError::invalid("The selected path cannot be represented as UTF-8."))?;
    conn.execute(
        "INSERT INTO attachments VALUES (?1,?2,?3,?4)",
        params![item.id, path, item.name, item.size as i64],
    )?;
    Ok(item)
}
