-- total file size of a Telegram/Discord multipart session, so a single-part upload keeps its own file name
ALTER TABLE blob_uploads ADD COLUMN size INTEGER;
