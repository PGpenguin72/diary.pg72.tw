# PG72 Diary Handoff

> 最後核對：2026-07-17（Asia/Taipei）
> Branch：`fix/diary-import-media-20260717`
> 實作基線：`16c53d3 fix: bound diary import reconciliation` 之後；本文件所在 commit 請以 `git log -1` 為準
> Repository：`https://github.com/PGpenguin72/diary.pg72.tw.git`

這份文件記錄目前可直接接手的實作狀態。產品與架構決策仍以 `README.md` 為準，coding agent 的強制規則在 `AGENT.md`；開始修改前必須先讀完兩份文件，並再次檢查 git、D1、R2 與測試狀態。

## 目前狀態摘要

- 已有可運行的 React + Vite + Hono + Cloudflare Workers full-stack app。
- 本機站目前可由 `http://127.0.0.1:5173/` 開啟。
- Overview、時間軸、日曆、地點、Insights、搜尋、日記詳情、新增文字日記與 Apple Journal ZIP 匯入已有可操作流程。
- Apple Journal 匯入器已用使用者目前的真實匯出格式驗證過；真實資料只能留在被 git ignore 的本機環境，不得成為 fixture、log、screenshot 或 commit。
- GitHub 目前只有 `CI` workflow，最新 `main` run 已成功：<https://github.com/PGpenguin72/diary.pg72.tw/actions/runs/29409349057>。
- Cloudflare 遠端 R2 bucket `diary-pg72-tw-media` 已建立且目前為空；遠端 D1 `diary-pg72-tw-db` 和 Worker `diary-pg72-tw` 尚未建立。
- `diary.pg72.tw` 目前沒有 DNS record，因此沒有 production 網站，也尚未完成 GitHub push 後自動部署。
- 隱私模型是「公開唯讀、私人寫入」（使用者 2026-07-16 明確確認）：讀取路由公開，所有 mutation 需 PG72 ID（`sso.pg72.tw`，自建 OIDC IdP）登入——Worker server-side 驗證 code + PKCE 與 EdDSA ID token 後建立 D1 session，僅允許 `AUTH_ALLOWED_SUBJECT` 設定的擁有者 `sub`。不得以 hostname、前端狀態、自訂 header 或 email 欄位繞過；唯一豁免是 localhost 開發 bypass。詳見下方「登入與授權」。

## 本機私密資料狀態

2026-07-15 最後一次只讀核對時，日常本機 D1（`.wrangler/state/v3/d1`）不是空的：

| 資料 | 數量 |
| --- | ---: |
| journals | 1 |
| entries | 17 |
| entry_blocks | 17 |
| media / entry_media | 81 / 81 |
| imports | 1 |
| import_items | 98 |

該 import job 狀態為 `completed`：17 篇寫入、81 個附件、0 skipped、0 failed。Overview 聚合為 14 個日記日、70 張照片、11 部影片、0 段錄音。這很可能就是使用者的真實 Apple Journal 內容：

- 不得在一般測試、seed 或 migration 中讀取、複製、改名或刪除。
- 不得在回覆、log、測試報告或 screenshot 中暴露標題、正文、原始檔名、位置或媒體。
- 原始匯出資料夾是 repository root 的 `/apple journal/`，已由 `.gitignore` 排除；不要 commit 或移動它。
- E2E 使用獨立的 `.wrangler/e2e-state`，`pnpm run test:e2e` 會先重建該 state，不應碰日常本機資料。
- 若任務涉及清空、重匯、migration 或資料修復，先做明確的 scope 核對與可復原備份，不要假設本機資料可丟棄。

目前已知的真實 archive 外型（只保留統計，不要把來源內容寫進 repo）：17 個 HTML entry、70 張照片、11 部影片，總附件約 598.1 MB；最大 MOV 約 157.4 MB。部分副檔名或 declared MIME 與實際 magic signature 不一致，並含 `__MACOSX` / AppleDouble metadata。

## 已完成的使用者體驗

### 列表與時間軸

