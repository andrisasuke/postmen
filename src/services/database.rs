use crate::models::*;
use rusqlite::{Connection, Result, params};
use std::sync::Mutex;

pub struct Database {
    conn: Mutex<Connection>,
}

impl Database {
    pub fn new() -> Result<Self> {
        let db_path = dirs::home_dir()
            .expect("Could not find home directory")
            .join(".postmen")
            .join("postmen.db");

        // Create directory if it doesn't exist
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent).ok();
        }

        let conn = Connection::open(&db_path)?;
        let db = Self {
            conn: Mutex::new(conn),
        };
        db.init_tables()?;
        db.seed_data()?;
        Ok(db)
    }

    fn init_tables(&self) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                sort_order INTEGER DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS requests (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                name TEXT NOT NULL,
                method TEXT NOT NULL CHECK(method IN ('GET', 'POST', 'PUT', 'DELETE', 'OPTIONS')),
                path TEXT NOT NULL DEFAULT '',
                hostname_id TEXT,
                body TEXT DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                sort_order INTEGER DEFAULT 0,
                FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
                FOREIGN KEY (hostname_id) REFERENCES hostnames(id) ON DELETE SET NULL
            );

            CREATE TABLE IF NOT EXISTS request_params (
                id TEXT PRIMARY KEY,
                request_id TEXT NOT NULL,
                key TEXT NOT NULL,
                value TEXT NOT NULL DEFAULT '',
                description TEXT DEFAULT '',
                enabled INTEGER DEFAULT 1,
                sort_order INTEGER DEFAULT 0,
                FOREIGN KEY (request_id) REFERENCES requests(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS request_headers (
                id TEXT PRIMARY KEY,
                request_id TEXT NOT NULL,
                key TEXT NOT NULL,
                value TEXT NOT NULL DEFAULT '',
                description TEXT DEFAULT '',
                enabled INTEGER DEFAULT 1,
                sort_order INTEGER DEFAULT 0,
                FOREIGN KEY (request_id) REFERENCES requests(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS form_data_fields (
                id TEXT PRIMARY KEY,
                request_id TEXT NOT NULL,
                key TEXT NOT NULL,
                value TEXT NOT NULL DEFAULT '',
                description TEXT DEFAULT '',
                field_type TEXT NOT NULL DEFAULT 'Text' CHECK(field_type IN ('Text', 'File')),
                enabled INTEGER DEFAULT 1,
                sort_order INTEGER DEFAULT 0,
                FOREIGN KEY (request_id) REFERENCES requests(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS hostnames (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                url TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                sort_order INTEGER DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS request_history (
                id TEXT PRIMARY KEY,
                request_id TEXT,
                method TEXT NOT NULL,
                url TEXT NOT NULL,
                headers TEXT NOT NULL,
                body TEXT DEFAULT '',
                response_status INTEGER,
                response_time_ms INTEGER,
                response_size_bytes INTEGER,
                response_headers TEXT,
                response_body TEXT,
                sent_at TEXT NOT NULL,
                FOREIGN KEY (request_id) REFERENCES requests(id) ON DELETE SET NULL
            );

            CREATE TABLE IF NOT EXISTS open_tabs (
                id TEXT PRIMARY KEY,
                request_id TEXT NOT NULL,
                sort_order INTEGER DEFAULT 0,
                FOREIGN KEY (request_id) REFERENCES requests(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS app_state (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            "#,
        )?;

        // Migration: Add description column to request_headers if it doesn't exist
        let _ = conn.execute(
            "ALTER TABLE request_headers ADD COLUMN description TEXT DEFAULT ''",
            [],
        );

        // Migration: Add body_type column to requests if it doesn't exist
        let _ = conn.execute(
            "ALTER TABLE requests ADD COLUMN body_type TEXT DEFAULT 'Json'",
            [],
        );

        // Migration: Add description column to form_data_fields if it doesn't exist
        let _ = conn.execute(
            "ALTER TABLE form_data_fields ADD COLUMN description TEXT DEFAULT ''",
            [],
        );

        Ok(())
    }

    fn seed_data(&self) -> Result<()> {
        let conn = self.conn.lock().unwrap();

        // Check if hostnames exist
        let count: i32 = conn.query_row(
            "SELECT COUNT(*) FROM hostnames",
            [],
            |row| row.get(0),
        )?;

        if count == 0 {
            let now = chrono::Utc::now().to_rfc3339();
            conn.execute(
                "INSERT INTO hostnames (id, name, url, created_at, updated_at, sort_order) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params!["host-dev", "Development", "http://localhost:3000", &now, &now, 0],
            )?;
            conn.execute(
                "INSERT INTO hostnames (id, name, url, created_at, updated_at, sort_order) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params!["host-prod", "Production", "https://api.example.com", &now, &now, 1],
            )?;
            conn.execute(
                "INSERT INTO hostnames (id, name, url, created_at, updated_at, sort_order) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params!["host-staging", "Staging", "https://staging.api.example.com", &now, &now, 2],
            )?;
        }

        Ok(())
    }

    // ===== PROJECTS =====
    pub fn get_all_projects(&self) -> Result<Vec<Project>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, created_at, updated_at, sort_order FROM projects ORDER BY sort_order"
        )?;
        let projects = stmt.query_map([], |row| {
            Ok(Project {
                id: row.get(0)?,
                name: row.get(1)?,
                created_at: row.get(2)?,
                updated_at: row.get(3)?,
                sort_order: row.get(4)?,
                is_expanded: true,
            })
        })?;
        projects.collect()
    }

    pub fn create_project(&self, project: &Project) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO projects (id, name, created_at, updated_at, sort_order) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![project.id, project.name, project.created_at, project.updated_at, project.sort_order],
        )?;
        Ok(())
    }

    pub fn update_project(&self, project: &Project) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE projects SET name = ?1, updated_at = ?2, sort_order = ?3 WHERE id = ?4",
            params![project.name, now, project.sort_order, project.id],
        )?;
        Ok(())
    }

    pub fn delete_project(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM projects WHERE id = ?1", params![id])?;
        Ok(())
    }

    // ===== REQUESTS =====
    pub fn get_requests_by_project(&self, project_id: &str) -> Result<Vec<Request>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, project_id, name, method, path, hostname_id, body, created_at, updated_at, sort_order, body_type
             FROM requests WHERE project_id = ?1 ORDER BY sort_order"
        )?;
        let requests = stmt.query_map([project_id], |row| {
            let body_type_str: String = row.get::<_, Option<String>>(10)?.unwrap_or_else(|| "Json".to_string());
            Ok(Request {
                id: row.get(0)?,
                project_id: row.get(1)?,
                name: row.get(2)?,
                method: HttpMethod::from_str(&row.get::<_, String>(3)?),
                path: row.get(4)?,
                hostname_id: row.get(5)?,
                body: row.get(6)?,
                body_type: BodyType::from_str(&body_type_str),
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
                sort_order: row.get(9)?,
                params: Vec::new(),
                headers: Vec::new(),
                form_data: Vec::new(),
            })
        })?;
        requests.collect()
    }

    pub fn get_request_by_id(&self, id: &str) -> Result<Option<Request>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, project_id, name, method, path, hostname_id, body, created_at, updated_at, sort_order, body_type
             FROM requests WHERE id = ?1"
        )?;
        let mut rows = stmt.query([id])?;

        if let Some(row) = rows.next()? {
            let body_type_str: String = row.get::<_, Option<String>>(10)?.unwrap_or_else(|| "Json".to_string());
            let mut request = Request {
                id: row.get(0)?,
                project_id: row.get(1)?,
                name: row.get(2)?,
                method: HttpMethod::from_str(&row.get::<_, String>(3)?),
                path: row.get(4)?,
                hostname_id: row.get(5)?,
                body: row.get(6)?,
                body_type: BodyType::from_str(&body_type_str),
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
                sort_order: row.get(9)?,
                params: Vec::new(),
                headers: Vec::new(),
                form_data: Vec::new(),
            };
            drop(rows);
            drop(stmt);
            drop(conn);

            request.params = self.get_request_params(&request.id)?;
            request.headers = self.get_request_headers(&request.id)?;
            request.form_data = self.get_form_data_fields(&request.id)?;

            Ok(Some(request))
        } else {
            Ok(None)
        }
    }

    pub fn create_request(&self, request: &Request) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO requests (id, project_id, name, method, path, hostname_id, body, body_type, created_at, updated_at, sort_order)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                request.id,
                request.project_id,
                request.name,
                request.method.as_str(),
                request.path,
                request.hostname_id,
                request.body,
                request.body_type.db_value(),
                request.created_at,
                request.updated_at,
                request.sort_order
            ],
        )?;
        Ok(())
    }

    pub fn update_request(&self, request: &Request) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE requests SET name = ?1, method = ?2, path = ?3, hostname_id = ?4, body = ?5, body_type = ?6, updated_at = ?7, sort_order = ?8 WHERE id = ?9",
            params![
                request.name,
                request.method.as_str(),
                request.path,
                request.hostname_id,
                request.body,
                request.body_type.db_value(),
                now,
                request.sort_order,
                request.id
            ],
        )?;
        Ok(())
    }

    pub fn delete_request(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM requests WHERE id = ?1", params![id])?;
        Ok(())
    }

    // ===== REQUEST PARAMS =====
    pub fn get_request_params(&self, request_id: &str) -> Result<Vec<RequestParam>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, request_id, key, value, description, enabled, sort_order
             FROM request_params WHERE request_id = ?1 ORDER BY sort_order"
        )?;
        let params = stmt.query_map([request_id], |row| {
            Ok(RequestParam {
                id: row.get(0)?,
                request_id: row.get(1)?,
                key: row.get(2)?,
                value: row.get(3)?,
                description: row.get(4)?,
                enabled: row.get::<_, i32>(5)? == 1,
                sort_order: row.get(6)?,
            })
        })?;
        params.collect()
    }

    pub fn save_request_params(&self, request_id: &str, params: &[RequestParam]) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM request_params WHERE request_id = ?1", params![request_id])?;

        for param in params {
            conn.execute(
                "INSERT INTO request_params (id, request_id, key, value, description, enabled, sort_order)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    param.id,
                    request_id,
                    param.key,
                    param.value,
                    param.description,
                    if param.enabled { 1 } else { 0 },
                    param.sort_order
                ],
            )?;
        }
        Ok(())
    }

    // ===== REQUEST HEADERS =====
    pub fn get_request_headers(&self, request_id: &str) -> Result<Vec<RequestHeader>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, request_id, key, value, description, enabled, sort_order
             FROM request_headers WHERE request_id = ?1 ORDER BY sort_order"
        )?;
        let headers = stmt.query_map([request_id], |row| {
            Ok(RequestHeader {
                id: row.get(0)?,
                request_id: row.get(1)?,
                key: row.get(2)?,
                value: row.get(3)?,
                description: row.get(4)?,
                enabled: row.get::<_, i32>(5)? == 1,
                sort_order: row.get(6)?,
            })
        })?;
        headers.collect()
    }

    pub fn save_request_headers(&self, request_id: &str, headers: &[RequestHeader]) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM request_headers WHERE request_id = ?1", params![request_id])?;

        for header in headers {
            conn.execute(
                "INSERT INTO request_headers (id, request_id, key, value, description, enabled, sort_order)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    header.id,
                    request_id,
                    header.key,
                    header.value,
                    header.description,
                    if header.enabled { 1 } else { 0 },
                    header.sort_order
                ],
            )?;
        }
        Ok(())
    }

    // ===== FORM DATA FIELDS =====
    pub fn get_form_data_fields(&self, request_id: &str) -> Result<Vec<FormDataField>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, request_id, key, value, description, field_type, enabled, sort_order
             FROM form_data_fields WHERE request_id = ?1 ORDER BY sort_order"
        )?;
        let fields = stmt.query_map([request_id], |row| {
            let field_type_str: String = row.get(5)?;
            Ok(FormDataField {
                id: row.get(0)?,
                request_id: row.get(1)?,
                key: row.get(2)?,
                value: row.get(3)?,
                description: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                field_type: if field_type_str == "File" { FormFieldType::File } else { FormFieldType::Text },
                enabled: row.get::<_, i32>(6)? == 1,
                sort_order: row.get(7)?,
            })
        })?;
        fields.collect()
    }

    pub fn save_form_data_fields(&self, request_id: &str, fields: &[FormDataField]) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM form_data_fields WHERE request_id = ?1", params![request_id])?;

        for field in fields {
            let field_type_str = match field.field_type {
                FormFieldType::Text => "Text",
                FormFieldType::File => "File",
            };
            conn.execute(
                "INSERT INTO form_data_fields (id, request_id, key, value, description, field_type, enabled, sort_order)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    field.id,
                    request_id,
                    field.key,
                    field.value,
                    field.description,
                    field_type_str,
                    if field.enabled { 1 } else { 0 },
                    field.sort_order
                ],
            )?;
        }
        Ok(())
    }

    // ===== HOSTNAMES =====
    pub fn get_all_hostnames(&self) -> Result<Vec<Hostname>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, url, created_at, updated_at, sort_order FROM hostnames ORDER BY sort_order"
        )?;
        let hostnames = stmt.query_map([], |row| {
            Ok(Hostname {
                id: row.get(0)?,
                name: row.get(1)?,
                url: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
                sort_order: row.get(5)?,
            })
        })?;
        hostnames.collect()
    }

    pub fn create_hostname(&self, hostname: &Hostname) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO hostnames (id, name, url, created_at, updated_at, sort_order) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![hostname.id, hostname.name, hostname.url, hostname.created_at, hostname.updated_at, hostname.sort_order],
        )?;
        Ok(())
    }

    pub fn update_hostname(&self, hostname: &Hostname) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE hostnames SET name = ?1, url = ?2, updated_at = ?3, sort_order = ?4 WHERE id = ?5",
            params![hostname.name, hostname.url, now, hostname.sort_order, hostname.id],
        )?;
        Ok(())
    }

    pub fn delete_hostname(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM hostnames WHERE id = ?1", params![id])?;
        Ok(())
    }

    // ===== HISTORY =====
    pub fn save_history(&self, history: &RequestHistory) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO request_history (id, request_id, method, url, headers, body, response_status, response_time_ms, response_size_bytes, response_headers, response_body, sent_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                history.id,
                history.request_id,
                history.method,
                history.url,
                history.headers,
                history.body,
                history.response_status,
                history.response_time_ms.map(|v| v as i64),
                history.response_size_bytes.map(|v| v as i64),
                history.response_headers,
                history.response_body,
                history.sent_at
            ],
        )?;
        Ok(())
    }

    // ===== OPEN TABS =====
    pub fn get_open_tabs(&self) -> Result<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT request_id FROM open_tabs ORDER BY sort_order"
        )?;
        let request_ids = stmt.query_map([], |row| {
            row.get(0)
        })?;
        request_ids.collect()
    }

    pub fn save_open_tabs(&self, request_ids: &[String]) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM open_tabs", [])?;

        for (idx, request_id) in request_ids.iter().enumerate() {
            let id = uuid::Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO open_tabs (id, request_id, sort_order) VALUES (?1, ?2, ?3)",
                params![id, request_id, idx as i32],
            )?;
        }
        Ok(())
    }

    pub fn get_active_tab_index(&self) -> Result<Option<usize>> {
        let conn = self.conn.lock().unwrap();
        let result: Result<String, _> = conn.query_row(
            "SELECT value FROM app_state WHERE key = 'active_tab_index'",
            [],
            |row| row.get(0),
        );
        match result {
            Ok(value) => Ok(value.parse().ok()),
            Err(_) => Ok(None),
        }
    }

    pub fn save_active_tab_index(&self, index: usize) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO app_state (key, value) VALUES ('active_tab_index', ?1)",
            params![index.to_string()],
        )?;
        Ok(())
    }
}
