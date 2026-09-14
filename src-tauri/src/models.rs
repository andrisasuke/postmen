use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Collection {
    pub id: String,
    pub name: String,
    pub position: i64,
    pub created_at: i64,
    pub updated_at: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Folder {
    pub id: String,
    pub collection_id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub position: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Environment {
    pub id: String,
    pub collection_id: Option<String>,
    pub name: String,
    pub variables: Vec<KeyValue>,
    pub revision: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnvironmentSelection {
    pub collection_id: Option<String>,
    pub environment_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KeyValue {
    pub id: String,
    pub enabled: bool,
    pub name: String,
    pub value: String,
    pub description: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FormField {
    pub id: String,
    pub enabled: bool,
    pub name: String,
    pub kind: String,
    pub value: String,
    pub attachment_id: Option<String>,
    pub description: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Attachment {
    pub id: String,
    pub name: String,
    pub size: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestDoc {
    pub id: String,
    pub collection_id: String,
    pub folder_id: Option<String>,
    pub name: String,
    pub method: String,
    pub url: String,
    pub body_kind: String,
    pub body: String,
    pub params: Vec<KeyValue>,
    pub headers: Vec<KeyValue>,
    pub form_data: Vec<FormField>,
    pub position: i64,
    pub revision: i64,
    pub created_at: i64,
    pub updated_at: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestSummary {
    pub id: String,
    pub collection_id: String,
    pub folder_id: Option<String>,
    pub name: String,
    pub method: String,
    pub position: i64,
    pub revision: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PaneView {
    pub orientation: String,
    pub request_width: Option<f64>,
    pub request_height: f64,
    pub request_collapsed: bool,
    pub response_collapsed: bool,
}
impl Default for PaneView {
    fn default() -> Self {
        Self {
            orientation: "horizontal".into(),
            request_width: None,
            request_height: 380.0,
            request_collapsed: false,
            response_collapsed: false,
        }
    }
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditorSelection {
    pub anchor: u32,
    pub head: u32,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScrollPosition {
    pub top: f64,
    pub left: f64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestView {
    pub section: String,
    pub selection: EditorSelection,
    pub scroll: ScrollPosition,
    pub pane: PaneView,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Session {
    pub tab_ids: Vec<String>,
    pub active_id: Option<String>,
    pub views: BTreeMap<String, RequestView>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub attachments: Vec<Attachment>,
    pub collections: Vec<Collection>,
    pub folders: Vec<Folder>,
    pub requests: Vec<RequestSummary>,
    pub environments: Vec<Environment>,
    pub environment_selections: Vec<EnvironmentSelection>,
    pub session: Session,
    pub warnings: Vec<String>,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateCollection {
    pub name: String,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rename {
    pub id: String,
    pub name: String,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateFolder {
    pub collection_id: String,
    pub parent_id: Option<String>,
    pub name: String,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateFolder {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateRequest {
    pub collection_id: String,
    pub folder_id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub content: Option<NewRequestContent>,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NewRequestContent {
    pub method: String,
    pub url: String,
    pub body_kind: String,
    pub body: String,
    pub params: Vec<KeyValue>,
    pub headers: Vec<KeyValue>,
    pub form_data: Vec<FormField>,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveEnvironment {
    pub id: Option<String>,
    pub collection_id: Option<String>,
    pub name: String,
    pub variables: Vec<KeyValue>,
    pub revision: Option<i64>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TreeRef {
    pub kind: String,
    pub id: String,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Reorder {
    pub collection_id: Option<String>,
    pub parent_id: Option<String>,
    pub items: Vec<TreeRef>,
}
