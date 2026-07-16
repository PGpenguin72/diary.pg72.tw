-- Resumable private-R2 multipart uploads for Apple Journal media.
PRAGMA foreign_keys = ON;

ALTER TABLE media ADD COLUMN owner_subject TEXT;

CREATE INDEX media_owner_subject_idx ON media (owner_subject);

CREATE TABLE media_uploads (
  media_id TEXT PRIMARY KEY,
  import_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  owner_subject TEXT NOT NULL,
  source_path TEXT NOT NULL,
  upload_id TEXT NOT NULL UNIQUE,
  part_size INTEGER NOT NULL CHECK (part_size >= 5242880),
  part_count INTEGER NOT NULL CHECK (part_count BETWEEN 1 AND 10000),
  position INTEGER NOT NULL CHECK (position >= 0),
  placement TEXT NOT NULL CHECK (placement IN ('inline', 'grid', 'cover')),
  caption TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (
    status IN ('uploading', 'completing', 'completed', 'failed', 'aborted')
  ),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE,
  FOREIGN KEY (import_id) REFERENCES imports(id) ON DELETE CASCADE,
  FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
);

CREATE INDEX media_uploads_import_status_idx
  ON media_uploads (owner_subject, import_id, status, expires_at);

CREATE TABLE media_upload_parts (
  media_id TEXT NOT NULL,
  part_number INTEGER NOT NULL CHECK (part_number BETWEEN 1 AND 10000),
  etag TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (media_id, part_number),
  FOREIGN KEY (media_id) REFERENCES media_uploads(media_id) ON DELETE CASCADE
);
