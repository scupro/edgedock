-- Phase 2 drivers: OAuth tokens, OAuth helper state, metadata for message-based storages (Telegram / Discord)

-- Access tokens (and rotated refresh tokens) per storage, AES-GCM encrypted with ENCRYPTION_KEY.
CREATE TABLE IF NOT EXISTS oauth_tokens (
  storage_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  access_token TEXT,
  refresh_token TEXT,
  expires_at INTEGER,
  updated_at INTEGER NOT NULL
);

-- Pending admin-UI OAuth flows (state + PKCE verifier); rows older than 15 minutes are ignored.
CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  storage_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  verifier TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Directory tree + part list of files stored as chat messages / attachments.
CREATE TABLE IF NOT EXISTS blob_entries (
  storage_id TEXT NOT NULL,
  path TEXT NOT NULL,
  parent TEXT NOT NULL,
  name TEXT NOT NULL,
  is_dir INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0,
  content_type TEXT,
  -- JSON array of provider part references [{ "size": n, ... }]
  parts TEXT,
  modified INTEGER NOT NULL,
  PRIMARY KEY (storage_id, path)
);
CREATE INDEX IF NOT EXISTS idx_blob_entries_parent ON blob_entries(storage_id, parent);

-- Native multipart sessions of message-based storages: uploaded parts before the file entry exists.
CREATE TABLE IF NOT EXISTS blob_uploads (
  upload_id TEXT PRIMARY KEY,
  storage_id TEXT NOT NULL,
  path TEXT NOT NULL,
  content_type TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS blob_upload_parts (
  upload_id TEXT NOT NULL,
  part_number INTEGER NOT NULL,
  refs TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (upload_id, part_number)
);
