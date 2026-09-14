use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: &'static str,
    pub message: String,
}

pub type AppResult<T> = Result<T, AppError>;

impl AppError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new("INVALID_INPUT", message)
    }
    pub fn missing() -> Self {
        Self::new(
            "NOT_FOUND",
            "This item no longer exists. Refresh the workspace.",
        )
    }
    pub fn database() -> Self {
        Self::new("DATABASE_ERROR", "Local storage is unavailable or busy. Check free disk space and permissions, then retry.")
    }
}
impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for AppError {}
impl From<rusqlite::Error> for AppError {
    fn from(error: rusqlite::Error) -> Self {
        match error {
            rusqlite::Error::QueryReturnedNoRows => Self::missing(),
            rusqlite::Error::SqliteFailure(ref detail, _)
                if detail.code == rusqlite::ErrorCode::ConstraintViolation =>
            {
                Self::invalid(
                    "The item has invalid relationships or values. Refresh and try again.",
                )
            }
            _ => Self::database(),
        }
    }
}
