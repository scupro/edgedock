-- Phase 2: per-part checksums for upload integrity
ALTER TABLE upload_parts ADD COLUMN checksum TEXT;
ALTER TABLE upload_sessions ADD COLUMN checksum TEXT;
