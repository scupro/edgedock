-- Incremental search index: remember each row's parent directory so the nightly
-- rebuild can diff one directory at a time and only write rows that changed.
-- Existing rows keep parent = NULL; the next rebuild fills it in (or removes them).
ALTER TABLE file_index ADD COLUMN parent TEXT;
CREATE INDEX IF NOT EXISTS idx_file_index_parent ON file_index(storage_id, parent);
