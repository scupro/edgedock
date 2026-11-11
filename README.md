# EdgeDock

> 部署在 Cloudflare Workers 上的 Serverless 檔案管理與 Markdown 分享工具。

[English](./README.en.md) · 正體中文

EdgeDock 把多個儲存空間（S3 相容儲存、WebDAV、本機磁碟）掛載到同一個目錄樹，提供網頁檔案管理、線上預覽、Markdown 編輯與分享，並對外提供 WebDAV 服務。後端是一份 [Hono](https://hono.dev/) 程式碼，同時能跑在 Cloudflare Workers（D1 資料庫）與 Node.js / Docker（SQLite）上；前端是 Vue 3 + Vite 的 PWA。

## 功能

- **多儲存掛載**：S3 相容（Cloudflare R2、Backblaze B2、AWS S3、阿里雲 OSS、騰訊雲 COS、MinIO 等）、WebDAV、本機目錄（僅 Node / Docker）。儲存憑證以 AES-GCM 加密後存放於資料庫。
- **檔案管理**：瀏覽、上傳、下載、重新命名、移動、複製、刪除、建立資料夾，以及檔名搜尋（排程建立索引）。
- **智慧上傳**：依檔案大小自動選擇策略
  1. 瀏覽器以 presigned URL 直傳 S3（最快，需設定 Bucket CORS）
  2. 經由 Worker 串流上傳
  3. 分段上傳（multipart），可續傳；上傳進度記錄在資料庫中
- **線上預覽**：圖片、影音、PDF、Word、試算表、Markdown、程式碼高亮、EPUB 等（完整清單見下方），其他格式可設定外部預覽服務。
- **Markdown 編輯器**：基於 Vditor（所見即所得 / 即時渲染 / 分割預覽），支援 KaTeX、Mermaid；資源檔自行託管，不依賴第三方 CDN。可匯出 PDF、圖片、Word。
- **分享連結**：可設定密碼、到期時間、存取次數上限；提供 `/raw/` 直連。
- **API 金鑰**：唯讀或讀寫權限，可限制路徑前綴與到期時間，也可作為 WebDAV 密碼使用。
- **WebDAV 伺服器**：`/dav` 端點，可用 Finder、Windows 檔案總管、rclone、RaiDrive 等掛載。
- **排程工作**：Cron Trigger 清理過期上傳與分享、重建搜尋索引；Cloudflare Workflows 執行長時間的索引與同步工作。
- **PWA**：可安裝至桌面 / 手機，介面支援正體中文與英文。

## 架構

```
             ┌──────────────────────── Cloudflare Worker ────────────────────────┐
瀏覽器 ───▶  │  /api/*  /raw/*  /dav/*  →  Hono API（auth、fs、shares、upload、WebDAV）│ ──▶ S3 / R2 / WebDAV
             │  其他路徑                 →  靜態資源（web/dist，SPA fallback）       │
             │  D1（使用者、儲存設定、分享、上傳工作階段、索引） · Workflows · Cron │
             └───────────────────────────────────────────────────────────────────┘
```

有兩種部署形態：

| 形態 | 說明 | 適用情境 |
| --- | --- | --- |
| **整合式單一 Worker**（建議） | 一個 Worker 同時提供 API 與前端靜態資源（Workers Static Assets，`not_found_handling = "single-page-application"`）。同網域，不需處理 CORS。 | 大多數情況 |
| **前後端分離** | 後端仍部署為 Worker（或 Docker），前端另外部署到 Vercel / Cloudflare Pages 等。前端建置時以 `VITE_API_BASE` 指向後端，後端以 `CORS_ORIGINS` 允許前端網域。 | 已有前端託管平台、想讓前端走不同網域 |

專案結構：

```
server/     Hono 後端（worker.ts = Workers 進入點，node.ts = Node/Docker 進入點）
  migrations/  D1 / SQLite 資料表
web/        Vue 3 前端（Vite、PWA）
docker/     Dockerfile.server、Dockerfile.web、nginx 設定
wrangler.toml
```

## 支援預覽格式

依 [`web/src/lib/fileTypes.ts`](./web/src/lib/fileTypes.ts)：

| 類型 | 副檔名 |
| --- | --- |
| 圖片 | png, jpg, jpeg, gif, webp, avif, bmp, ico, apng, svg |
| 影片 | mp4, webm, m4v, mov, ogv, mkv（實際能否播放取決於瀏覽器編碼支援） |
| 音訊 | mp3, wav, ogg, oga, flac, m4a, aac, opus, weba |
| PDF | pdf |
| Word | docx |
| 試算表 | xlsx, xls, xlsm, ods, csv, tsv, numbers |
| Markdown | md, markdown, mdown, mkd |
| JSON | json, jsonc, json5, geojson |
| 電子書 | epub |
| 程式碼（語法高亮） | js, mjs, cjs, jsx, ts, tsx, vue, svelte, html, htm, xml, xhtml, css, scss, less, py, rb, php, java, kt, kts, scala, groovy, gradle, go, rs, c, h, cpp, cc, hpp, cs, swift, m, dart, sh, bash, zsh, fish, ps1, bat, cmd, sql, yaml, yml, toml, dockerfile, makefile, mk, nginx, lua, r, pl, ex, exs, erl, hs, clj, fs, vb, graphql, gql, proto, tf, diff, patch, tex, jl, zig, nim，以及檔名為 `Dockerfile`、`Makefile` 的檔案 |
| 純文字 | txt, log, ini, conf, cfg, env, properties, gitignore, editorconfig, srt, vtt, nfo |
| 外部預覽 | 由管理員在「設定」中指定副檔名與預覽網址範本（例如以 Office Online 開啟 ppt / pptx / doc） |

文字類檔案（Markdown、程式碼、純文字、JSON）預覽上限為 5 MB。

## 部署

### 方法一：GitHub Actions 一鍵部署（建議）

1. Fork 或 clone 本專案到自己的 GitHub。
2. 在 Cloudflare 建立 API Token（範本「Edit Cloudflare Workers」，並加上 **D1: Edit** 權限），記下 Account ID。
3. 到 GitHub 儲存庫的 **Settings → Secrets and variables → Actions**，新增：
   - `CLOUDFLARE_API_TOKEN`（必要）
   - `CLOUDFLARE_ACCOUNT_ID`（必要）
   - `ENCRYPTION_KEY`（建議；首次部署時會寫入 Worker Secret。可用 `openssl rand -base64 32` 產生）
   - `JWT_SECRET`、`ADMIN_USERNAME`、`ADMIN_PASSWORD`（選用）
4. 推送到 `main`，或在 **Actions → Deploy → Run workflow** 手動執行。

工作流程（`.github/workflows/deploy.yml`）會：安裝相依套件 → 建置前端 → 若 D1 資料庫 `edgedock` 不存在就建立 → 把 `database_id` 填入 `wrangler.toml` → 套用遠端 migration → 設定 Secrets → `wrangler deploy`。

部署完成後開啟 `https://edgedock.<你的子網域>.workers.dev`。若沒有設定 `ADMIN_USERNAME` / `ADMIN_PASSWORD`，首次開啟會進入建立管理員的畫面。

### 方法二：Wrangler CLI 手動部署

需要 Node.js 22.5 以上。

```bash
git clone https://github.com/scupro/edgedock.git
cd edgedock
npm ci

npx wrangler login
npx wrangler d1 create edgedock          # 把輸出的 database_id 貼到 wrangler.toml
npm run db:migrate:remote                # 套用資料表

npx wrangler secret put ENCRYPTION_KEY   # 必要
# 選用：npx wrangler secret put JWT_SECRET / ADMIN_USERNAME / ADMIN_PASSWORD

npm run deploy                           # 建置前端並部署
```

本機開發：

```bash
cp .dev.vars.example .dev.vars           # 填入 ENCRYPTION_KEY
npm run db:migrate:local
npm run build:web && npm run dev         # http://127.0.0.1:8787
# 或前端熱更新：npm run dev -w web（http://127.0.0.1:5173，代理 /api 到 8787）
```

### 方法三：Docker Compose（自架）

Node 版本以 SQLite（`node:sqlite`）取代 D1，並可掛載本機目錄作為儲存。

```bash
export ENCRYPTION_KEY="$(openssl rand -base64 32)"   # 請妥善保存，遺失後已存的儲存憑證無法解密
docker compose up -d --build
# 開啟 http://localhost:8080
```

- `server`：Node 22 執行 `server/dist/node.mjs`，資料存放在 volume `edgedock-data`（`/data`）。在後台新增「本機」儲存時，可使用 `/data/files`。
- `web`：nginx 提供前端，並把 `/api`、`/raw`、`/dav` 反向代理到 `server`。

也可以不使用 nginx：設定 `STATIC_DIR` 指向建置好的 `web/dist`，由 Node 伺服器直接提供前端。

### 方法四：Vercel / Cloudflare Pages（僅前端）

後端仍需以方法一～三其中一種部署，前端另外託管：

- **Vercel**：Root Directory 設為 `web`，Build Command `npm run build`，Output `dist`。`web/vercel.json` 已設定 SPA rewrites。
- **Cloudflare Pages**：Root directory `web`，建置指令 `npm run build`，輸出目錄 `dist`。Pages 預設即會把未知路徑回退到 `index.html`。

兩者都要設定建置環境變數 `VITE_API_BASE=https://你的後端網域`，並在後端的 `CORS_ORIGINS` 加入前端網域。

## 環境變數與 Secrets

### 後端（Worker 與 Node 共用）

| 名稱 | 必要 | 說明 |
| --- | --- | --- |
| `ENCRYPTION_KEY` | **必要** | 加密儲存憑證（AES-GCM）的金鑰，請用長隨機字串。**更換後既有的儲存設定將無法解密。** Worker 上請用 Secret 設定。 |
| `JWT_SECRET` | 選用 | 簽署管理員 JWT；未設定時由 `ENCRYPTION_KEY` 衍生。 |
| `ADMIN_USERNAME` | 選用 | 初始管理員帳號；未設定時於首次開啟時在介面建立。 |
| `ADMIN_PASSWORD` | 選用 | 初始管理員密碼（至少 8 個字元）。 |
| `CORS_ORIGINS` | 選用 | 允許跨網域呼叫 API 的來源，以逗號分隔；`*` 代表全部；空白代表僅同源。前後端分離時必填。 |
| `JWT_TTL_HOURS` | 選用 | 登入有效時數，預設 `168`（7 天）。 |

### Node / Docker 專用

| 名稱 | 預設值 | 說明 |
| --- | --- | --- |
| `DATA_DIR` | `./data` | 資料目錄（SQLite 檔、上傳暫存）。 |
| `DB_FILE` | `$DATA_DIR/edgedock.sqlite` | SQLite 資料庫檔案路徑。 |
| `STATIC_DIR` | （未設定） | 指向 `web/dist` 時由 Node 直接提供前端並處理 SPA 路由。 |
| `PORT` | `8787` | 監聽埠。 |

### 前端建置（Vite）

| 名稱 | 說明 |
| --- | --- |
| `VITE_API_BASE` | 後端網址。整合式部署留空（同源）；前後端分離時填入後端網址。 |
| `VITE_VDITOR_CDN` | Vditor 資源位置，預設使用自行託管的 `/vendor/vditor`。 |

### GitHub Actions

| 名稱 | 說明 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | 需有 Workers Scripts: Edit 與 D1: Edit 權限。 |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 帳戶 ID。 |

本機開發的 Secrets 放在 `.dev.vars`（已列入 `.gitignore`，請勿提交）。

## Bucket CORS 設定

瀏覽器直傳（presigned PUT 與分段直傳）需要在 Bucket 設定 CORS，否則會自動退回經由 Worker 上傳（速度較慢，且受 100 MB 單次請求限制）。重點：

- 允許來源（AllowedOrigins）：你的站台網址，例如 `https://edgedock.example.workers.dev`
- 允許方法：`PUT`、`GET`（以及 `HEAD`）
- 允許標頭：`*`
- **暴露標頭（ExposeHeaders）：`ETag`**——分段上傳完成時需要讀取每段的 ETag

以 Cloudflare R2 為例（Bucket → Settings → CORS policy）：

```json
[
  {
    "AllowedOrigins": ["https://edgedock.example.workers.dev"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

AWS S3、B2、MinIO 等的 CORS 設定格式略有不同，但需要的項目相同。

## 掛載 WebDAV

WebDAV 端點：`https://你的網域/dav/`

驗證方式（HTTP Basic）：

- 管理員帳號 + 密碼（完整權限），或
- 任意使用者名稱 + **API 金鑰**（`edk_` 開頭）作為密碼——權限與路徑範圍依金鑰設定。建議為每個用戶端建立獨立金鑰。

各平台：

- **macOS Finder**：前往 → 連接伺服器（⌘K）→ 輸入 `https://你的網域/dav/`。
- **Windows**：建議使用 [RaiDrive](https://www.raidrive.com/) 或 rclone；內建「連線網路磁碟機」需 HTTPS，且預設檔案大小上限約 50 MB（可調整登錄機碼 `FileSizeLimitInBytes`）。
- **Linux**：`davfs2` 或檔案管理員中輸入 `davs://你的網域/dav/`。
- **rclone**：

  ```bash
  rclone config create edgedock webdav url=https://你的網域/dav/ vendor=other user=admin pass=$(rclone obscure 'edk_xxx')
  rclone ls edgedock:
  ```

- **iOS / Android**：Documents by Readdle、Solid Explorer 等支援 WebDAV 的 App。

## 已知限制

- **單次請求 100 MB**：Cloudflare Workers（Free / Pro 方案）請求本體上限為 100 MB。經由 Worker 的上傳（包含 WebDAV PUT）超過此大小會失敗；大檔請使用網頁上傳（自動走直傳或分段上傳）。
- **分段大小預設 8 MiB**：可在「設定」調整（S3 最小 5 MiB，最多 10,000 段，超過時自動加大）。
- **S3 複製 / 移動單檔上限 5 GB**：目前使用單次 `CopyObject`，超過 5 GB 的物件無法在伺服器端複製或移動。
- **WebDAV 快取以資料中心為單位**：Worker 使用 Cache API，快取只存在於各個 Cloudflare 資料中心，不同地區可能短暫看到舊內容（預設 TTL 30 秒，可在設定調整）。
- **`Depth: infinity` 視為 `1`**：PROPFIND 不支援無限深度，只回傳一層。
- **續傳需重新選擇檔案**：重新整理頁面後，瀏覽器無法自動取回檔案，需重新選擇同一個檔案才能從已上傳的分段繼續。

## Phase 2 規劃

- OneDrive
- Google Drive
- Telegram
- Discord Bot
- HuggingFace
- GitHub API / Releases（唯讀）

## 開發

```bash
npm ci
npm run typecheck   # tsc（worker + node）與 vue-tsc
npm test            # 後端 vitest
npm run build       # 前端 + Node bundle
npx wrangler deploy --dry-run
```

## 授權

[MIT](./LICENSE)