- 所有日記卡片只顯示日期、標題、摘要與 metadata。
- 卡片不可顯示照片、影片、錄音、封面、輪播或任何媒體預覽。這是使用者最後確認的需求，不是待辦。
- 時間軸使用有序 Grid masonry：桌面 3 欄、`<=1180px` 2 欄、手機 1 欄。
- `ResizeObserver` 量測卡片實際高度，以 CSS grid row span 和明確 column/row start 讓各欄向上貼齊；DOM 與語意順序仍保持時間排序。
- 不得改用 CSS columns，否則視覺順序、鍵盤順序與閱讀順序會錯位。

主要檔案：

- `src/components/EntryCard.tsx`
- `src/components/TimelineMasonry.tsx`
- `src/components/TimelineMasonryItem.tsx`
- `src/styles.css`

### 日記詳情與媒體

- 詳情視窗由 `src/App.tsx` lazy-load。
- 正文支援 Markdown / GFM，使用鎖定版本 `react-markdown@10.1.0` 與 `remark-gfm@4.0.1`。
- 支援段落、標題、粗體、斜體、刪除線、引用、清單、連結、表格、task list 與 code。
- 照片、影片、錄音只能出現在正文最下方；正文中間與外層卡片都不放媒體預覽。
- 圖片與影片依原始比例排成有序 Grid masonry，寬度由欄位決定，高度維持原比例，因此會形成自然的不規則底邊。
- 相簿不可用 CSS columns；原始附件順序必須保留。錄音排在視覺相簿之後。
- 圖片可點擊打開全螢幕 lightbox，支援前後切換、Escape 關閉與行動版操作。

主要檔案：

- `src/components/EntryDetailDialog.tsx`
- `src/components/EntryMarkdown.tsx`
- `src/components/EntryMedia.tsx`
- `src/components/MasonryMediaItem.tsx`
- `src/components/MediaLightbox.tsx`

### Apple Journal 匯入

- 瀏覽器用 zip.js random access 逐項讀取 ZIP，不上傳或一次解壓整包 archive。
- 支援目前已知的 `Entries/*.html` + `Resources/` 匯出結構。
- 忽略 `__MACOSX`、AppleDouble 與 Finder metadata。
- 媒體會做 magic-signature sniffing，不直接相信副檔名或 declared MIME。
- entry 逐篇 D1 upsert；zip.js 以 backpressure 串流解壓、瀏覽器只保留目前的 8 MiB part，再由 Worker 的 owner-bound R2 multipart session 寫入 private R2。
- 依 archive fingerprint、source path、canonical content hash 與媒體 fingerprint 去重；同一 ZIP 可重新選取並安全重跑。
- D1 `media_uploads` / `media_upload_parts` 保存 upload session、part 順序與 opaque ETag；每段重試三次，中斷後可續傳，取消會 abort，failed row 可恢復而不再假裝成 duplicate。
- part/complete/abort 都攜帶 generation，並在 D1 reservation / commit 同時比對 upload ID、upload row generation/version/state 與 entry current generation；每個 R2 await 後的 commit、failure release 與 terminal transition 都檢查 `meta.changes`，期間切換 generation 固定回 409，不能碰 replacement upload 或寫入成功報告。各動作再以 version、next part 與短 lease 做 CAS；hard crash 可重寫同一 part，R2 已 complete 但 D1 未 finalize 時可由 object head reconciliation。每次 entry attempt 都有 generation ID；零附件 entry 在建立 batch 內立即 publish，舊 ready link 不能滿足新 expected count，含附件 entry 在 current generation 全部 ready 前維持非公開 `partial-import`。
- 每日 scheduled cleanup 分批回收過期 session，保護 active lease、先修復 R2-success / D1-pending，再 abort；terminal bookkeeping 保留 7 天。新 generation publish 後的 stale link，以及 exact current-generation completion 所留下的錯誤大小 object，會進 durable cleanup queue；只有 D1 零引用且沒有 active upload 的 media 才先刪 row、再冪等刪 R2，共用媒體與 replacement upload 不刪。
- import job 與 import item 會記錄進度；UI 顯示整體 item 與目前檔案 byte/part 進度。entry 建立失敗會把每個未嘗試附件逐項記為 skipped；JSON report 保留完整 bounded source path / fingerprint reconciliation identity，並允許重跑同一 ZIP。
- parser 對單次 preview 設 10,000 entries、50,000 reconciliation items、32 MiB HTML 與 32 MiB retained text 上限；單一路徑 1,024 bytes、path metadata 合計 8 MiB，central-directory fingerprint 只取 bounded path。損壞 ZIP 和不安全/過長路徑有 desktop/mobile regression。

