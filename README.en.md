# EdgeDock

> Serverless file manager & Markdown sharing on Cloudflare Workers.

English · [正體中文](./README.md)

EdgeDock mounts several storage backends (S3-compatible, WebDAV, local disk) into one tree and gives you a web file manager, in-browser previews, a Markdown editor with share links, and a WebDAV server. The backend is a single [Hono](https://hono.dev/) codebase that runs on Cloudflare Workers (D1) or Node.js / Docker (SQLite); the frontend is a Vue 3 + Vite PWA.

The Chinese README is the primary, more detailed document.

## Features

- Storage mounts: S3-compatible (R2, B2, AWS S3, OSS, COS, MinIO…), WebDAV, local folders (Node/Docker only). Credentials are AES-GCM encrypted at rest.
- File operations, filename search (scheduled index).
- Smart uploads: presigned direct PUT → streaming through the Worker → resumable multipart.
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
| `CORS_ORIGINS` | Comma-separated allowed origins (`*` = any, empty = same origin). |
| `JWT_TTL_HOURS` | Session lifetime, default 168. |
| `DATA_DIR`, `DB_FILE`, `STATIC_DIR`, `PORT` | Node/Docker only. |
| `VITE_API_BASE`, `VITE_VDITOR_CDN` | Frontend build-time. |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | GitHub Actions. |

**Bucket CORS** for direct uploads: allow `PUT`/`GET`/`HEAD` from your site origin, allowed headers `*`, and **expose `ETag`**.

**WebDAV:** mount `https://your-host/dav/` with the admin credentials, or any username plus an API key (`edk_…`) as the password.

## Known limitations

- 100 MB request body limit per Worker request (applies to proxied uploads and WebDAV PUT).
- Default multipart part size 8 MiB (configurable).
- Server-side S3 copy/move is limited to 5 GB per object.
- WebDAV cache is per Cloudflare datacenter.
- `Depth: infinity` is treated as `1`.
- Resuming an upload after a reload requires re-selecting the same file.

## Roadmap (Phase 2)

OneDrive, Google Drive, Telegram, Discord Bot, HuggingFace, GitHub API / Releases (read-only).

## License

[MIT](./LICENSE)
