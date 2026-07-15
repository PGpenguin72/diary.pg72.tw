PRAGMA foreign_keys = ON;

CREATE TABLE journals (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT 'book-open',
  color TEXT NOT NULL DEFAULT '#2f6b59',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO journals (
  id, name, icon, color, sort_order, created_at, updated_at
) VALUES (
  'journal-everyday', '日常', 'notebook-tabs', '#2f6b59', 0,
  '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z'
);

CREATE TABLE entries (
  id TEXT PRIMARY KEY,
  journal_id TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'native' CHECK (source IN ('native', 'apple_journal')),
  source_id TEXT,
  source_hash TEXT,
  title TEXT NOT NULL DEFAULT '',
  excerpt TEXT NOT NULL DEFAULT '',
  occurred_at TEXT NOT NULL,
  timezone TEXT NOT NULL,
  local_date TEXT NOT NULL,
  location_name TEXT,
  latitude REAL,
  longitude REAL,
  mood TEXT,
  is_favorite INTEGER NOT NULL DEFAULT 0 CHECK (is_favorite IN (0, 1)),
  layout_preset TEXT NOT NULL DEFAULT 'auto' CHECK (
    layout_preset IN ('auto', 'letter', 'film', 'contact-sheet', 'compact')
  ),
  layout_seed INTEGER NOT NULL DEFAULT 0,
  word_count INTEGER NOT NULL DEFAULT 0 CHECK (word_count >= 0),
  status TEXT NOT NULL DEFAULT 'published' CHECK (
    status IN ('draft', 'published', 'partial-import')
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY (journal_id) REFERENCES journals(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX idx_entries_source_id
  ON entries (source, source_id)
  WHERE source_id IS NOT NULL;

CREATE UNIQUE INDEX idx_entries_source_hash
  ON entries (source, source_hash)
  WHERE source_hash IS NOT NULL;

CREATE INDEX idx_entries_journal_occurred
  ON entries (journal_id, occurred_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_entries_local_date
  ON entries (local_date DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE entry_blocks (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  type TEXT NOT NULL CHECK (
    type IN ('paragraph', 'heading', 'quote', 'list', 'media', 'location', 'mood', 'link')
  ),
  text_content TEXT,
  attrs_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE,
  UNIQUE (entry_id, position)
);

CREATE INDEX idx_entry_blocks_entry_position
  ON entry_blocks (entry_id, position);

CREATE TABLE media (
  id TEXT PRIMARY KEY,
  r2_key TEXT NOT NULL UNIQUE,
  storage_kind TEXT NOT NULL DEFAULT 'private_r2' CHECK (
    storage_kind IN ('private_r2', 'demo_asset')
  ),
  sha256 TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('photo', 'video', 'audio', 'drawing')),
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  width INTEGER,
  height INTEGER,
  duration_ms INTEGER,
  alt_text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ready' CHECK (
    status IN ('pending', 'uploading', 'processing', 'ready', 'failed')
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE entry_media (
  entry_id TEXT NOT NULL,
  media_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  placement TEXT NOT NULL DEFAULT 'grid' CHECK (placement IN ('inline', 'grid', 'cover')),
  caption TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (entry_id, media_id),
  FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE,
  FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE RESTRICT
);

CREATE INDEX idx_entry_media_entry_position
  ON entry_media (entry_id, position);

CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  color TEXT NOT NULL DEFAULT '#6b766f',
  created_at TEXT NOT NULL
);

CREATE TABLE entry_tags (
  entry_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  PRIMARY KEY (entry_id, tag_id),
  FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

CREATE INDEX idx_entry_tags_tag_entry
  ON entry_tags (tag_id, entry_id);

CREATE TABLE imports (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('apple_journal')),
  file_name TEXT NOT NULL,
  file_fingerprint TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (
    status IN ('inspecting', 'uploading', 'processing', 'completed', 'completed-with-errors', 'failed')
  ),
  source_entry_count INTEGER,
  source_attachment_count INTEGER,
  inserted_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE import_items (
  id TEXT PRIMARY KEY,
  import_id TEXT NOT NULL,
  source_path TEXT NOT NULL,
  source_id TEXT,
  checksum TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('entry', 'media', 'metadata')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'duplicate', 'skipped', 'failed')),
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (import_id) REFERENCES imports(id) ON DELETE CASCADE,
  UNIQUE (import_id, source_path)
);

CREATE INDEX idx_import_items_import_status
  ON import_items (import_id, status);

CREATE VIRTUAL TABLE entry_search USING fts5(
  entry_id UNINDEXED,
  title,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);
