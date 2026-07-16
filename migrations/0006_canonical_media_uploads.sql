-- Forward repair for databases that already recorded the original 0003 schema.
-- Active imports must be drained before this migration; the guard fails closed.
PRAGMA foreign_keys = ON;

CREATE TABLE migration_0006_guard (
  active_upload_count INTEGER NOT NULL CHECK (active_upload_count = 0),
  partial_entry_count INTEGER NOT NULL CHECK (partial_entry_count = 0)
);

INSERT INTO migration_0006_guard (active_upload_count, partial_entry_count)
SELECT
  (SELECT COUNT(*) FROM media_uploads
    WHERE status NOT IN ('completed', 'failed', 'aborted')),
  (SELECT COUNT(*) FROM entries WHERE status = 'partial-import');

CREATE TABLE entry_import_generations (
  entry_id TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL,
  expected_media_count INTEGER NOT NULL
    CHECK (expected_media_count BETWEEN 0 AND 10000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
);

INSERT INTO entry_import_generations (
  entry_id, generation_id, expected_media_count, created_at, updated_at
)
SELECT
  entries.id,
  entries.import_generation_id,
  (
    SELECT COUNT(*) FROM entry_media
    WHERE entry_media.entry_id = entries.id
      AND entry_media.import_generation_id = entries.import_generation_id
  ),
  entries.updated_at,
  entries.updated_at
FROM entries
WHERE entries.source = 'apple_journal'
  AND entries.import_generation_id IS NOT NULL;

CREATE TABLE media_uploads_canonical (
  media_id TEXT PRIMARY KEY,
  import_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  entry_generation_id TEXT NOT NULL,
  owner_subject TEXT NOT NULL,
  source_path TEXT NOT NULL,
  upload_id TEXT NOT NULL UNIQUE,
  part_size INTEGER NOT NULL CHECK (part_size >= 5242880),
  part_count INTEGER NOT NULL CHECK (part_count BETWEEN 1 AND 10000),
  position INTEGER NOT NULL CHECK (position >= 0),
  placement TEXT NOT NULL CHECK (placement IN ('inline', 'grid', 'cover')),
  caption TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (
    status IN (
      'uploading', 'part_uploading', 'completing', 'aborting',
      'completed', 'failed', 'aborted'
    )
  ),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  next_part INTEGER NOT NULL DEFAULT 1 CHECK (next_part BETWEEN 1 AND 10001),
  active_part INTEGER CHECK (active_part BETWEEN 1 AND 10000),
  active_part_expires_at TEXT,
  state_expires_at TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE,
  FOREIGN KEY (import_id) REFERENCES imports(id) ON DELETE CASCADE,
  FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE,
  CHECK (
    (status = 'part_uploading' AND active_part IS NOT NULL AND active_part_expires_at IS NOT NULL)
    OR
    (status <> 'part_uploading' AND active_part IS NULL AND active_part_expires_at IS NULL)
  ),
  CHECK (
    (status IN ('completing', 'aborting') AND state_expires_at IS NOT NULL)
    OR
    (status NOT IN ('completing', 'aborting') AND state_expires_at IS NULL)
  )
);

INSERT INTO media_uploads_canonical (
  media_id, import_id, entry_id, entry_generation_id, owner_subject,
  source_path, upload_id, part_size, part_count, position, placement,
  caption, status, version, next_part, active_part, active_part_expires_at,
  state_expires_at, expires_at, created_at, updated_at
)
SELECT
  media_uploads.media_id,
  media_uploads.import_id,
  media_uploads.entry_id,
  COALESCE(
    media_uploads.entry_generation_id,
    entries.import_generation_id,
    'legacy:' || media_uploads.entry_id
  ),
  media_uploads.owner_subject,
  media_uploads.source_path,
  media_uploads.upload_id,
  media_uploads.part_size,
  media_uploads.part_count,
  media_uploads.position,
  media_uploads.placement,
  media_uploads.caption,
  media_uploads.status,
  0,
  1,
  NULL,
  NULL,
  NULL,
  media_uploads.expires_at,
  media_uploads.created_at,
  media_uploads.updated_at
FROM media_uploads
JOIN entries ON entries.id = media_uploads.entry_id;

DROP TABLE media_upload_parts;
DROP TABLE media_uploads;
ALTER TABLE media_uploads_canonical RENAME TO media_uploads;

CREATE INDEX media_uploads_import_status_idx
  ON media_uploads (owner_subject, import_id, status, expires_at);
CREATE INDEX media_uploads_entry_generation_idx
  ON media_uploads (entry_id, entry_generation_id, status);

CREATE TABLE media_upload_parts (
  media_id TEXT NOT NULL,
  part_number INTEGER NOT NULL CHECK (part_number BETWEEN 1 AND 10000),
  etag TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (media_id, part_number),
  FOREIGN KEY (media_id) REFERENCES media_uploads(media_id) ON DELETE CASCADE
);

DROP TABLE migration_0006_guard;