主要檔案：

- `src/components/ImportDialog.tsx`
- `src/lib/apple-journal.ts`
- `worker/routes/imports.ts`
- `worker/routes/import-media-uploads.ts`
- `shared/schemas.ts`
- `migrations/0001_initial.sql`
- `migrations/0003_media_uploads.sql`
- `migrations/0004_import_generations.sql`
- `migrations/0005_media_cleanup_queue.sql`
- `migrations/0006_canonical_media_uploads.sql`

## 登入與授權（PG72 ID OIDC）

- IdP 是使用者自建的 PG72 ID（repo `~/sso.pg72.tw`，已上線於 `https://sso.pg72.tw`）。整合規範以該 repo 的 `codex.md` §10–§11 為準。
- 已註冊兩個 client（seed：`~/sso.pg72.tw/apps/sso/seed/diary-clients.sql`）：
  - `pg72-diary`：production 機密 client，`client_secret_basic` + PKCE，redirect `https://diary.pg72.tw/api/auth/callback`。secret 原文存於 gitignored 的 `~/sso.pg72.tw/apps/sso/.env.diary-client-secret`（部署 production 時 `wrangler secret put AUTH_CLIENT_SECRET`）。
  - `pg72-diary-dev`：本機 public client（PKCE、無 secret），redirect `http://127.0.0.1:5173/api/auth/callback`。
- Worker 端：`/api/*` guard middleware（`/api/health` 與 `/api/auth/*` 放行；localhost bypass；**讀取公開**；mutation 需有效 session，subject 不符回 403，並檢查 Origin）。auth 路由：`/api/auth/{login,callback,logout,session,backchannel-logout}`。
- Session：cookie 只存隨機 token（正式環境 `__Host-diary_session`），D1 `auth_sessions` 存 SHA-256 hash，7 天絕對效期。access/refresh token 不落地。
- 緊急撤銷 kill switch：`wrangler d1 execute diary-pg72-tw-db --remote --command "DELETE FROM auth_sessions"`。
- 擁有者 `sub` 已於 2026-07-15 完成 bootstrap 並填入 `wrangler.jsonc` 的 `AUTH_ALLOWED_SUBJECT`。UI 不顯示 sub（使用者要求）；日後要重查或換帳號，直接查 SSO 的 user 表：`cd ~/sso.pg72.tw/apps/sso && pnpm exec wrangler d1 execute PG72_ID_DB --remote --command "SELECT id, email FROM user"`（`subjectType='public'`，sub 即 user id，dev/prod client 相同）。
- Back-channel logout endpoint 已就緒但 SSO 端尚未實作遞送（單向 forward-compatible）；中央撤銷目前最長 7 天後才會在日記端失效。

## API 與資料入口

目前 Worker routes：

| Method | Route | 用途 |
| --- | --- | --- |
| GET | `/api/health` | health check |
| GET | `/api/overview` | overview 統計與近期資料 |
| GET | `/api/entries` | bounded timeline / search list |
| POST | `/api/entries` | 本機新增文字 entry；remote denied |
| GET | `/api/entries/:entryId` | entry detail、blocks、media、tags |
| GET | `/api/media/:mediaId` | 經 Worker 從 private R2 串流媒體 |
| POST | `/api/imports/apple-journal` | 建立或重用 import job |
| POST | `/api/imports/apple-journal/:importId/entries` | 寫入單篇 normalized entry |
| POST | `/api/imports/apple-journal/:importId/entries/:entryId/media` | 寫入單一附件 |
| POST | `/api/imports/apple-journal/:importId/entries/:entryId/media/uploads` | 建立或續接 owner-bound multipart upload |
| PUT | `/api/imports/apple-journal/:importId/entries/:entryId/media/uploads/:mediaId/parts/:partNumber` | 依序寫入一個 8 MiB R2 part |
| POST | `/api/imports/apple-journal/:importId/entries/:entryId/media/uploads/:mediaId/complete` | 驗證 part / ETag 並完成 R2 object |
| POST | `/api/imports/apple-journal/:importId/entries/:entryId/media/uploads/:mediaId/abort` | 取消未完成 upload |
| POST | `/api/imports/apple-journal/:importId/complete` | 完成與核對 import job |

