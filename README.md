# EdgeDock

> 部署在 Cloudflare Workers 上的 Serverless 檔案管理與 Markdown 分享工具。

[English](./README.en.md) · 正體中文

EdgeDock 把多個儲存空間（S3 相容儲存、WebDAV、OneDrive、Google Drive、Telegram、Discord、HuggingFace、GitHub、本機磁碟）掛載到同一個目錄樹，提供網頁檔案管理、線上預覽、Markdown 編輯與分享，並對外提供 WebDAV 服務。後端是一份 [Hono](https://hono.dev/) 程式碼，同時能跑在 Cloudflare Workers（D1 資料庫）與 Node.js / Docker（SQLite）上；前端是 Vue 3 + Vite 的 PWA。

## 功能

- **多儲存掛載**：S3 相容（Cloudflare R2、Backblaze B2、AWS S3、阿里雲 OSS、騰訊雲 COS、MinIO 等）、WebDAV、OneDrive / SharePoint、Google Drive、Telegram、Discord、HuggingFace Hub、GitHub（唯讀）、本機目錄（僅 Node / Docker）。儲存憑證與 OAuth Token 以 AES-GCM 加密後存放於資料庫。
- **檔案管理**：瀏覽、上傳、下載、重新命名、移動、複製、刪除、建立資料夾，以及檔名搜尋（排程建立索引）。
- **可靠的上傳**：依檔案大小與儲存空間自動選擇策略
  1. 瀏覽器以 presigned URL 直傳 S3（最快，需 Bucket CORS；可在後台「一鍵設定 CORS」）
  2. 經由 Worker 串流上傳（只用於小檔，永遠低於 Worker 請求上限）
  3. 分段上傳：每段自動重試（指數退避 + 抖動）、逾時偵測、斷網自動暫停、重新整理後續傳、MD5 逐段校驗，詳見「上傳可靠性」
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
| `CORS_ORIGINS` | 選用 | 允許跨網域呼叫 `/api`、`/raw`、`/dav` 的來源，以逗號分隔。支援精確來源、`*`、萬用字元子網域 `https://*.example.com` 與任意連接埠 `http://localhost:*`；空白代表僅同源。前後端分離時必填。 |
| `CORS_CREDENTIALS` | 選用 | `true` / `false`：是否送出 `Access-Control-Allow-Credentials`。預設：列出的來源為 `true`、`*` 為 `false`（`*` 搭配 `true` 時改為回傳請求的 Origin）。 |
| `CORS_MAX_AGE` | 選用 | 預檢（preflight）快取秒數，預設 `86400`。 |
| `PUBLIC_URL` | 選用 | 站台公開網址，例如 `https://edgedock.example.com`。用於 OAuth Redirect URI 與 Bucket CORS 的來源；未設定時使用請求的網址。 |
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

## CORS

### 伺服器端（`/api`、`/raw`、`/dav`）

- 預檢請求（`OPTIONS` + `Access-Control-Request-Method`）在驗證之前就回應 `204`，並帶 `Access-Control-Max-Age`（`CORS_MAX_AGE`）、允許方法（含 WebDAV 的 `PROPFIND`、`MKCOL`、`MOVE`…）與瀏覽器要求的標頭。
- 一般的 WebDAV `OPTIONS`（沒有 `Access-Control-Request-Method`）仍交給 WebDAV 處理，回傳 `DAV:`、`Allow:` 等能力標頭。
- 所有回應（含錯誤）都暴露 `ETag`、`Content-Range`、`Content-Length`、`Accept-Ranges`、`Location`、`Content-Disposition`、`DAV`、`Lock-Token`、`Retry-After` 等標頭，並設定 `Vary: Origin`。
- 來源規則見 `CORS_ORIGINS`／`CORS_CREDENTIALS`（上方環境變數表）。

### S3 Bucket CORS（瀏覽器直傳）

瀏覽器直傳（presigned PUT 與分段直傳）需要 Bucket 允許你的站台來源。後台「儲存空間」→ 編輯 S3 儲存：

- **一鍵設定 CORS**：呼叫 `PutBucketCors`（R2 S3 API、B2 S3、AWS S3、OSS、COS），來源 = 站台網址，方法 `GET/PUT/POST/HEAD/DELETE`，標頭 `*`，暴露 `ETag`。已存在的其他來源規則會保留。
- **檢測 CORS**：伺服器端讀取 `GetBucketCors` 並模擬瀏覽器預檢，接著由瀏覽器實際以 presigned URL 上傳一個極小的測試物件（完成後刪除），清楚顯示結果；無法自動設定時（權限不足、MinIO 不支援逐 Bucket CORS 等）會依服務商顯示手動設定步驟。

手動設定時的規則（以 R2 為例：Bucket → Settings → CORS policy）：

```json
[
  {
    "AllowedOrigins": ["https://edgedock.example.workers.dev"],
    "AllowedMethods": ["GET", "PUT", "POST", "HEAD", "DELETE"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

| 服務商 | 一鍵設定需要的權限 / 注意事項 |
| --- | --- |
| Cloudflare R2 | API Token 需「Admin Read & Write」；「Object Read & Write」無法修改 CORS |
| Backblaze B2 | Application Key 需 `writeBuckets`；若在網頁介面設過 B2 Native CORS，需先清除 |
| AWS S3 | IAM 需 `s3:PutBucketCORS`、`s3:GetBucketCORS` |
| 阿里雲 OSS / 騰訊雲 COS | RAM／子帳號需 `PutBucketCors` 權限 |
| MinIO | 不支援逐 Bucket CORS：設定 `MINIO_API_CORS_ALLOW_ORIGIN` 或 `mc admin config set <alias> api cors_allow_origin=...` |

**自動備援**：直傳若因 CORS 失敗（瀏覽器回報網路錯誤），前端會立刻改走 Worker 代理／分段上傳，並記住該儲存空間（7 天，或在「檢測 CORS」成功後清除），之後不再嘗試直傳。

## 上傳可靠性

- **所有儲存都支援分段**：S3 使用原生 multipart；OneDrive / Google Drive 對應到它們的上傳工作階段；Telegram / Discord 每段即一則訊息；WebDAV / 本機等使用模擬分段（暫存分段 → 完成時串流合併）。
- **逐段重試**：預設每段最多 5 次，指數退避 + 抖動（500 ms × 2ⁿ，上限 30 秒），遵守 `Retry-After`；每段有逾時（預設 120 秒，含停滯偵測）；可取消。
- **自適應並行**：每個檔案預設同時上傳 3 段，遇錯誤減半，連續成功後回升；需要依序上傳的服務（OneDrive、Google Drive）自動改為 1。
- **續傳**：工作階段存在 D1，瀏覽器狀態存在 IndexedDB（檔案指紋 = 名稱 + 大小 + 修改時間 + 前後 64 KiB 的 SHA-256）。
  - 斷網時自動暫停（監聽 `online` / `offline`），恢復後繼續，不消耗重試次數。
  - 重新整理頁面後，上傳面板會列出未完成的上傳，按「重新選擇檔案以續傳」並選同一個檔案即可繼續；指紋不符會拒絕。
  - 續傳前伺服器會以 `ListParts`（S3）、`nextExpectedRanges`（OneDrive）、狀態查詢（Google Drive）或暫存分段檢查實際已上傳的分段，只跳過確實存在的部分。
- **經由 Worker 的請求永遠不超過上限**：單次代理請求上限 `proxyMaxChunkMB`（預設 50 MiB，最大 95 MiB），超過的檔案一律分段（分段大小預設 8 MiB）；請求本體以串流轉送，不會整份讀入記憶體；上游錯誤分為可重試（網路、逾時、408/429/5xx → 回應 `503` + `X-EdgeDock-Retriable: 1`）與不可重試（其他 4xx）。
- **完整性**：每段計算 MD5（`Content-MD5`）：S3 由服務端驗證、模擬分段由 Worker 在串流時驗證（不符回 `422` 並丟棄該段）、直傳則比對分段 ETag；完成時驗證最終大小，S3 另比對 multipart ETag（`md5(各段 md5)-N`）。
- **清理**：Cron 每 30 分鐘中止過期的工作階段，並清除沒有工作階段對應的 S3 multipart 上傳與暫存分段（超過保留時數者）。
- **介面**：每個檔案顯示進度、速度、剩餘時間、重試次數、暫停／繼續／取消，錯誤訊息為正體中文。
- 相關設定（後台「設定」）：分段大小、分段門檻、每檔並行段數、每段嘗試次數、每段逾時、Worker 代理單次上限、未完成上傳保留時數。

## 儲存驅動設定

所有表單欄位都由驅動定義產生；密碼類欄位加密儲存，編輯時留空表示不變更。

### OneDrive / SharePoint

1. [Azure 入口網站](https://portal.azure.com/) → Microsoft Entra ID → **應用程式註冊** → 新增註冊。支援的帳戶類型：個人帳號選「任何組織目錄中的帳戶及個人 Microsoft 帳戶」。
2. **驗證** → 新增平台「Web」→ Redirect URI 填 `https://你的網域/api/oauth/onedrive/callback`（後台表單會顯示正確網址）。
3. **憑證與祕密** → 新增用戶端密碼，複製「值」。
4. **API 權限** → Microsoft Graph → 委派：`Files.ReadWrite.All`、`offline_access`（SharePoint 再加 `Sites.ReadWrite.All`）。
5. 在 EdgeDock 新增 OneDrive 儲存，填 Client ID / Secret（商務帳號可填租用戶 ID），儲存後按「以 OAuth 授權取得 Refresh Token」。Refresh Token 會加密寫入；Microsoft 輪替的新 Token 也會自動加密保存。
6. 選填：`Drive ID`（SharePoint 文件庫或其他磁碟機）、根目錄、21Vianet（中國）雲端。

### Google Drive

- **OAuth（個人帳號）**：[Google Cloud Console](https://console.cloud.google.com/) → 建立專案 → 啟用「Google Drive API」→ OAuth 同意畫面（測試中的應用程式請把自己加為測試使用者；發布為「正式版」可避免 Refresh Token 7 天過期）→ 憑證 → 建立 OAuth 用戶端 ID（網頁應用程式）→ 授權重新導向 URI 填 `https://你的網域/api/oauth/gdrive/callback`。在 EdgeDock 填 Client ID / Secret，儲存後按「授權」。
- **服務帳戶**：IAM 與管理 → 服務帳戶 → 建立 → 金鑰 → 新增 JSON 金鑰，把整份 JSON 貼到「服務帳戶 JSON 金鑰」。把要使用的資料夾（建議**共用雲端硬碟**，服務帳戶本身沒有儲存配額）分享給服務帳戶 email，並把資料夾／共用雲端硬碟 ID 填入「根資料夾 ID」。Workspace 網域委派可填「代表使用者」。

### Telegram

1. 找 [@BotFather](https://t.me/BotFather) → `/newbot` → 取得 Bot Token。
2. 建立私人頻道（或群組），把 Bot 加為管理員（允許發布與刪除訊息）。
3. 取得 Chat ID：在頻道發一則訊息後開 `https://api.telegram.org/bot<TOKEN>/getUpdates`，或轉傳訊息給 @userinfobot；頻道 ID 形如 `-100…`。
4. 檔案切成 ≤ 20 MB 的分段（官方 Bot API 的 `getFile` 下載上限），下載時自動組回並支援 Range；目錄結構存在 D1。自架 [telegram-bot-api](https://github.com/tdlib/telegram-bot-api) 可填「Bot API 位址」並加大分段。

### Discord

1. [Discord Developer Portal](https://discord.com/developers/applications) → New Application → Bot → Reset Token 並複製。
2. OAuth2 → URL Generator：scope `bot`，權限 View Channel、Send Messages、Attach Files、Read Message History（要能刪除檔案再加 Manage Messages），用產生的網址邀請 Bot 進伺服器。
3. Discord 設定 → 進階 → 開啟開發者模式，右鍵頻道 → 複製頻道 ID。
4. 檔案切成附件（預設 8 MiB；未加成伺服器的 Bot 上限為每則 10 MiB）。附件的 CDN 連結有簽章且會過期，讀取時會自動透過 API 取得新的連結。

### HuggingFace Hub

1. [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens) 建立 Token：只瀏覽用 `read`；要上傳請用 `write` 或細粒度 Token 並勾選該 repo 的寫入權限。
2. 填 Repo（`使用者/名稱`）、類型（dataset / model / space）、分支。
3. 每次上傳／刪除／移動都是一次 commit；Hub 要求放 LFS 的檔案（大型二進位檔）會自動經由 Git LFS 上傳，LFS 檔案的移動只改指標不重新上傳。每個檔案以單一請求上傳，大小上限為「上傳大小上限」（預設 50 MiB）且不超過 Worker 代理上限，更大的檔案請用 `huggingface-cli upload`。

### GitHub（唯讀）

- 填擁有者與 Repo，選擇顯示「Repo 內容」、「Releases 發行檔案」或「兩者」（`/code` 與 `/releases/<tag>/<檔案>`）。
- Token 選填：公開 Repo 不填也可（每小時 60 次 API）；填了可提高到 5000 次；私人 Repo 請用[細粒度 Token](https://github.com/settings/personal-access-tokens) 並給 `Contents: Read`。
- 所有寫入操作（上傳、刪除、移動、建立資料夾、WebDAV PUT）回傳 `405`。

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

- **單次請求 100 MB**：Cloudflare Workers（Free / Pro 方案）請求本體上限為 100 MB。網頁上傳會自動分段，不受影響；但 **WebDAV PUT** 是單一請求，超過上限仍會失敗（請用網頁或 rclone 的分段功能）。
- **分段大小預設 8 MiB**：可在「設定」調整（S3 最小 5 MiB，最多 10,000 段，超過時自動加大）。
- **S3 複製 / 移動單檔上限 5 GB**：目前使用單次 `CopyObject`，超過 5 GB 的物件無法在伺服器端複製或移動。
- **WebDAV 快取以資料中心為單位**：Worker 使用 Cache API，快取只存在於各個 Cloudflare 資料中心，不同地區可能短暫看到舊內容（預設 TTL 30 秒，可在設定調整）。
- **`Depth: infinity` 視為 `1`**：PROPFIND 不支援無限深度，只回傳一層。
- **續傳需重新選擇檔案**：重新整理頁面後，瀏覽器無法自動取回檔案，需重新選擇同一個檔案才能從已上傳的分段繼續。
- **OneDrive / Google Drive**：上傳工作階段必須依序上傳，因此每個檔案只用 1 個並行分段；OneDrive 工作階段約數天後過期、Google 約 1 週。Google 文件／試算表／簡報（原生格式）無法直接下載。
- **Telegram**：官方 Bot API 單一分段 ≤ 20 MB；Bot 在私人對話只能刪除 48 小時內的訊息（請使用頻道）；刪除儲存空間不會刪除頻道內的訊息。
- **Discord**：每段 ≤ 10 MiB（未加成伺服器）；大量上傳會觸發速率限制（已自動退避，但速度有限）；刪除儲存空間不會刪除訊息。Telegram / Discord 的目錄結構只存在 D1，請定期備份 D1。
- **HuggingFace**：每次寫入都是一個 commit，不支援分段續傳；單檔上限見上方說明。Hub 也有 commit 頻率限制。
- **GitHub**：唯讀；Contents API 單一目錄最多回傳 1000 個項目、單檔 100 MB；Git LFS 檔案只會讀到指標檔；Releases 最多列出 1000 個。
- **驅動測試**：各雲端驅動以模擬的 API（mocked fetch）測試，請在正式使用前以自己的帳號做一次「測試連線」與小檔上傳。

## 開發

```bash
npm ci
npm run typecheck   # tsc（worker + node）與 vue-tsc
npm test            # 後端 vitest（S3 整合測試會自動啟動 moto：pip install 'moto[server]'）
npm run build       # 前端 + Node bundle
npx wrangler deploy --dry-run
```

## 授權

[MIT](./LICENSE)
