/**
 * Google Drive (Drive API v3).
 *
 * Auth: OAuth refresh token (admin UI helper flow, /api/oauth/gdrive/callback) or a service account
 * key (JWT bearer; share the root folder — preferably a shared drive — with the service account).
 * Paths are resolved to file IDs by walking from `rootFolderId` (cached briefly).
 * Uploads: multipart for small files, resumable upload sessions otherwise; EdgeDock multipart sessions
 * map 1:1 to a resumable session (256 KiB multiples, in order, status via `Content-Range: bytes * /N`).
 */
import { basename, dirname, joinPath, normalizePath } from '../lib/path';
import { mimeFromPath } from '../lib/mime';
import { BaseDriver, fetchBody, isHidden, rangeHeader } from './base';
import { chunksOf, ensureOk, fetchRetry, ProviderError, readUpTo } from './http';
import { authedFetch, RefreshTokenSource, ServiceAccountSource, type ServiceAccountKey, type TokenSource } from './oauth';
import type { ByteRange, DriverContext, DriverDefinition, FileEntry, MultipartSupport, ReadResult, UploadedPart, WriteBody, WriteOptions } from './types';

export interface GDriveConfig {
  authType?: 'oauth' | 'service_account';
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  serviceAccountJson?: string;
  /** domain-wide delegation: act as this user */
  impersonate?: string;
  rootFolderId?: string;
  chunkSizeMB?: number;
}

export const GDRIVE = {
  api: 'https://www.googleapis.com/drive/v3',
  upload: 'https://www.googleapis.com/upload/drive/v3',
  authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  scope: 'https://www.googleapis.com/auth/drive',
};
const FOLDER = 'application/vnd.google-apps.folder';
const UNIT = 256 * 1024;
const SIMPLE_MAX = 5 * 1024 * 1024;
const FIELDS = 'id,name,mimeType,size,modifiedTime,md5Checksum,parents';

interface GFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  md5Checksum?: string;
  parents?: string[];
}

