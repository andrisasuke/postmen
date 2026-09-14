use crate::models::RequestDoc;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrepareExecution {
    pub execution_id: String,
    pub request: RequestDoc,
    pub timeout_ms: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseHeader {
    pub name: String,
    pub value: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionResult {
    pub execution_id: String,
    pub request_id: String,
    pub outcome: String,
    pub status: Option<u16>,
    pub status_text: String,
    pub headers: Vec<ResponseHeader>,
    pub headers_truncated: bool,
    pub body: String,
    pub body_encoding: String,
    pub binary: bool,
    pub preview_bytes: usize,
    pub truncated: bool,
    pub duration_ms: u64,
    pub error_code: Option<String>,
    pub message: Option<String>,
    pub history_warning: Option<String>,
}
impl ExecutionResult {
    pub fn empty(execution_id: &str, request_id: &str) -> Self {
        Self {
            execution_id: execution_id.into(),
            request_id: request_id.into(),
            outcome: "success".into(),
            status: None,
            status_text: String::new(),
            headers: vec![],
            headers_truncated: false,
            body: String::new(),
            body_encoding: "UTF-8".into(),
            binary: false,
            preview_bytes: 0,
            truncated: false,
            duration_ms: 0,
            error_code: None,
            message: None,
            history_warning: None,
        }
    }
    pub fn failure(execution_id: &str, request_id: &str, code: &str, message: &str) -> Self {
        let mut value = Self::empty(execution_id, request_id);
        value.outcome = if code == "CANCELLED" {
            "cancelled"
        } else {
            "error"
        }
        .into();
        value.error_code = Some(code.into());
        value.message = Some(message.into());
        value
    }
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySummary {
    pub execution_id: String,
    pub method: String,
    pub status: Option<u16>,
    pub duration_ms: u64,
    pub preview_bytes: usize,
    pub truncated: bool,
    pub error_code: Option<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryItem {
    pub id: String,
    pub request_id: Option<String>,
    pub outcome: String,
    pub created_at: i64,
    pub summary: HistorySummary,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryQuery {
    pub request_id: Option<String>,
    pub limit: u32,
    pub offset: u32,
}
