PRAGMA foreign_keys = ON;

INSERT OR IGNORE INTO journals (
  id, name, icon, color, sort_order, created_at, updated_at
) VALUES (
  'journal-everyday', '日常', 'notebook-tabs', '#2f6b59', 0,
  '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z'
);

INSERT OR IGNORE INTO entries (
  id, journal_id, source, title, excerpt, occurred_at, timezone, local_date,
  location_name, latitude, longitude, mood, is_favorite, layout_preset,
  layout_seed, word_count, status, created_at, updated_at
) VALUES
  (
    'entry-rain', 'journal-everyday', 'native', '雨把城市擦亮了',
    '離開捷運站時，雨剛好變得很大。街燈落在柏油路上，每一步都像踩進另一個城市。',
    '2026-07-15T00:16:00.000Z', 'Asia/Taipei', '2026-07-15',
    '臺北市松山區', 25.058044, 121.563172, 'calm', 1, 'film',
    17, 184, 'published', '2026-07-15T00:20:00.000Z', '2026-07-15T00:20:00.000Z'
  ),
  (
    'entry-coffee', 'journal-everyday', 'native', '把星期二留給自己',
    '沒有排會議的上午，慢慢寫完一頁筆記。原來安靜不是什麼都沒發生，而是終於聽見自己的速度。',
    '2026-07-14T02:40:00.000Z', 'Asia/Taipei', '2026-07-14',
    '家裡', NULL, NULL, 'focused', 0, 'letter',
    31, 337, 'published', '2026-07-14T03:18:00.000Z', '2026-07-14T03:18:00.000Z'
  ),
  (
    'entry-sunset', 'journal-everyday', 'native', '沿著海岸慢慢回家',
    '傍晚的雲很低，海面卻亮得像一條路。沒有趕著拍下什麼，只坐到天空把最後一點橘色收走。',
    '2026-07-13T10:12:00.000Z', 'Asia/Taipei', '2026-07-13',
    '桃園海岸', 25.117372, 121.238525, 'grateful', 1, 'auto',
    8, 421, 'published', '2026-07-13T12:04:00.000Z', '2026-07-13T12:04:00.000Z'
  ),
  (
    'entry-small-things', 'journal-everyday', 'native', '今天留下的五件小事',
    '冰箱裡還有昨天的西瓜。公車提早一分鐘到。讀完一本拖了很久的書。窗邊的植物長出新葉。晚上吹到一點涼風。',
    '2026-07-10T14:08:00.000Z', 'Asia/Taipei', '2026-07-10',
    NULL, NULL, NULL, 'content', 0, 'compact',
    44, 258, 'published', '2026-07-10T14:20:00.000Z', '2026-07-10T14:20:00.000Z'
  ),
  (
    'entry-late-train', 'journal-everyday', 'native', '末班車以前',
    '月台只剩風聲和遠處的廣播。今天沒有得到答案，但好像也不需要立刻有答案。',
    '2026-07-07T15:01:00.000Z', 'Asia/Taipei', '2026-07-07',
    '臺北車站', 25.047675, 121.517055, 'tired', 0, 'letter',
    72, 109, 'published', '2026-07-07T15:10:00.000Z', '2026-07-07T15:10:00.000Z'
  ),
  (
    'entry-july-list', 'journal-everyday', 'native', '七月想做的事',
    '去沒有去過的海邊。整理照片。少開幾次通知。做一頓需要慢慢等待的晚餐。把想說的話好好說完。',
    '2026-07-03T04:26:00.000Z', 'Asia/Taipei', '2026-07-03',
    NULL, NULL, NULL, 'hopeful', 0, 'contact-sheet',
    53, 196, 'published', '2026-07-03T04:35:00.000Z', '2026-07-03T04:35:00.000Z'
  ),
  (
    'entry-june', 'journal-everyday', 'native', '六月的最後一頁',
    '這個月比想像中忙，也比想像中完整。真正記得的不是完成多少事，而是那些願意停下來的時刻。',
    '2026-06-28T13:34:00.000Z', 'Asia/Taipei', '2026-06-28',
    NULL, NULL, NULL, 'reflective', 1, 'auto',
    91, 312, 'published', '2026-06-28T13:50:00.000Z', '2026-06-28T13:50:00.000Z'
  );

