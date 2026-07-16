-- Durable cleanup for media links superseded by a completed import generation.
PRAGMA foreign_keys = ON;

CREATE TABLE media_cleanup_queue (
  media_id TEXT PRIMARY KEY,
  r2_key TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error_at TEXT
);

CREATE INDEX media_cleanup_queue_requested_idx
  ON media_cleanup_queue (requested_at, media_id);
