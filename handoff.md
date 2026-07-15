# PG72 Diary Handoff

> 最後核對：2026-07-15（Asia/Taipei）  
> Branch：`main`  
> HEAD：`d7e6f85 test: make timeline masonry e2e idempotent`  
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
- entry 逐篇 D1 upsert，媒體逐個送到 Worker 後寫入 private R2。
- 依 archive fingerprint、source path、canonical content hash 與媒體 fingerprint 去重；同一 ZIP 可重新選取並安全重跑。
- import job 與 import item 會記錄進度，已完成基本 inserted / duplicate / skipped / failed 計數。

主要檔案：

- `src/components/ImportDialog.tsx`
- `src/lib/apple-journal.ts`
- `worker/routes/imports.ts`
- `shared/schemas.ts`
- `migrations/0001_initial.sql`

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
| POST | `/api/imports/apple-journal/:importId/complete` | 完成與核對 import job |

資料模型以 `migrations/0001_initial.sql` 為準，核心 tables 是 `journals`、`entries`、`entry_blocks`、`media`、`entry_media`、`tags`、`entry_tags`、`imports`、`import_items` 與 FTS5 `entry_search`。共用 API types 在 `shared/api.ts`，request parsing / validation 在 `shared/schemas.ts`。

## Cloudflare 實況與部署缺口

`wrangler.jsonc` 已宣告：

- Worker：`diary-pg72-tw`
- D1 binding：`DB` -> `diary-pg72-tw-db`
- R2 binding：`MEDIA` -> `diary-pg72-tw-media`
- Static Assets SPA fallback，`/api/*` 先進 Worker

但宣告不等於遠端已 provision。2026-07-15 實際查詢結果：

- R2 `diary-pg72-tw-media`：存在，APAC / Standard，0 objects，0 B。
- D1 `diary-pg72-tw-db`：遠端帳號中不存在；`wrangler.jsonc` 也尚無 `database_id`。
- Worker `diary-pg72-tw`：不存在，沒有 deployment history。
- GitHub：只有 CI workflow，repository secret list 為空。
- DNS：`diary.pg72.tw` 無解析結果。

因此不要執行 production migration、上傳真實資料或開放 remote mutation。正確的 production foundation 順序是：

1. 決定並建立清楚分離的 preview / production resources。
2. 建立 production D1，補上正確 binding / resource ID，套用 migration（含 `0002_auth.sql`）。
3. 設定 production 登入：`wrangler secret put AUTH_CLIENT_SECRET`（值在 `~/sso.pg72.tw/apps/sso/.env.diary-client-secret`）、確認 `AUTH_ALLOWED_SUBJECT` 已填擁有者 sub，先測 unauthorized/authorized routes（第一次 production 登入才會實際演練 `client_secret_basic`）。
4. 設定 Workers Builds 或等價 GitHub deployment；CI 與 deploy 分開，migration 要有可觀察的獨立步驟。
5. 部署 Worker + Static Assets，再綁 custom domain / DNS。
6. 用合成資料做 production smoke test；確認 R2 private、API auth、媒體讀取與 log 無內容外洩後，才考慮真實匯入。

Cloudflare CLI 指令執行前先讀 Cloudflare / Wrangler skill 或目前官方文件，並先用 read-only / dry-run 驗證目標 account、environment 和 binding。不要因為 R2 已存在就推定其他資源也存在。

## 尚未完成或仍有風險

以下是後續工作的主要缺口，不要把 README 的規劃誤認為已實作：

1. **Production environment isolation 與部署**：登入程式碼（PG72 ID OIDC）已完成，但 preview/production D1/R2、Worker deploy、custom domain、production secret 設定都未完成；back-channel logout 遞送要等 SSO 端實作。
2. **大型媒體 upload**：目前附件仍經 Worker request body 寫 R2；真實 archive 有約 157.4 MB 單檔，會超過常見 100 MB request body 限制。需要 object-scoped direct upload authorization 與 R2 multipart/resume。
3. **匯入 reconciliation**：已有基本進度與去重，但完整可下載 error report、部分完成狀態、逐 part retry、checksum reconciliation 和中斷後精確續傳仍需補強。
4. **Apple schema / codec 相容性**：Apple 未承諾 HTML schema 穩定；HEIC/HEVC/HDR 的跨瀏覽器顯示、縮圖和必要轉碼尚未完整解決。
5. **編輯工作流**：目前只有基本文字新增；rich block editor、draft/autosave、編輯、刪除/復原、附件線上上傳、位置/標籤管理尚未完成。
6. **資料可攜與復原**：完整 export、backup/checkpoint、restore 與 final R2 cleanup 尚未完成。
7. **規模與查詢**：需要 10,000 entries fixture、query-plan 檢查、完整 pagination / load-more 與更完整的 calendar/places/insights 行為。
8. **測試覆蓋**：尚缺 production 實地登入邊界驗證、direct/multipart upload、malformed archive、delete recovery、完整 export 與 production smoke tests。

## 建議接手順序

除非使用者指定另一個 UI 任務，優先順序建議如下：

1. 先完成 production/preview environment 建置與部署（含 `AUTH_CLIENT_SECRET`、`AUTH_ALLOWED_SUBJECT` 與登入邊界實測），讓線上版本有可信的私密邊界。
2. 實作 private R2 direct + multipart upload；用大於 100 MB 的合成媒體測試 retry、resume、size/MIME 限制與 cleanup。
3. 補 Apple importer reconciliation / error report，並將已知真實 export 變體縮成無隱私的最小合成 fixture。
4. 再做 entry edit、draft/autosave、附件管理、刪除復原與完整 export。

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
- `test/worker.test.ts`：migration、API、匯入、D1/R2 與 dedupe integration。
- `e2e/diary.spec.ts`：desktop/mobile overview、composer、Apple import/re-import、Markdown、自然比例 media masonry、lightbox、卡片無媒體，以及有序 timeline masonry。
- `.github/workflows/ci.yml`：check、Workers tests、Playwright Chromium 與 production build。

UI 變更至少要重新跑 Playwright，並檢查 desktop 與窄版 viewport 的 screenshot、overflow、overlay 和 console/page errors。結束前再執行 `git status --short`，確認沒有 `.wrangler`、真實 export、媒體、log、Playwright artifact 或 secret 進入 staged/commit 範圍。

## 最近的重要 commits

| Commit | 內容 |
| --- | --- |
| `d7e6f85` | 讓 timeline masonry E2E 可重跑且不重複造資料 |
| `eb46d46` | timeline 卡片改為會向上補位的有序 Grid masonry |
| `07b8944` | Markdown/GFM、自然比例 media masonry 與 lightbox |
| `af669e2` | 移除所有日記卡片媒體預覽 |
| `373c250` | 媒體移到 entry 正文最下方 |

接手時先以 `git log --oneline -5` 和 `git status --short` 更新這個 snapshot；如果程式行為與本文件不一致，以最新程式、測試、`README.md` 與使用者最新訊息交叉判斷，不能只信 handoff。
