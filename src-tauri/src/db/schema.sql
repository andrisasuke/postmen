CREATE TABLE collections (
  id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 200),
  position INTEGER NOT NULL CHECK(position >= 0), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE folders (
  id TEXT PRIMARY KEY NOT NULL, collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  parent_id TEXT, name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 200), position INTEGER NOT NULL CHECK(position >= 0),
  UNIQUE(id, collection_id), CHECK(parent_id IS NULL OR parent_id != id),
  FOREIGN KEY(parent_id, collection_id) REFERENCES folders(id, collection_id) ON DELETE CASCADE
);
CREATE INDEX folder_parent ON folders(collection_id, parent_id, position);
CREATE TRIGGER prevent_folder_cycle BEFORE UPDATE OF parent_id ON folders WHEN NEW.parent_id IS NOT NULL BEGIN
  SELECT RAISE(ABORT, 'folder cycle') WHERE NEW.parent_id IN (
    WITH RECURSIVE descendants(id) AS (SELECT OLD.id UNION ALL SELECT f.id FROM folders f JOIN descendants d ON f.parent_id=d.id)
    SELECT id FROM descendants
  );
END;
CREATE TABLE requests (
  id TEXT PRIMARY KEY NOT NULL, collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE, folder_id TEXT,
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 200),
  method TEXT NOT NULL CHECK(method IN ('GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS')),
  url TEXT NOT NULL DEFAULT '',
  body_kind TEXT NOT NULL CHECK(body_kind IN ('none','json','multipart')), body TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL CHECK(position >= 0), revision INTEGER NOT NULL CHECK(revision > 0),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  FOREIGN KEY(folder_id, collection_id) REFERENCES folders(id, collection_id) ON DELETE CASCADE
);
CREATE INDEX request_parent ON requests(collection_id, folder_id, position);
CREATE TABLE request_params (
  id TEXT NOT NULL, request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), name TEXT NOT NULL, value TEXT NOT NULL, description TEXT NOT NULL,
  position INTEGER NOT NULL CHECK(position >= 0), PRIMARY KEY(request_id,id), UNIQUE(request_id,position)
);
CREATE TABLE request_headers (
  id TEXT NOT NULL, request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), name TEXT NOT NULL, value TEXT NOT NULL, description TEXT NOT NULL,
  position INTEGER NOT NULL CHECK(position >= 0), PRIMARY KEY(request_id,id), UNIQUE(request_id,position)
);
-- Only paths returned by the backend native picker enter this table. Vue gets opaque IDs, not a read-file capability.
CREATE TABLE attachments (id TEXT PRIMARY KEY NOT NULL, path TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL CHECK(size >= 0));
CREATE TABLE form_data_fields (
  id TEXT NOT NULL, request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('text','file')),
  value TEXT NOT NULL, attachment_id TEXT REFERENCES attachments(id) ON DELETE SET NULL, description TEXT NOT NULL,
  position INTEGER NOT NULL CHECK(position >= 0), PRIMARY KEY(request_id,id), UNIQUE(request_id,position)
);
-- Reserved for M3 execution history; no network/history writes in M2.
CREATE TABLE request_history (
  id TEXT PRIMARY KEY NOT NULL, request_id TEXT REFERENCES requests(id) ON DELETE SET NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('success','error','cancelled')), created_at INTEGER NOT NULL,
  summary_json TEXT NOT NULL CHECK(length(summary_json) <= 65536)
);
CREATE TABLE app_settings (key TEXT PRIMARY KEY NOT NULL, value_json TEXT NOT NULL CHECK(length(value_json) <= 262144));
