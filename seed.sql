PRAGMA foreign_keys = ON;

INSERT OR IGNORE INTO journals (
  id, name, icon, color, sort_order, created_at, updated_at
) VALUES (
  'journal-everyday', '日常', 'notebook-tabs', '#c8f169', 0,
  '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z'
);
