use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RequestHistory {
    pub id: String,
    pub request_id: Option<String>,
    pub method: String,
    pub url: String,
    pub headers: String, // JSON string
    pub body: String,
    pub response_status: Option<u16>,
    pub response_time_ms: Option<u64>,
    pub response_size_bytes: Option<usize>,
    pub response_headers: Option<String>, // JSON string
    pub response_body: Option<String>,
    pub sent_at: String,
}

impl RequestHistory {
    pub fn new(
        request_id: Option<String>,
        method: String,
        url: String,
        headers: String,
        body: String,
    ) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            request_id,
            method,
            url,
            headers,
            body,
            response_status: None,
            response_time_ms: None,
            response_size_bytes: None,
            response_headers: None,
            response_body: None,
            sent_at: chrono::Utc::now().to_rfc3339(),
        }
    }
}