資料模型以 migrations 為準，核心 tables 是 `journals`、`entries`、`entry_blocks`、`media`、`entry_media`、`entry_import_generations`、`media_uploads`、`media_upload_parts`、`media_cleanup_queue`、`tags`、`entry_tags`、`imports`、`import_items` 與 FTS5 `entry_search`。共用 API types 在 `shared/api.ts`，request parsing / validation 在 `shared/schemas.ts`。

## Cloudflare 實況與部署缺口

`wrangler.jsonc` 已宣告：

- Worker：`diary-pg72-tw`
- D1 binding：`DB` -> `diary-pg72-tw-db`
- R2 binding：`MEDIA` -> `diary-pg72-tw-media`
- Static Assets SPA fallback，`/api/*` 先進 Worker

但宣告不等於遠端已 provision。2026-07-15 實際查詢結果：

- R2 `diary-pg72-tw-media`：存在，APAC / Standard，0 objects，0 B。
- D1 `diary-pg72-tw-db`：2026-07-15 的遠端查詢曾顯示不存在；目前 `wrangler.jsonc` 已有 `database_id`，但本輪禁止 remote D1 操作，故不得把舊查詢或 config 宣告當成現況證明。
- Worker `diary-pg72-tw`：不存在，沒有 deployment history。
- GitHub：只有 CI workflow，repository secret list 為空。
- DNS：`diary.pg72.tw` 無解析結果。

因此不要執行 production migration、上傳真實資料或開放 remote mutation。正確的 production foundation 順序是：

1. 決定並建立清楚分離的 preview / production resources。
2. 以 read-only preflight 確認 production D1 是否存在、binding / resource ID 是否對應正確環境，再依下方 runbook 套用 `0001`–`0006` 或尚未套用的 forward migrations。
3. 設定 production 登入：`wrangler secret put AUTH_CLIENT_SECRET`（值在 `~/sso.pg72.tw/apps/sso/.env.diary-client-secret`）、確認 `AUTH_ALLOWED_SUBJECT` 已填擁有者 sub，先測 unauthorized/authorized routes（第一次 production 登入才會實際演練 `client_secret_basic`）。
4. 設定 Workers Builds 或等價 GitHub deployment；CI 與 deploy 分開，migration 要有可觀察的獨立步驟。
5. 部署 Worker + Static Assets，再綁 custom domain / DNS。
6. 用合成資料做 production smoke test；確認 R2 private、API auth、媒體讀取與 log 無內容外洩後，才考慮真實匯入。

Cloudflare CLI 指令執行前先讀 Cloudflare / Wrangler skill 或目前官方文件，並先用 read-only / dry-run 驗證目標 account、environment 和 binding。不要因為 R2 已存在就推定其他資源也存在。

### `0003` 相容 preflight、drain 與 rollback

`0003_media_uploads.sql` 曾在開發 branch 內被擴充，但已有環境可能早已把原始版本記成 applied。repository 現在保留原始 `0003`，所有 CAS / generation 修正都由 `0004`–`0006` forward migration 完成；**不得**刪除或手改 `d1_migrations` 紀錄，也不得重新執行 `0003`。

Production / preview migration 前依序做：

