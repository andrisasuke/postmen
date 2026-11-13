CREATE TABLE last_executions (
  request_id TEXT PRIMARY KEY NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  execution_id TEXT NOT NULL,
  completed_at INTEGER NOT NULL CHECK(completed_at >= 0),
  result_json TEXT NOT NULL CHECK(length(CAST(result_json AS BLOB)) <= 16777216)
);
