-- EdgeDock initial schema (Cloudflare D1 / SQLite)
-- All timestamps are Unix epoch milliseconds.

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  created_at INTEGER NOT NULL
);

-- Storage backends. `config` holds non-secret JSON; `secret` holds AES-GCM encrypted JSON.
CREATE TABLE IF NOT EXISTS storages (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  mount_path TEXT NOT NULL UNIQUE,
  config TEXT NOT NULL DEFAULT '{}',
  secret TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  permission TEXT NOT NULL CHECK (permission IN ('read', 'readwrite')),
  path_prefix TEXT NOT NULL DEFAULT '/',
  expires_at INTEGER,
  revoked_at INTEGER,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('markdown', 'text', 'file')),
  title TEXT,
  content TEXT,
  content_type TEXT,
  storage_path TEXT,
  password_hash TEXT,
  expires_at INTEGER,
  max_views INTEGER,
  views INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shares_expires ON shares(expires_at);

CREATE TABLE IF NOT EXISTS upload_sessions (
  id TEXT PRIMARY KEY,
  fingerprint TEXT,
  path TEXT NOT NULL,
  storage_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  size INTEGER NOT NULL,
  part_size INTEGER NOT NULL,
  total_parts INTEGER NOT NULL,
  content_type TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('native', 'emulated')),
  upstream_upload_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'aborted')),
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_upload_sessions_fp ON upload_sessions(fingerprint, status);
CREATE INDEX IF NOT EXISTS idx_upload_sessions_expires ON upload_sessions(expires_at);

CREATE TABLE IF NOT EXISTS upload_parts (
  session_id TEXT NOT NULL,
  part_number INTEGER NOT NULL,
  etag TEXT,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, part_number)
);

-- Filename search index (rebuilt by Workflow / cron)
CREATE TABLE IF NOT EXISTS file_index (
  storage_id TEXT NOT NULL,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  is_dir INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0,
  modified INTEGER,
  indexed_at INTEGER NOT NULL,
  PRIMARY KEY (storage_id, path)
);
CREATE INDEX IF NOT EXISTS idx_file_index_name ON file_index(name);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Storage-to-storage one-way sync jobs (run by Workflow / cron)
CREATE TABLE IF NOT EXISTS sync_jobs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source_path TEXT NOT NULL,
  target_path TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  overwrite INTEGER NOT NULL DEFAULT 0,
  last_run_at INTEGER,
  last_status TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS job_runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  ref TEXT,
  status TEXT NOT NULL,
  detail TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_job_runs_started ON job_runs(started_at);
