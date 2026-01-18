use crate::models::*;

#[derive(Debug, Clone, PartialEq)]
pub struct Tab {
    pub id: String,
    pub request_id: String,
    pub name: String,
    pub method: HttpMethod,
    pub is_dirty: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ModalType {
    None,
    RenameProject { id: String, current_name: String },
    RenameRequest { id: String, current_name: String },
    HostnameUniverse,
    AddHostname,
    EditHostname { id: String, name: String, url: String },
    DeleteProject { id: String, name: String },
    DeleteRequest { id: String, name: String },
    DeleteHostname { id: String, name: String },
    UnsavedChanges { tab_index: usize, tab_name: String },
    ExitUnsavedChanges { tab_index: usize, tab_name: String, remaining_indices: Vec<usize> },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EditorTab {
    Params,
    Headers,
    Body,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResponseTab {
    Result,
    Headers,
}
