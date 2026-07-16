-- Scope imported media links and multipart uploads to one entry import attempt.
PRAGMA foreign_keys = ON;

ALTER TABLE entries ADD COLUMN import_generation_id TEXT;
ALTER TABLE entry_media ADD COLUMN import_generation_id TEXT;
ALTER TABLE media_uploads ADD COLUMN entry_generation_id TEXT;

-- Preserve already-published imports while moving future attempts to opaque UUIDs.
UPDATE entries
SET import_generation_id = 'legacy:' || id
WHERE source = 'apple_journal' AND import_generation_id IS NULL;

UPDATE entry_media
SET import_generation_id = (
  SELECT entries.import_generation_id
  FROM entries
  WHERE entries.id = entry_media.entry_id
)
WHERE EXISTS (
  SELECT 1 FROM entries
  WHERE entries.id = entry_media.entry_id AND entries.source = 'apple_journal'
);

UPDATE media_uploads
SET entry_generation_id = (
  SELECT entries.import_generation_id
  FROM entries
  WHERE entries.id = media_uploads.entry_id
)
WHERE entry_generation_id IS NULL;

CREATE INDEX idx_entry_media_generation_ready
  ON entry_media (entry_id, import_generation_id, media_id);

CREATE INDEX media_uploads_entry_generation_idx
  ON media_uploads (entry_id, entry_generation_id, status);
