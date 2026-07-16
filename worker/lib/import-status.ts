/**
 * Imported entries remain hidden until every expected attachment is linked to
 * a ready media row. Put this statement after media/link mutations in the same
 * D1 batch so publication cannot race the attachment commit.
 */
export function reconcileImportedEntryStatements(
  database: D1Database,
  entryId: string,
  generationId: string,
  now: string,
): D1PreparedStatement[] {
  return [
    database.prepare(`
      UPDATE entries SET
        status = CASE
          WHEN (
            SELECT COUNT(*)
            FROM entry_media
            JOIN media ON media.id = entry_media.media_id
            WHERE entry_media.entry_id = entries.id
              AND entry_media.import_generation_id = ?2
              AND media.status = 'ready'
          ) >= (
            SELECT expected_media_count
            FROM entry_import_generations
            WHERE entry_id = entries.id AND generation_id = ?2
          )
          AND EXISTS (
            SELECT 1 FROM entry_import_generations
            WHERE entry_id = entries.id AND generation_id = ?2
          )
          THEN 'published'
          ELSE 'partial-import'
        END,
        updated_at = ?3
      WHERE id = ?1 AND source = 'apple_journal' AND import_generation_id = ?2
    `).bind(entryId, generationId, now),
    database.prepare(`
      INSERT OR IGNORE INTO media_cleanup_queue (media_id, r2_key, requested_at)
      SELECT media.id, media.r2_key, ?3
      FROM entry_media
      JOIN media ON media.id = entry_media.media_id
      JOIN entries ON entries.id = entry_media.entry_id
      WHERE entry_media.entry_id = ?1
        AND entry_media.import_generation_id IS NOT ?2
        AND entries.import_generation_id = ?2
        AND entries.status = 'published'
        AND media.storage_kind = 'private_r2'
    `).bind(entryId, generationId, now),
    database.prepare(`
      DELETE FROM entry_media
      WHERE entry_id = ?1 AND import_generation_id IS NOT ?2
        AND EXISTS (
          SELECT 1 FROM entries
          WHERE id = ?1 AND import_generation_id = ?2 AND status = 'published'
        )
    `).bind(entryId, generationId),
  ];
}