function q(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

interface SessionToken {
  u: string;
  s: number;
  p: number;
}

export class GDriveDriver extends BaseDriver {
  readonly type = 'gdrive';
  readonly capabilities = { presign: false, multipart: true, rangeRead: true, partSizeMultiple: UNIT, sequentialParts: true, minPartSize: UNIT };
  readonly multipart: MultipartSupport;
  tokens: TokenSource;
  private fetchFn: typeof fetch;
  private rootId: string;
  private chunk: number;
  private cache = new Map<string, { f: GFile | null; at: number }>();

  constructor(
    private cfg: GDriveConfig,
    ctx: DriverContext,
    tokens?: TokenSource,
  ) {
    super();
    this.fetchFn = ctx.fetch;
    this.rootId = cfg.rootFolderId || 'root';
    this.chunk = Math.max(1, Math.floor(((Number(cfg.chunkSizeMB) || 8) * 1024 * 1024) / UNIT)) * UNIT;
    if (tokens) this.tokens = tokens;
    else if ((cfg.authType ?? (cfg.serviceAccountJson ? 'service_account' : 'oauth')) === 'service_account') {
      if (!cfg.serviceAccountJson) throw new Error('Service account JSON key is required');
      let key: ServiceAccountKey;
      try {
        key = JSON.parse(cfg.serviceAccountJson);
      } catch {
        throw new Error('Service account JSON is not valid JSON');
      }
      this.tokens = new ServiceAccountSource(key, GDRIVE.scope, ctx.fetch, ctx.env, ctx.storageId, cfg.impersonate || undefined);
    } else {
      if (!cfg.clientId) throw new Error('Google OAuth client id is required');
      this.tokens = new RefreshTokenSource({
        provider: 'gdrive',
        tokenUrl: GDRIVE.token,
        clientId: cfg.clientId,
        clientSecret: cfg.clientSecret,
        refreshToken: cfg.refreshToken,
        fetch: ctx.fetch,
        env: ctx.env,
        storageId: ctx.storageId,
      });
    }
    this.multipart = {
      create: (p, o) => this.sessionCreate(p, o.size ?? 0, o.contentType, o.partSize ?? this.chunk),
      uploadPart: (_p, id, n, body, size) => this.sessionPut(id, n, body, size),
      complete: (p, id) => this.sessionComplete(p, id),
      abort: (_p, id) => this.sessionAbort(id),
      listParts: (_p, id) => this.sessionParts(id),
    };
  }

  private api(url: string, init: () => RequestInit = () => ({})): Promise<Response> {
    return authedFetch(this.fetchFn, this.tokens, url, init);
  }

  private url(path: string, params: Record<string, string> = {}, base = GDRIVE.api): string {
    const u = new URL(base + path);
    u.searchParams.set('supportsAllDrives', 'true');
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
  }

  // ------------------------------------------------------------ path → id
  private async child(parentId: string, name: string): Promise<GFile | null> {
    const res = await this.api(
      this.url('/files', { q: `'${q(parentId)}' in parents and name = '${q(name)}' and trashed = false`, fields: `files(${FIELDS})`, pageSize: '10', includeItemsFromAllDrives: 'true' }),
    );
    await ensureOk(res, 'Google Drive lookup');
    const j = (await res.json()) as { files: GFile[] };
    // prefer folders when names collide (Drive allows duplicates)
    return j.files.find((f) => f.mimeType === FOLDER) ?? j.files[0] ?? null;
  }

  async resolve(path: string): Promise<GFile | null> {
    const p = normalizePath(path);
    if (p === '/') return { id: this.rootId, name: '', mimeType: FOLDER };
    const hit = this.cache.get(p);
    if (hit && Date.now() - hit.at < 15_000) return hit.f;
    const parent = await this.resolve(dirname(p));
    const f = parent && parent.mimeType === FOLDER ? await this.child(parent.id, basename(p)) : null;
    this.cache.set(p, { f, at: Date.now() });
    return f;
  }

  private forget(path: string) {
    const p = normalizePath(path);
    for (const k of [...this.cache.keys()]) if (k === p || k.startsWith(p + '/')) this.cache.delete(k);
  }

  private toEntry(dir: string, f: GFile): FileEntry {
    const isDir = f.mimeType === FOLDER;
    return {
      name: f.name,
      path: joinPath(dir, f.name),
      isDir,
      size: isDir ? 0 : Number(f.size ?? 0),
      modified: f.modifiedTime ? Date.parse(f.modifiedTime) : undefined,
      etag: f.md5Checksum,
      contentType: isDir ? undefined : f.mimeType || mimeFromPath(f.name),
    };
  }

  // ------------------------------------------------------------ read side
  async list(path: string): Promise<FileEntry[]> {
    const p = normalizePath(path);
    const dir = await this.resolve(p);
    if (!dir || dir.mimeType !== FOLDER) throw new ProviderError(404, `Not found: ${path}`);
    const out: FileEntry[] = [];
    let pageToken: string | undefined;
    do {
      const params: Record<string, string> = { q: `'${q(dir.id)}' in parents and trashed = false`, fields: `nextPageToken,files(${FIELDS})`, pageSize: '1000', includeItemsFromAllDrives: 'true' };
      if (pageToken) params.pageToken = pageToken;
      const res = await ensureOk(await this.api(this.url('/files', params)), 'Google Drive list');
      const j = (await res.json()) as { files: GFile[]; nextPageToken?: string };
      for (const f of j.files) {
        if (p === '/' && isHidden(f.name)) continue;
        out.push(this.toEntry(p, f));
        this.cache.set(joinPath(p, f.name), { f, at: Date.now() });
      }
      pageToken = j.nextPageToken;
    } while (pageToken);
    return out;
  }

  async stat(path: string): Promise<FileEntry | null> {
    const p = normalizePath(path);
    const f = await this.resolve(p);
    if (!f) return null;
    if (p === '/') return { name: '', path: '/', isDir: true, size: 0 };
    return { ...this.toEntry(dirname(p), f), path: p };
  }

  async read(path: string, opts: { range?: ByteRange } = {}): Promise<ReadResult> {
    const f = await this.resolve(path);
    if (!f || f.mimeType === FOLDER) throw new ProviderError(404, `Not found: ${path}`);
    if (f.mimeType.startsWith('application/vnd.google-apps.')) throw new ProviderError(415, 'Google Docs/Sheets/Slides have no binary content; download them as an export in Google Drive');
    const size = Number(f.size ?? 0);
    const headers: Record<string, string> = {};
    if (opts.range) headers.range = rangeHeader(opts.range);
    const res = await ensureOk(await this.api(this.url(`/files/${encodeURIComponent(f.id)}`, { alt: 'media' }), () => ({ headers })), 'Google Drive download');
    const r: ReadResult = { body: res.body, size, contentType: f.mimeType, etag: f.md5Checksum, modified: f.modifiedTime ? Date.parse(f.modifiedTime) : undefined };
    if (opts.range) r.range = { start: opts.range.start, end: Math.min(opts.range.end ?? size - 1, size - 1) };
    return r;
  }

  // ------------------------------------------------------------ write side
  private async ensureDir(path: string): Promise<GFile> {
    const p = normalizePath(path);
    const ex = await this.resolve(p);
    if (ex) {
      if (ex.mimeType !== FOLDER) throw new ProviderError(409, `${p} is a file`);
      return ex;
    }
    const parent = await this.ensureDir(dirname(p));
    const res = await ensureOk(
      await this.api(this.url('/files', { fields: FIELDS }), () => ({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: basename(p), mimeType: FOLDER, parents: [parent.id] }),
      })),
      'Google Drive mkdir',
    );
    const f = (await res.json()) as GFile;
    this.cache.set(p, { f, at: Date.now() });
    return f;
  }

  async mkdir(path: string): Promise<void> {
    if (normalizePath(path) !== '/') await this.ensureDir(path);
  }

  async write(path: string, body: WriteBody, opts: WriteOptions = {}): Promise<void> {
    const p = normalizePath(path);
    const ct = opts.contentType || mimeFromPath(p);
    const size = opts.size;
    if (size !== undefined && size <= SIMPLE_MAX) {
      const bytes = await readUpTo(body as ReadableStream<Uint8Array>, SIMPLE_MAX);
      const parent = await this.ensureDir(dirname(p));
      const existing = await this.resolve(p);
      const boundary = 'edgedock' + crypto.randomUUID().replace(/-/g, '');
      const meta = existing ? { name: basename(p) } : { name: basename(p), parents: [parent.id] };
      const head = new TextEncoder().encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${ct}\r\n\r\n`);
      const tail = new TextEncoder().encode(`\r\n--${boundary}--`);
      const all = new Uint8Array(head.length + bytes.length + tail.length);
      all.set(head);
      all.set(bytes, head.length);
      all.set(tail, head.length + bytes.length);
      const url = existing ? this.url(`/files/${encodeURIComponent(existing.id)}`, { uploadType: 'multipart', fields: FIELDS }, GDRIVE.upload) : this.url('/files', { uploadType: 'multipart', fields: FIELDS }, GDRIVE.upload);
      const res = await ensureOk(
        await this.api(url, () => ({ method: existing ? 'PATCH' : 'POST', headers: { 'content-type': `multipart/related; boundary=${boundary}` }, body: all as BodyInit })),
        'Google Drive upload',
      );
      this.cache.set(p, { f: (await res.json()) as GFile, at: Date.now() });
      return;
    }
    const src = typeof body === 'string' ? new TextEncoder().encode(body) : body instanceof ArrayBuffer ? new Uint8Array(body) : body;
    const known = size ?? (src instanceof Uint8Array ? src.byteLength : undefined);
    if (known === undefined) throw new ProviderError(411, 'Google Drive upload needs a known size');
    const token = await this.sessionCreate(p, known, ct, this.chunk);
    let n = 0;
    for await (const piece of chunksOf(src, this.chunk)) {
      if (!piece.byteLength && known > 0) break;
      await this.sessionPut(token, ++n, piece, piece.byteLength);
    }
  }

  private async sessionCreate(path: string, size: number, contentType: string | undefined, partSize: number): Promise<string> {
    const p = normalizePath(path);
    const parent = await this.ensureDir(dirname(p));
    const existing = await this.resolve(p);
    const url = existing ? this.url(`/files/${encodeURIComponent(existing.id)}`, { uploadType: 'resumable', fields: FIELDS }, GDRIVE.upload) : this.url('/files', { uploadType: 'resumable', fields: FIELDS }, GDRIVE.upload);
    const res = await ensureOk(
      await this.api(url, () => ({
        method: existing ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': contentType || mimeFromPath(p), 'x-upload-content-length': String(size) },
        body: JSON.stringify(existing ? { name: basename(p) } : { name: basename(p), parents: [parent.id] }),
      })),
      'Google Drive resumable session',
    );
    const u = res.headers.get('location');
    await res.body?.cancel().catch(() => {});
    if (!u) throw new ProviderError(502, 'Google Drive returned no upload session URL');
    this.forget(p);
    return btoa(JSON.stringify({ u, s: size, p: partSize } satisfies SessionToken));
  }

  private parse(id: string): SessionToken {
    return JSON.parse(atob(id)) as SessionToken;
  }

  private async sessionPut(id: string, n: number, body: WriteBody, size: number): Promise<{ etag: string }> {
    const t = this.parse(id);
    const start = (n - 1) * t.p;
    const range = size === 0 ? `bytes */${t.s}` : `bytes ${start}-${start + size - 1}/${t.s}`;
    const replayable = body instanceof ReadableStream ? null : body;
    const init = (): RequestInit => {
      const fb = fetchBody(replayable ?? body, size);
      return { method: 'PUT', headers: { ...fb.headers, 'content-range': range }, body: fb.body, ...fb.init } as RequestInit;
    };
    // session URIs are authorized by the URI itself, but Google accepts (and documents) the bearer token too
    let res: Response;
    if (replayable) res = await this.api(t.u, init);
    else {
      const once = init();
      res = await this.fetchFn(t.u, { ...once, headers: { ...(once.headers as Record<string, string>), authorization: `Bearer ${await this.tokens.get()}` } });
    }
    // 308 Resume Incomplete = chunk accepted, more expected
    await ensureOk(res, `Google Drive upload chunk ${n}`, [308]);
    await res.body?.cancel().catch(() => {});
    return { etag: `gd-${n}` };
  }

  private async sessionParts(id: string): Promise<UploadedPart[]> {
    const t = this.parse(id);
    const res = await this.api(t.u, () => ({ method: 'PUT', headers: { 'content-range': `bytes */${t.s}`, 'content-length': '0' } }));
    await res.body?.cancel().catch(() => {});
    if (res.status === 404 || res.status === 410) return [];
    let received = 0;
    if (res.status === 200 || res.status === 201) received = t.s;
    else if (res.status === 308) {
      const r = res.headers.get('range');
      received = r ? Number(r.split('-')[1]) + 1 : 0;
    } else await ensureOk(res, 'Google Drive session status');
    const full = received >= t.s ? Math.ceil(t.s / t.p) : Math.floor(received / t.p);
    return Array.from({ length: full }, (_, i) => ({ partNumber: i + 1, etag: `gd-${i + 1}`, size: Math.min(t.p, t.s - i * t.p) }));
  }

  private async sessionComplete(path: string, id: string): Promise<void> {
    const t = this.parse(id);
    if (t.s === 0) await this.sessionPut(id, 1, new Uint8Array(0), 0);
    this.forget(path);
    const st = await this.stat(path);
    if (!st || st.size !== t.s) throw new ProviderError(409, `Google Drive upload incomplete (${st?.size ?? 0}/${t.s} bytes)`);
  }

  private async sessionAbort(id: string): Promise<void> {
    const t = this.parse(id);
    const res = await this.fetchFn(t.u, { method: 'DELETE' });
    await res.body?.cancel().catch(() => {});
  }

  async delete(path: string): Promise<void> {
    const f = await this.resolve(path);
    if (!f || normalizePath(path) === '/') return;
    const res = await this.api(this.url(`/files/${encodeURIComponent(f.id)}`), () => ({ method: 'DELETE' }));
    await ensureOk(res, 'Google Drive delete', [404]);
    this.forget(path);
  }

  async rename(from: string, to: string): Promise<void> {
    const f = await this.resolve(from);
    if (!f) throw new ProviderError(404, `Not found: ${from}`);
    const target = await this.resolve(to);
    if (target && target.id !== f.id) await this.delete(to);
    const newParent = await this.ensureDir(dirname(normalizePath(to)));
    const oldParent = await this.resolve(dirname(normalizePath(from)));
    const params: Record<string, string> = { fields: FIELDS };
    if (oldParent && oldParent.id !== newParent.id) {
      params.addParents = newParent.id;
      params.removeParents = oldParent.id;
    }
    await ensureOk(
      await this.api(this.url(`/files/${encodeURIComponent(f.id)}`, params), () => ({ method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: basename(normalizePath(to)) }) })),
      'Google Drive move',
    );
    this.forget(from);
    this.forget(to);
  }

  async copy(from: string, to: string): Promise<void> {
    const f = await this.resolve(from);
    if (!f) throw new ProviderError(404, `Not found: ${from}`);
    if (f.mimeType === FOLDER) {
      await this.ensureDir(to);
      for (const c of await this.list(from)) await this.copy(c.path, joinPath(to, c.name));
      return;
    }
    const parent = await this.ensureDir(dirname(normalizePath(to)));
    if (await this.resolve(to)) await this.delete(to);
    await ensureOk(
      await this.api(this.url(`/files/${encodeURIComponent(f.id)}/copy`, { fields: FIELDS }), () => ({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: basename(normalizePath(to)), parents: [parent.id] }),
      })),
      'Google Drive copy',
    );
    this.forget(to);
  }

  async test(): Promise<void> {
    const res = await this.api(this.url(`/files/${encodeURIComponent(this.rootId)}`, { fields: 'id,mimeType' }));
    await ensureOk(res, 'Google Drive');
  }
}

export const gdriveDefinition: DriverDefinition = {
  type: 'gdrive',
  label: 'Google Drive',
  runtimes: ['workers', 'node'],
  oauth: 'gdrive',
  notes:
    'OAuth: Google Cloud console → APIs & Services → enable "Google Drive API" → Credentials → OAuth client ID (Web application) with the redirect URI below; then press Authorize. Service account: create a key (JSON), paste it, and share the root folder (or a shared drive) with the service account e-mail.',
  notesZh:
    'OAuth：Google Cloud 主控台 → API 和服務 → 啟用「Google Drive API」→ 憑證 → 建立 OAuth 用戶端 ID（網頁應用程式），授權重新導向 URI 填下方網址，再按「授權」。服務帳戶：建立 JSON 金鑰貼上，並把根資料夾（建議共用雲端硬碟）分享給服務帳戶的電子郵件。',
  fields: [
    {
      key: 'authType',
      label: 'Authentication',
      labelZh: '驗證方式',
      type: 'select',
      default: 'oauth',
      options: [
        { value: 'oauth', label: 'OAuth (refresh token)' },
        { value: 'service_account', label: 'Service account (JSON key)' },
      ],
    },
    { key: 'clientId', label: 'Client ID', labelZh: 'OAuth 用戶端 ID', type: 'text' },
    { key: 'clientSecret', label: 'Client secret', labelZh: 'OAuth 用戶端密碼', type: 'password', secret: true },
    { key: 'refreshToken', label: 'Refresh token', labelZh: 'Refresh Token（可用下方授權按鈕自動取得）', type: 'password', secret: true },
    { key: 'serviceAccountJson', label: 'Service account JSON key', labelZh: '服務帳戶 JSON 金鑰', type: 'textarea', secret: true },
    { key: 'impersonate', label: 'Impersonate user (domain-wide delegation)', labelZh: '代表使用者（網域委派，選填）', type: 'text' },
    { key: 'rootFolderId', label: 'Root folder ID', labelZh: '根資料夾 ID（root = 我的雲端硬碟；或資料夾／共用雲端硬碟 ID）', type: 'text', default: 'root' },
    { key: 'chunkSizeMB', label: 'Upload chunk (MiB)', labelZh: '上傳分段大小（MiB，自動對齊 256 KiB）', type: 'number', default: 8 },
  ],
  create: (config, ctx) => new GDriveDriver(config as unknown as GDriveConfig, ctx),
};
