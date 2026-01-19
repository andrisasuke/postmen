use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
pub enum BodyType {
    #[default]
    Json,
    MultipartFormData,
}

impl BodyType {
    pub fn from_str(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "multipart" | "multipart form" | "multipart_form_data" | "multipartformdata" => BodyType::MultipartFormData,
            _ => BodyType::Json,
        }
    }

    pub fn db_value(&self) -> &'static str {
        match self {
            BodyType::Json => "Json",
            BodyType::MultipartFormData => "MultipartFormData",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
pub enum FormFieldType {
    #[default]
    Text,
    File,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FormDataField {
    pub id: String,
    pub request_id: String,
    pub key: String,
    pub value: String,        // For Text: the text value, For File: the file path
    pub description: String,
    pub field_type: FormFieldType,
    pub enabled: bool,
    pub sort_order: i32,
}

impl FormDataField {
    pub fn new(request_id: String) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            request_id,
            key: String::new(),
            value: String::new(),
            description: String::new(),
            field_type: FormFieldType::Text,
            enabled: true,
            sort_order: 0,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum HttpMethod {
    GET,
    POST,
    PUT,
    DELETE,
    OPTIONS,
}

impl HttpMethod {
    pub fn as_str(&self) -> &'static str {
        match self {
            HttpMethod::GET => "GET",
            HttpMethod::POST => "POST",
            HttpMethod::PUT => "PUT",
            HttpMethod::DELETE => "DELETE",
            HttpMethod::OPTIONS => "OPTIONS",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s.to_uppercase().as_str() {
            "GET" => HttpMethod::GET,
            "POST" => HttpMethod::POST,
            "PUT" => HttpMethod::PUT,
            "DELETE" => HttpMethod::DELETE,
            "OPTIONS" => HttpMethod::OPTIONS,
            _ => HttpMethod::GET,
        }
    }

    pub fn css_class(&self) -> &'static str {
        match self {
            HttpMethod::GET => "method-get",
            HttpMethod::POST => "method-post",
            HttpMethod::PUT => "method-put",
            HttpMethod::DELETE => "method-delete",
            HttpMethod::OPTIONS => "method-options",
        }
    }
}

impl std::fmt::Display for HttpMethod {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Request {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub method: HttpMethod,
    pub path: String,
    pub hostname_id: Option<String>,
    pub body: String,
    pub body_type: BodyType,
    pub created_at: String,
    pub updated_at: String,
    pub sort_order: i32,
    pub params: Vec<RequestParam>,
    pub headers: Vec<RequestHeader>,
    pub form_data: Vec<FormDataField>,
}

impl Request {
    pub fn new(project_id: String, name: String) -> Self {
        let now = chrono::Utc::now().to_rfc3339();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            project_id,
            name,
            method: HttpMethod::GET,
            path: String::new(),
            hostname_id: None,
            body: String::new(),
            body_type: BodyType::Json,
            created_at: now.clone(),
            updated_at: now,
            sort_order: 0,
            params: Vec::new(),
            headers: Vec::new(),
            form_data: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RequestParam {
    pub id: String,
    pub request_id: String,
    pub key: String,
    pub value: String,
    pub description: String,
    pub enabled: bool,
    pub sort_order: i32,
}

impl RequestParam {
    pub fn new(request_id: String) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            request_id,
            key: String::new(),
            value: String::new(),
            description: String::new(),
            enabled: true,
            sort_order: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RequestHeader {
    pub id: String,
    pub request_id: String,
    pub key: String,
    pub value: String,
    pub description: String,
    pub enabled: bool,
    pub sort_order: i32,
}

impl RequestHeader {
    pub fn new(request_id: String) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            request_id,
            key: String::new(),
            value: String::new(),
            description: String::new(),
            enabled: true,
            sort_order: 0,
        }
    }
}