1. 確認目標 account、D1 database ID、R2 bucket 與環境；取得可復原的 D1 checkpoint / backup，記錄 R2 object count 與 lifecycle 設定。只用 metadata，不匯出日記內容到 repo 或 log。
2. Read-only 查 `d1_migrations`、`PRAGMA table_info(entries)`、`PRAGMA table_info(media_uploads)`、`PRAGMA foreign_key_check`。若 `0003` 已記錄但 schema 不是原始欄位或目前 canonical 欄位，停止；不要猜測修補 SQL。
3. 在舊 Worker 仍運行時暫停新的 import mutation。完成或透過既有 API abort 所有非 terminal upload，至少等目前 10 分鐘 lease 結束；確認 `media_uploads.status NOT IN ('completed','failed','aborted')` 為 0。
4. 完成或明確取消所有 `partial-import` entry，確認數量為 0。`0006` 內建 SQL guard；任一 count 非 0 時 migration 會 fail closed，不會靜默丟棄 part state。
5. 先在隔離 preview 的 schema copy 套用尚未 applied 的 migrations。全新 DB 套 `0001`–`0006`；已記錄原始 `0003` 的 DB 只會繼續套 `0004`–`0006`。核對 migration 順序、`entry_import_generations`、canonical CAS columns / CHECK constraints、`media_cleanup_queue`、integrity check 與 foreign-key check。
6. Migration 成功後才部署相符 Worker，仍保持 import 暫停；以純合成 entry + PNG / QuickTime 驗證 partial gate、reuse、multipart resume/complete/abort、active lease、scheduled cleanup 與公開 read。確認後才恢復 mutation。

Rollback 邊界：

- Migration 前可回滾舊 Worker，因為 schema 尚未改；不要讓新舊 Worker 同時接受 upload。
- `0006` 後不可只回滾到舊 Worker：舊程式不會寫 generation state，與新 schema 不相容。失敗時保持 mutation 關閉，優先 forward-fix；若必須回復，使用 migration 前 D1 checkpoint，並核對同一時間點的 R2 狀態。
- `media_cleanup_queue` 由新 generation 成功 publish 的 stale link 或 exact failed size transition 寫入。production smoke 完成前不要手動觸發 cleanup；Cron 由 `wrangler.jsonc` 的 `17 3 * * *` 隨 Worker deployment 管理，變更可能延遲生效。第一次 Cron 後檢查 `media_upload_cleanup_completed` 的 upload/media result 與 queue backlog，不記錄 filename 或內容。
- Push 到連接 Workers Builds 的 deployment branch 可能直接 build/deploy 並更新 Cron。Production 仍為 NO-GO 時，不得以「只 push code」假設不會改變遠端狀態。

## 尚未完成或仍有風險

以下是後續工作的主要缺口，不要把 README 的規劃誤認為已實作：

1. **Production environment isolation 與部署**：登入程式碼（PG72 ID OIDC）已完成，但 preview/production D1/R2、Worker deploy、custom domain、production secret 設定都未完成；back-channel logout 遞送要等 SSO 端實作。
2. **大型媒體 upload 的 production gate**：本機已改為 8 MiB Worker request + private R2 multipart，含順序/大小/MIME/簽章/ETag 驗證、逐 part retry、續傳、取消、CAS crash recovery、排程 cleanup 與 failed-row 修復；仍需重新審核本 branch、依 runbook 套用到 `0006`，再用合成大檔做 production smoke。presigned direct upload 只是可選流量優化。
3. **匯入 reconciliation**：已有 generation-scoped publication、整體與逐檔進度、去重、逐 part 續傳、R2/D1 reconciliation、完整 bounded error/skipped report、部分失敗重試 UI 與 superseded media cleanup；end-to-end content checksum reconciliation 仍需補強。
4. **Apple schema / codec 相容性**：Apple 未承諾 HTML schema 穩定；HEIC/HEVC/HDR 的跨瀏覽器顯示、縮圖和必要轉碼尚未完整解決。
5. **編輯工作流**：已完成 markdown 編輯（`PATCH /api/entries/:id`，imported entry 的多個文字 block 會合併為單一 paragraph）、soft delete + 復原（`DELETE` / `POST .../restore`）、附件上傳與移除（`POST /api/entries/:id/media`、`DELETE .../media/:mediaId`，fingerprint 去重、共用媒體引用計數保護、R2 key prefix `uploads/`）。尚缺：rich block editor、draft/autosave、位置/標籤管理、軟刪除保留期後的最終 R2 清理。
6. **資料可攜與復原**：完整 export、backup/checkpoint、restore 與 final R2 cleanup 尚未完成。
7. **規模與查詢**：需要 10,000 entries fixture、query-plan 檢查、完整 pagination / load-more 與更完整的 calendar/places/insights 行為。
8. **測試覆蓋**：已有純合成 PNG/QuickTime browser-to-R2、multipart resume/order/size/MIME/ETag/abort/CAS crash recovery、cleanup、malformed archive desktop/mobile、虛擬 157 MiB part geometry、remote PGID owner/Origin boundary；尚缺 production 實地大檔、delete recovery、完整 export 與 production smoke tests。

