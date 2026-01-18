use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Hostname {
    pub id: String,
    pub name: String,
    pub url: String,
    pub created_at: String,
    pub updated_at: String,
    pub sort_order: i32,
}

impl Hostname {
    pub fn new(name: String, url: String) -> Self {
        let now = chrono::Utc::now().to_rfc3339();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            url,
            created_at: now.clone(),
            updated_at: now,
            sort_order: 0,
        }
    }
}
