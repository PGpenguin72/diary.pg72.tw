/**
 * Imported entries remain hidden until every expected attachment is linked to
 * a ready media row. Put this statement after media/link mutations in the same
 * D1 batch so publication cannot race the attachment commit.
 */
export function reconcileImportedEntryStatement(
  database: D1Database,
  entryId: string,
  generationId: string,
  now: string,
): D1PreparedStatement {
  return database.prepare(`
    UPDATE entries SET
      status = CASE
        WHEN (
          SELECT COUNT(*)
          FROM entry_media
          JOIN media ON media.id = entry_media.media_id
          WHERE entry_media.entry_id = entries.id
            AND entry_media.import_generation_id = ?2
            AND media.status = 'ready'
        ) >= expected_media_count
        THEN 'published'
        ELSE 'partial-import'
      END,
      updated_at = ?3
    WHERE id = ?1 AND source = 'apple_journal' AND import_generation_id = ?2
  `).bind(entryId, generationId, now);
}