目前 production 明確為 **NO-GO**：先完成 branch re-review、production/preview resource isolation、`0003` preflight + forward migration 到 `0006` 與無個資合成 smoke，才可部署或匯入真實資料。

## 建議接手順序

除非使用者指定另一個 UI 任務，優先順序建議如下：

1. 先完成 production/preview environment 建置與部署（含 `AUTH_CLIENT_SECRET`、`AUTH_ALLOWED_SUBJECT` 與登入邊界實測），讓線上版本有可信的私密邊界。
2. 重新審核 multipart/CAS/cleanup 變更：先在隔離環境執行 `0003` compatibility preflight 並 forward migrate 到 `0006`，再用合成媒體測 retry/resume/abort、scheduled cleanup 與大於 100 MB 單檔；不要先用真實日記試錯。
3. 補 end-to-end content checksum reconciliation，並繼續將新發現的 export 變體縮成無隱私的最小合成 fixture。
4. 再做 draft/autosave、位置/標籤管理、刪除復原與完整 export。

如果工作只涉及既有 UI，仍要守住本文件中的卡片無媒體、詳情底部媒體、有序 masonry 與私密資料界線。

## 開發與驗證

環境需求：Node.js 22+、pnpm 11.5.0。`package.json` 目前鎖定 pnpm 11.5.0，實際依賴版本也已 exact pin。

```bash
pnpm install
pnpm run db:migrate:local
pnpm run db:seed:local
pnpm dev

pnpm run check
pnpm test
pnpm run test:e2e
pnpm build
```

注意：`db:seed:local` 是空內容 seed，只確保 journal container 存在；不要期待它建立 demo entries。`pnpm run typecheck` 會透過 `wrangler types` 產生 ignored 的 `worker-configuration.d.ts`，不要手寫 `Env`。

目前測試入口：

- `test/streaks.test.ts`：日期與 streak 統計。
- `test/worker.test.ts` / `test/import-media-upload.test.ts`：migration、API、generation-scoped 匯入、initial 與 deferred post-R2 stale multipart rejection、D1/R2、dedupe、CAS crash recovery、cleanup 與虛擬大檔 geometry；目前完整 Vitest 為 76 tests。
- `e2e/diary.spec.ts`：desktop/mobile overview、malformed/overlong-path/valid-preview/partial-failure/entry-skipped import、逐檔進度、composer、Apple import/re-import、Markdown、自然比例 media masonry、lightbox、卡片無媒體，以及有序 timeline masonry；目前為 9 Playwright cases。
- `.github/workflows/ci.yml`：check、Workers tests、Playwright Chromium 與 production build。

UI 變更至少要重新跑 Playwright，並檢查 desktop 與窄版 viewport 的 screenshot、overflow、overlay 和 console/page errors。結束前再執行 `git status --short`，確認沒有 `.wrangler`、真實 export、媒體、log、Playwright artifact 或 secret 進入 staged/commit 範圍。

## 最近的重要 commits

| Commit | 內容 |
| --- | --- |
| `16c53d3` | 完整 bounded failure/skipped report 與 ZIP path metadata 上限 |
| `adc7595` | generation publish 後的 durable zero-reference media cleanup |
| `6b7e2e0` | entry import generation scope 與 active part lease restart gate |
| `8073d88` | 序列化 multipart import、CAS recovery 與 partial-import 公開 gate |
| `d7e6f85` | 讓 timeline masonry E2E 可重跑且不重複造資料 |
| `eb46d46` | timeline 卡片改為會向上補位的有序 Grid masonry |
| `07b8944` | Markdown/GFM、自然比例 media masonry 與 lightbox |
| `af669e2` | 移除所有日記卡片媒體預覽 |
| `373c250` | 媒體移到 entry 正文最下方 |

接手時先以 `git log --oneline -5` 和 `git status --short` 更新這個 snapshot；如果程式行為與本文件不一致，以最新程式、測試、`README.md` 與使用者最新訊息交叉判斷，不能只信 handoff。
