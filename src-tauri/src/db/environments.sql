CREATE TABLE environments (
  id TEXT PRIMARY KEY NOT NULL,
  collection_id TEXT REFERENCES collections(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 200),
  variables_json TEXT NOT NULL CHECK(length(variables_json) <= 1048576),
  revision INTEGER NOT NULL CHECK(revision > 0)
);
CREATE UNIQUE INDEX environment_name ON environments(coalesce(collection_id, ''), name);
CREATE TABLE environment_selections (
  scope TEXT PRIMARY KEY NOT NULL,
  collection_id TEXT REFERENCES collections(id) ON DELETE CASCADE,
  environment_id TEXT REFERENCES environments(id) ON DELETE SET NULL,
  CHECK(scope = coalesce(collection_id, 'global'))
);
