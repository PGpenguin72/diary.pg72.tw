/**
 * Imported entries remain hidden until every expected attachment is linked to
 * a ready media row. Put this statement after media/link mutations in the same
 * D1 batch so publication cannot race the attachment commit.
 */
export function reconcileImportedEntryStatement(
  database: D1Database,
  entryId: string,
  now: string,
): D1PreparedStatement {
  return database.prepare(`
    UPDATE entries SET
      status = CASE
        WHEN (
          SELECT COUNT(*)
          FROM entry_media
          JOIN media ON media.id = entry_media.media_id
          WHERE entry_media.entry_id = entries.id AND media.status = 'ready'
        ) >= expected_media_count
        THEN 'published'
        ELSE 'partial-import'
      END,
      updated_at = ?2
    WHERE id = ?1 AND source = 'apple_journal'
  `).bind(entryId, now);
}
