# EdgeDock

> Serverless file manager & Markdown sharing on Cloudflare Workers.

English · [正體中文](./README.md)

EdgeDock mounts several storage backends (S3-compatible, WebDAV, OneDrive, Google Drive, Telegram, Discord, HuggingFace, GitHub, local disk) into one tree and gives you a web file manager, in-browser previews, a Markdown editor with share links, and a WebDAV server. The backend is a single [Hono](https://hono.dev/) codebase that runs on Cloudflare Workers (D1) or Node.js / Docker (SQLite); the frontend is a Vue 3 + Vite PWA.

The Chinese README is the primary, more detailed document.

## Features

- Storage mounts: S3-compatible (R2, B2, AWS S3, OSS, COS, MinIO…), WebDAV, OneDrive / SharePoint, Google Drive, Telegram, Discord, HuggingFace Dataset, GitHub (read-only), local folders (Node/Docker only). Credentials and OAuth tokens are AES-GCM encrypted at rest.
- File operations, filename search (scheduled index).
- Reliable uploads: presigned direct PUT (with automatic proxy fallback on CORS errors) → small streaming PUTs through the Worker → chunked, resumable multipart for everything else, with per-part retry, MD5 checks and resume after reload.
- Previews: images, video, audio, PDF, DOCX, spreadsheets, Markdown, JSON, EPUB, ~80 code languages, plain text, plus a configurable external previewer. See [`web/src/lib/fileTypes.ts`](./web/src/lib/fileTypes.ts).
- Vditor Markdown editor (self-hosted assets, KaTeX, Mermaid), export to PDF / image / Word.
- Share links with password, expiry and view limits; `/raw/` direct links.
- API keys (read / read-write, path prefix, expiry), usable as WebDAV passwords.
- WebDAV server at `/dav`.
- Cron cleanup and Workflows for indexing/sync. Installable PWA, zh-TW / English UI.

## Architecture

- **Integrated (recommended):** one Worker serves `/api/*`, `/raw/*`, `/dav/*` and the SPA via Workers Static Assets. Same origin, no CORS.
- **Split:** backend on Workers or Docker, frontend on Vercel / Pages built with `VITE_API_BASE`, backend allows it via `CORS_ORIGINS`.

## Deploy

1. **GitHub Actions:** add repo secrets `CLOUDFLARE_API_TOKEN` (Workers + D1 edit), `CLOUDFLARE_ACCOUNT_ID`, and `ENCRYPTION_KEY` (optional: `JWT_SECRET`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`), then push to `main` or run the *Deploy* workflow. It creates the D1 database if missing, patches `database_id`, applies migrations and deploys.
2. **Wrangler CLI:**
   ```bash
   npm ci && npx wrangler login
   npx wrangler d1 create edgedock   # paste database_id into wrangler.toml
   npm run db:migrate:remote
   npx wrangler secret put ENCRYPTION_KEY
   npm run deploy
   ```
3. **Docker Compose:** `ENCRYPTION_KEY=$(openssl rand -base64 32) docker compose up -d --build`, then open http://localhost:8080. Data lives in the `edgedock-data` volume.
4. **Vercel / Pages (frontend only):** root `web`, build `npm run build`, output `dist`, set `VITE_API_BASE`. `web/vercel.json` handles SPA rewrites.

## Configuration

| Name | Notes |
| --- | --- |
| `ENCRYPTION_KEY` | **Required.** Encrypts storage credentials. Changing it makes saved storages unreadable. |
| `JWT_SECRET` | Optional; derived from `ENCRYPTION_KEY` if unset. |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | Optional initial admin; otherwise first-run setup in the UI. |
| `CORS_ORIGINS` | Comma-separated allowed origins for `/api`, `/raw`, `/dav`: exact origins, `*`, `https://*.example.com`, `http://localhost:*`. Empty = same origin only. |
| `CORS_CREDENTIALS` | `true`/`false` for `Access-Control-Allow-Credentials` (default true for listed origins, false for `*`). |
| `CORS_MAX_AGE` | Preflight cache seconds (default 86400). |
| `PUBLIC_URL` | Public base URL (OAuth redirect URIs, bucket CORS origin); defaults to the request origin. |
| `JWT_TTL_HOURS` | Session lifetime, default 168. |
| `DATA_DIR`, `DB_FILE`, `STATIC_DIR`, `PORT` | Node/Docker only. |
| `VITE_API_BASE`, `VITE_VDITOR_CDN` | Frontend build-time. |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | GitHub Actions. |

## CORS

- **Server:** preflights (`OPTIONS` + `Access-Control-Request-Method`) are answered with `204` before authentication, with `Access-Control-Max-Age`, all HTTP + WebDAV methods and the requested headers. A plain WebDAV `OPTIONS` still reaches the DAV handler (`DAV:` / `Allow:`). Responses (errors included) expose `ETag`, `Content-Range`, `Content-Length`, `Accept-Ranges`, `Location`, `DAV`, `Lock-Token`, `Retry-After`, and set `Vary: Origin`.
- **S3 bucket CORS:** in *Storages → edit an S3 storage*, **Configure CORS** calls `PutBucketCors` (R2 S3 API, B2 S3, AWS S3, OSS, COS) for your site origin (methods GET/PUT/POST/HEAD/DELETE, headers `*`, expose `ETag`; other rules are kept). **Check CORS** reads `GetBucketCors`, simulates the browser preflight server-side and then really PUTs a tiny probe object from the browser, showing per-provider manual steps when automatic setup is not permitted (R2 needs an *Admin Read & Write* token, B2 `writeBuckets`, AWS `s3:PutBucketCORS`; MinIO only supports global CORS via `MINIO_API_CORS_ALLOW_ORIGIN`).
- **Fallback:** if a direct PUT fails like a CORS error, the browser switches to the Worker proxy / chunked upload immediately and remembers it for that storage (7 days, cleared by a successful check).

## Upload reliability

- Chunking for every driver: native S3 multipart, OneDrive / Google Drive upload sessions, one message per part for Telegram / Discord, emulated parts (temp parts → streamed concatenation) for WebDAV / local.
- Per-part retry (default 5 attempts) with exponential backoff + jitter, `Retry-After`, per-part timeout with stall detection, cancel.
- Adaptive concurrency (default 3 per file, halves on errors); providers that need in-order parts (OneDrive, Google Drive) use 1.
- Resume: session in D1 + browser state in IndexedDB (fingerprint = name + size + lastModified + SHA-256 of the first/last 64 KiB). Pauses while offline and continues on `online`; after a reload re-select the file to continue. Uploaded parts are verified against the provider (ListParts / nextExpectedRanges / status probe / temp parts) before being skipped.
- Worker proxy requests never exceed `proxyMaxChunkMB` (default 50 MiB, max 95); bodies are streamed, never buffered; upstream errors are classified retriable (`503` + `X-EdgeDock-Retriable`) vs not.
- Integrity: MD5 per part (`Content-MD5`, verified by S3 / by the Worker while streaming / against the part ETag for direct uploads), final size and S3 multipart-ETag verification. Cron aborts expired sessions and orphaned multipart uploads.
- UI: progress, speed, ETA, retry count, pause / resume / cancel; messages in 正體中文 or English.

## Storage drivers

- **OneDrive / SharePoint:** Entra ID → App registrations → new app; platform *Web* with redirect URI `https://your-host/api/oauth/onedrive/callback`; create a client secret; delegated permissions `Files.ReadWrite.All` + `offline_access`. Enter Client ID / secret (tenant for business), save, press **Authorize**. Optional drive id (SharePoint libraries), root folder, 21Vianet cloud.
- **Google Drive:** Cloud Console → enable *Google Drive API* → OAuth client (Web) with redirect URI `https://your-host/api/oauth/gdrive/callback` → enter Client ID / secret → **Authorize** (publish the consent screen to avoid 7-day refresh tokens). Or paste a **service account** JSON key and share a folder / shared drive with the service account; set its id as *Root folder ID*.
- **Telegram:** create a bot with @BotFather, make it admin of a private channel (post + delete), use the chat id (`-100…`). Parts ≤ 20 MB (Bot API `getFile` limit), reassembled on read with Range; tree in D1. A self-hosted Bot API server lifts the limit.
- **Discord:** Developer Portal → Bot token; invite with View Channel, Send Messages, Attach Files, Read Message History (+ Manage Messages to delete); copy the channel id (Developer Mode). Parts default 8 MiB (bots: 10 MiB per message); expiring CDN URLs are refreshed via the API.
- **HuggingFace Dataset:** token from huggingface.co/settings/tokens (`write` to upload); Dataset repos only; repo `user/name`, branch. Each write is one commit, LFS handled automatically (moves of LFS files are pointer-only).
  - **Large files (≥ 2 GB):** same flow as huggingface.js `commit()` / `huggingface_hub`: the browser streams the file through SHA-256 in a Web Worker (hash-wasm; "hashing" in the upload panel, cached in IndexedDB) → the server calls `preupload` (must be LFS) and the LFS batch API (`transfers: ["basic","multipart"]`, `hash_algo: "sha_256"`); an object the Hub already has is just committed → for `chunk_size` multipart the browser PUTs every part **straight to the presigned S3/CDN URLs** (one batch call signs all parts; per-part retry/backoff/timeouts/pause/offline wait, part MD5 checked against the ETag); expired URLs (403) trigger a fresh batch and only the remaining parts are sent → if the browser can't reach the URLs (CORS/network error) parts are streamed through the Worker instead (under the proxy cap) and that is remembered per storage → the server POSTs `{oid, parts:[{partNumber, etag}]}` to the completion URL and commits `lfsFile`.
  - **Resume:** the session (oid, size, chunk size, finished parts + ETags) is kept in D1 and IndexedDB; after a reload re-select the file, the fingerprint and SHA-256 are checked and only missing parts are uploaded (if the Hub started a new multipart upload, all parts are re-sent).
  - **Limits:** *Max upload size* defaults to 51200 MiB (50 GiB) and is configurable; the Hub rejects LFS files over 50 GB and recommends staying under ~20 GB per file. Small files below the multipart threshold still go through the Worker in one request (regular files inline, binaries via LFS basic). **WebDAV PUT** and server-side copies to HuggingFace are single requests buffered in the Worker: ≤ 100 MiB (and the Workers 100 MB body limit).
- **GitHub (read-only):** owner + repo, show contents, releases (`/<tag>/<asset>`) or both (`/code`, `/releases`). Token optional (60 → 5000 requests/hour; fine-grained `Contents: Read` for private repos). All writes return `405`.

**WebDAV:** mount `https://your-host/dav/` with the admin credentials, or any username plus an API key (`edk_…`) as the password.

## Known limitations

- 100 MB request body limit per Worker request: web uploads are chunked automatically, but a single WebDAV PUT above the limit still fails.
- Default multipart part size 8 MiB (configurable).
- Server-side S3 copy/move is limited to 5 GB per object.
- WebDAV cache is per Cloudflare datacenter.
- `Depth: infinity` is treated as `1`.
- Resuming an upload after a reload requires re-selecting the same file.
- OneDrive / Google Drive sessions are sequential (1 part in flight per file). Native Google Docs can't be downloaded.
- Telegram parts ≤ 20 MB on the public Bot API; bots can only delete private-chat messages for 48 h. Telegram / Discord trees live only in D1 — back it up. Deleting such a storage keeps the messages.
- Discord parts ≤ 10 MiB on non-boosted servers; heavy uploads hit rate limits (handled with backoff).
- HuggingFace: Dataset repos only; one commit per write (the Hub rate-limits commits). Browser uploads of big files are direct and resumable but hash the whole file first; WebDAV PUT is limited to 100 MiB.
- GitHub: read-only; Contents API lists ≤ 1000 entries per directory and serves ≤ 100 MB per file; Git LFS files return their pointer.
- Cloud drivers are tested against mocked provider APIs; do a *Test* and a small upload with your own account first.

## Development

```bash
npm ci
npm run typecheck   # tsc (worker + node) and vue-tsc
npm test            # backend vitest (S3 integration tests start moto: pip install 'moto[server]')
npm run build
npx wrangler deploy --dry-run
```

## License

[MIT](./LICENSE)