INSERT OR IGNORE INTO entry_blocks (
  id, entry_id, position, type, text_content, attrs_json, created_at, updated_at
) VALUES
  ('block-rain-1', 'entry-rain', 0, 'paragraph', '離開捷運站時，雨剛好變得很大。', '{}', '2026-07-15T00:20:00.000Z', '2026-07-15T00:20:00.000Z'),
  ('block-rain-2', 'entry-rain', 1, 'paragraph', '街燈落在柏油路上，每一步都像踩進另一個城市。', '{}', '2026-07-15T00:20:00.000Z', '2026-07-15T00:20:00.000Z'),
  ('block-coffee-1', 'entry-coffee', 0, 'paragraph', '沒有排會議的上午，慢慢寫完一頁筆記。', '{}', '2026-07-14T03:18:00.000Z', '2026-07-14T03:18:00.000Z'),
  ('block-coffee-2', 'entry-coffee', 1, 'quote', '安靜不是什麼都沒發生，而是終於聽見自己的速度。', '{}', '2026-07-14T03:18:00.000Z', '2026-07-14T03:18:00.000Z'),
  ('block-sunset-1', 'entry-sunset', 0, 'paragraph', '傍晚的雲很低，海面卻亮得像一條路。', '{}', '2026-07-13T12:04:00.000Z', '2026-07-13T12:04:00.000Z'),
  ('block-sunset-2', 'entry-sunset', 1, 'paragraph', '沒有趕著拍下什麼，只坐到天空把最後一點橘色收走。', '{}', '2026-07-13T12:04:00.000Z', '2026-07-13T12:04:00.000Z'),
  ('block-small-1', 'entry-small-things', 0, 'list', '冰箱裡還有昨天的西瓜。\n公車提早一分鐘到。\n讀完一本拖了很久的書。\n窗邊的植物長出新葉。\n晚上吹到一點涼風。', '{"style":"bullet"}', '2026-07-10T14:20:00.000Z', '2026-07-10T14:20:00.000Z'),
  ('block-train-1', 'entry-late-train', 0, 'paragraph', '月台只剩風聲和遠處的廣播。今天沒有得到答案，但好像也不需要立刻有答案。', '{}', '2026-07-07T15:10:00.000Z', '2026-07-07T15:10:00.000Z'),
  ('block-july-1', 'entry-july-list', 0, 'list', '去沒有去過的海邊。\n整理照片。\n少開幾次通知。\n做一頓需要慢慢等待的晚餐。\n把想說的話好好說完。', '{"style":"bullet"}', '2026-07-03T04:35:00.000Z', '2026-07-03T04:35:00.000Z'),
  ('block-june-1', 'entry-june', 0, 'paragraph', '這個月比想像中忙，也比想像中完整。真正記得的不是完成多少事，而是那些願意停下來的時刻。', '{}', '2026-06-28T13:50:00.000Z', '2026-06-28T13:50:00.000Z');

INSERT OR IGNORE INTO media (
  id, r2_key, storage_kind, sha256, type, mime_type, size_bytes, width, height,
  alt_text, status, created_at, updated_at
) VALUES
  (
    'media-rain', 'demo/taipei-rain.jpg', 'demo_asset',
    'demo-sha256-taipei-rain', 'photo', 'image/jpeg', 434684, 1200, 1600,
    '臺北雨夜街景', 'ready', '2026-07-15T00:20:00.000Z', '2026-07-15T00:20:00.000Z'
  ),
  (
    'media-coffee', 'demo/coffee-desk.jpg', 'demo_asset',
    'demo-sha256-coffee-desk', 'photo', 'image/jpeg', 129147, 1600, 1067,
    '桌上的筆記本、咖啡與電腦', 'ready', '2026-07-14T03:18:00.000Z', '2026-07-14T03:18:00.000Z'
  ),
  (
    'media-sunset', 'demo/taoyuan-sunset.jpg', 'demo_asset',
    'demo-sha256-taoyuan-sunset', 'photo', 'image/jpeg', 256287, 1600, 1058,
    '桃園海岸的夕陽', 'ready', '2026-07-13T12:04:00.000Z', '2026-07-13T12:04:00.000Z'
  );

INSERT OR IGNORE INTO entry_media (entry_id, media_id, position, placement, caption) VALUES
  ('entry-rain', 'media-rain', 0, 'cover', ''),
  ('entry-coffee', 'media-coffee', 0, 'grid', '留一點沒有行程的時間'),
  ('entry-sunset', 'media-sunset', 0, 'cover', '18:12，風從海面過來');

INSERT OR IGNORE INTO tags (id, name, color, created_at) VALUES
  ('tag-taipei', '臺北', '#466c7a', '2026-07-15T00:00:00.000Z'),
  ('tag-alone', '一個人', '#8d675a', '2026-07-15T00:00:00.000Z'),
  ('tag-sea', '海邊', '#3f7785', '2026-07-15T00:00:00.000Z'),
  ('tag-small', '小事', '#707c55', '2026-07-15T00:00:00.000Z');

INSERT OR IGNORE INTO entry_tags (entry_id, tag_id) VALUES
  ('entry-rain', 'tag-taipei'),
  ('entry-rain', 'tag-alone'),
  ('entry-coffee', 'tag-alone'),
  ('entry-sunset', 'tag-sea'),
  ('entry-small-things', 'tag-small'),
  ('entry-late-train', 'tag-taipei');

INSERT OR IGNORE INTO entry_search (entry_id, title, body)
SELECT
  entries.id,
  entries.title,
  COALESCE(GROUP_CONCAT(entry_blocks.text_content, ' '), entries.excerpt)
FROM entries
LEFT JOIN entry_blocks ON entry_blocks.entry_id = entries.id
WHERE entries.deleted_at IS NULL
GROUP BY entries.id;
