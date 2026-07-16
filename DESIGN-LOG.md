# DESIGN-LOG — morden_dark 視覺統一

目標：把 diary.pg72.tw 前端視覺統一到 `morden_dark`（Linear/Modern 深色系）。
**只改視覺，不動邏輯/API/auth/資料。** 保留 a11y。不 push、不部署。

參考：`/Users/pgpenguin72/sso.pg72.tw/morden_dark.txt`
（近黑底 #050506、靛藍 accent #5E6AD2、分層環境光、多層陰影、Inter、mono 大寫小標、expo-out 微互動、16px 圓角）

## Stack 偵測

- Cloudflare Workers + Vite 8 + React 19 + TypeScript + Hono。
- 前端在 `src/`；**全站樣式集中在單一檔 `src/styles.css`**（純 CSS custom properties，無 Tailwind）。
- 因此視覺統一以「改 token + 針對性 sweep」為主，**盡量只碰 `src/styles.css` 與 `index.html`**，不動任何 `.tsx` 邏輯，降低與另一分頁的衝突面。

## 交接注意

- 兩個 Claude 分頁共用同一 working tree，故**留在 `main`**（切 branch 會改到對方的 checkout）。
- Commit 時**只 `git add` 我改的檔**（styles.css / index.html / DESIGN-LOG.md），絕不 `git add -A`，避免捲入對方未 commit 的變更。
- 開工時 working tree 乾淨，無進行中未 commit 工作。

## 決策紀錄

- **保留 `--serif`（Iowan Old Style）給長文閱讀**（entry prose、card 標題、對話框標題）。理由：日記的閱讀體感是產品靈魂，morden_dark 的字體指引主要針對 UI chrome。UI chrome 一律 Inter，小標改 mono 大寫。此為刻意保留，非遺漏。
- **保留 per-entry `--journal-color`**（Apple Journal 匯入帶來的每篇色帶）與語意色（coral=danger、sky=link、gold）。理由：a11y 色彩獨立性 + 功能保留；morden 允許少量語意色。accent（原 lime）全數改為靛藍。
- 變數名沿用（如 `--forest` 現指靛藍）以最小化 diff；已在 token 區加註解說明。

## 變更步驟

- [x] Step 1 — 重寫 `:root` token：近黑底階、靛藍 accent、半透明 surface/border、radius/shadow/easing/mono token。
- [x] Step 2 — accent sweep：lime `rgba(200,241,105,*)` → indigo `rgba(94,106,210,*)`；focus ring 改靛藍。
- [x] Step 3 — 元件規格：card 16px 圓角 + 多層陰影、primary button 靛藍發光、input 規格、mono 大寫小標、expo-out 過場。
- [x] Step 4 — 分層環境光背景（CSS-only，body 偽元素，reduced-motion 安全）。

## 中斷與接手（2026-07-16）

- 前一 session 於 Step 4 完成後、commit 前因 API 503 中斷；working tree 留有完整 Step 1–4 diff。
- 接手 session 檢視 diff：lime accent 無殘留、reduced-motion 全域覆蓋 ambient 動畫、`pnpm run check` 與 `pnpm run build` 通過，判定可用，直接 commit 保存。
