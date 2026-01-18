use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HttpResponse {
    pub status: u16,
    pub status_text: String,
    pub time_ms: u64,
    pub size_bytes: usize,
    pub headers: HashMap<String, String>,
    pub body: String,
}

impl HttpResponse {
    pub fn status_class(&self) -> &'static str {
        match self.status {
            0 => "error",
            200..=299 => "success",
            300..=399 => "redirect",
            400..=499 => "client-error",
            500..=599 => "server-error",
            _ => "unknown",
        }
    }

    pub fn status_display(&self) -> String {
        if self.status == 0 {
            "Error".to_string()
        } else {
            format!("{} {}", self.status, self.status_text)
        }
    }
}
