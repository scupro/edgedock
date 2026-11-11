/**
 * OneDrive / SharePoint via Microsoft Graph (personal + business).
 *
 * Auth: OAuth2 authorization code → refresh token (admin UI helper flow, /api/oauth/onedrive/callback).
 * Uploads: small files with a simple PUT, anything else with an upload session; EdgeDock multipart
 * sessions map 1:1 to Graph upload sessions (parts are 320 KiB multiples, uploaded in order, resumable
 * via nextExpectedRanges). Browser uploads go direct: the server creates the session and hands the
 * pre-authenticated uploadUrl to the browser (`presignPart`: same URL + Content-Range per part, never an
 * Authorization header); the browser PUTs the parts in order, and the Worker proxies a part only as a fallback.
 */
import { basename, dirname, joinPath, normalizePath } from '../lib/path';
import { mimeFromPath } from '../lib/mime';
import { BaseDriver, fetchBody, isHidden, rangeHeader } from './base';
import { chunksOf, ensureOk, fetchRetry, ProviderError, readUpTo, sliceStream } from './http';
import { authedFetch, RefreshTokenSource, type TokenSource } from './oauth';
import type { ByteRange, DriverContext, DriverDefinition, FileEntry, MultipartSupport, ReadResult, UploadedPart, WriteBody, WriteOptions } from './types';

export interface OneDriveConfig {
  clientId: string;
  clientSecret?: string;
  refreshToken?: string;
  /** personal | business */
  driveType?: string;
  /** common / consumers / organizations / <tenant id> */
  tenant?: string;
  /** optional: a specific drive (SharePoint document library, another user's drive) */
  driveId?: string;
  root?: string;
  /** global | cn (21Vianet) */
  region?: string;
  chunkSizeMB?: number;
}

const CHUNK_UNIT = 320 * 1024;
const SIMPLE_MAX = 4 * 1024 * 1024;

export function onedriveEndpoints(cfg: Pick<OneDriveConfig, 'region' | 'tenant' | 'driveType'>) {
  const cn = cfg.region === 'cn';
  const tenant = cfg.tenant || (cfg.driveType === 'business' ? 'organizations' : 'common');
  const login = cn ? 'https://login.chinacloudapi.cn' : 'https://login.microsoftonline.com';
  return {
    graph: cn ? 'https://microsoftgraph.chinacloudapi.cn/v1.0' : 'https://graph.microsoft.com/v1.0',
    authorize: `${login}/${tenant}/oauth2/v2.0/authorize`,
    token: `${login}/${tenant}/oauth2/v2.0/token`,
    scope: cn ? 'offline_access https://microsoftgraph.chinacloudapi.cn/Files.ReadWrite.All' : 'offline_access Files.ReadWrite.All',
  };
}

function encPath(p: string): string {
  return p
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
}

interface GraphItem {
  id: string;
  name: string;
  size?: number;
  folder?: unknown;
  file?: { mimeType?: string };
  lastModifiedDateTime?: string;
  eTag?: string;
  '@microsoft.graph.downloadUrl'?: string;
  parentReference?: { driveId?: string; id?: string };
}

interface SessionToken {
  u: string;
  s: number;
  p: number;
}

export class OneDriveDriver extends BaseDriver {
  readonly type = 'onedrive';
  readonly capabilities = {
    presign: false,
    multipart: true,
    rangeRead: true,
    partSizeMultiple: CHUNK_UNIT,
    sequentialParts: true,
    directParts: true,
    minPartSize: CHUNK_UNIT,
    maxPartSize: 60 * 1024 * 1024 - ((60 * 1024 * 1024) % CHUNK_UNIT),
  };
  readonly multipart: MultipartSupport;
  private ep: ReturnType<typeof onedriveEndpoints>;
  private root: string;
  private chunk: number;
  private fetchFn: typeof fetch;
  tokens: TokenSource;

  constructor(
    private cfg: OneDriveConfig,
    ctx: DriverContext,
    tokens?: TokenSource,
  ) {
    super();
    if (!cfg.clientId && !tokens) throw new Error('OneDrive client id is required');
    this.ep = onedriveEndpoints(cfg);
    this.root = normalizePath(cfg.root || '/');
    const mb = Number(cfg.chunkSizeMB) || 10;
    this.chunk = Math.max(1, Math.floor((mb * 1024 * 1024) / CHUNK_UNIT)) * CHUNK_UNIT;
    this.fetchFn = ctx.fetch;
    this.tokens =
      tokens ??
      new RefreshTokenSource({
        provider: 'onedrive',
        tokenUrl: this.ep.token,
        clientId: cfg.clientId,
        clientSecret: cfg.clientSecret,
        refreshToken: cfg.refreshToken,
        scope: this.ep.scope,
        fetch: ctx.fetch,
        env: ctx.env,
        storageId: ctx.storageId,
      });
    this.multipart = {
      create: (p, o) => this.sessionCreate(p, o.size ?? 0, o.partSize ?? this.chunk),
      presignPart: async (_p, id, n, expiresIn) => {
        const t = this.parseToken(id);
        const start = (n - 1) * t.p;
        const end = Math.min(t.s, start + t.p) - 1;
        // pre-authenticated upload URL: the browser must NOT send an Authorization header to it
        return { url: t.u, method: 'PUT', headers: { 'content-range': `bytes ${start}-${end}/${t.s}` }, expiresIn };
      },
      uploadPart: (p, id, n, body, size) => this.sessionPut(id, n, body, size),
      complete: (p, id, parts) => this.sessionComplete(p, id, parts),
      abort: (_p, id) => this.sessionAbort(id),
      listParts: (_p, id) => this.sessionParts(id),
    };
  }

  // ------------------------------------------------------------ addressing
  private drive(): string {
    return `${this.ep.graph}${this.cfg.driveId ? `/drives/${encodeURIComponent(this.cfg.driveId)}` : '/me/drive'}`;
  }
  private full(p: string): string {
    return joinPath(this.root, p);
  }
  /** item URL; `suffix` like "/children" or ":/content" handled for both root and path forms */
  itemUrl(p: string, suffix = ''): string {
    const f = this.full(p);
    if (f === '/') return `${this.drive()}/root${suffix.startsWith(':') ? suffix.slice(1) : suffix}`;
    if (suffix.startsWith(':')) return `${this.drive()}/root:${encPath(f)}${suffix}`;
    return `${this.drive()}/root:${encPath(f)}:${suffix}`;
  }

  private api(url: string, init: () => RequestInit = () => ({})): Promise<Response> {
    return authedFetch(this.fetchFn, this.tokens, url, init);
  }

  private toEntry(dirPath: string, it: GraphItem): FileEntry {
    return {
      name: it.name,
      path: joinPath(dirPath, it.name),
      isDir: !!it.folder,
      size: it.folder ? 0 : Number(it.size ?? 0),
      modified: it.lastModifiedDateTime ? Date.parse(it.lastModifiedDateTime) : undefined,
      etag: it.eTag,
      contentType: it.file?.mimeType ?? (it.folder ? undefined : mimeFromPath(it.name)),
    };
  }

  // ------------------------------------------------------------ read side
  async list(path: string): Promise<FileEntry[]> {
    const p = normalizePath(path);
    const out: FileEntry[] = [];
    let url: string | undefined = this.itemUrl(p, '/children') + '?$top=1000&$select=id,name,size,folder,file,lastModifiedDateTime,eTag';
    while (url) {
      const res = await ensureOk(await this.api(url), 'OneDrive list');
      const j = (await res.json()) as { value: GraphItem[]; '@odata.nextLink'?: string };
      for (const it of j.value) if (!(p === '/' && isHidden(it.name))) out.push(this.toEntry(p, it));
      url = j['@odata.nextLink'];
    }
    return out;
  }

  private async item(path: string): Promise<GraphItem | null> {
    const res = await this.api(this.itemUrl(path));
    if (res.status === 404) return null;
    await ensureOk(res, 'OneDrive stat');
    return (await res.json()) as GraphItem;
  }

  async stat(path: string): Promise<FileEntry | null> {
    const p = normalizePath(path);
    const it = await this.item(p);
    if (!it) return null;
    const e = this.toEntry(dirname(p), it);
    return { ...e, name: p === '/' ? '' : e.name, path: p };
  }

  async read(path: string, opts: { range?: ByteRange } = {}): Promise<ReadResult> {
    const it = await this.item(path);
    if (!it || it.folder) throw new ProviderError(404, `Not found: ${path}`);
    const size = Number(it.size ?? 0);
    const dl = it['@microsoft.graph.downloadUrl'];
    // pre-authenticated download URL: no bearer token (it is short lived, fetched per read)
    const headers: Record<string, string> = {};
    if (opts.range) headers.range = rangeHeader(opts.range);
    const res = dl ? await fetchRetry(this.fetchFn, dl, () => ({ headers })) : await this.api(this.itemUrl(path, ':/content'), () => ({ headers }));
    await ensureOk(res, 'OneDrive download');
    const ct = it.file?.mimeType ?? mimeFromPath(path);
    if (!opts.range) return { body: res.body, size, contentType: ct, etag: it.eTag, modified: it.lastModifiedDateTime ? Date.parse(it.lastModifiedDateTime) : undefined };
    const end = Math.min(opts.range.end ?? size - 1, size - 1);
    const body = res.status === 206 ? res.body : res.body ? sliceStream(res.body, opts.range.start, end) : null;
    return { body, size, contentType: ct, etag: it.eTag, range: { start: opts.range.start, end } };
  }

  // ------------------------------------------------------------ write side
  async write(path: string, body: WriteBody, opts: WriteOptions = {}): Promise<void> {
    const p = normalizePath(path);
    const size = opts.size;
    if (size !== undefined && size <= SIMPLE_MAX) {
      const bytes = await readUpTo(body as ReadableStream<Uint8Array>, SIMPLE_MAX);
      const res = await this.api(this.itemUrl(p, ':/content') + '?@microsoft.graph.conflictBehavior=replace', () => ({
        method: 'PUT',
        headers: { 'content-type': opts.contentType || 'application/octet-stream' },
        body: bytes as BodyInit,
      }));
      await ensureOk(res, 'OneDrive upload');
      return;
    }
    // upload session; stream the body in chunks (one chunk buffered at a time, retried individually)
    const src = typeof body === 'string' ? new TextEncoder().encode(body) : body instanceof ArrayBuffer ? new Uint8Array(body) : body;
    const known = size ?? (src instanceof Uint8Array ? src.byteLength : undefined);
    if (known === undefined) throw new ProviderError(411, 'OneDrive upload needs a known size');
    const token = await this.sessionCreate(p, known, this.chunk);
    let n = 0;
    for await (const piece of chunksOf(src, this.chunk)) {
      if (!piece.byteLength && known > 0) break;
      await this.sessionPut(token, ++n, piece, piece.byteLength);
    }
  }

  private async sessionCreate(path: string, size: number, partSize: number): Promise<string> {
    await this.mkdir(dirname(normalizePath(path)));
    const res = await this.api(this.itemUrl(path, ':/createUploadSession'), () => ({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } }),
    }));
    await ensureOk(res, 'OneDrive createUploadSession');
    const { uploadUrl } = (await res.json()) as { uploadUrl: string };
    const tok: SessionToken = { u: uploadUrl, s: size, p: partSize };
    return btoa(JSON.stringify(tok));
  }

  private parseToken(id: string): SessionToken {
    return JSON.parse(atob(id)) as SessionToken;
  }

  private async sessionPut(id: string, n: number, body: WriteBody, size: number): Promise<{ etag: string }> {
    const t = this.parseToken(id);
    const start = (n - 1) * t.p;
    const end = start + size - 1;
    const total = t.s;
    if (size === 0 && total === 0) {
      // empty file: Graph sessions can't take 0 bytes → simple upload
      return { etag: `od-${n}` };
    }
    // upload URL is pre-authenticated: never send the bearer token to it
    const replayable = body instanceof ReadableStream ? null : body;
    const init = (): RequestInit => {
      const fb = fetchBody(replayable ?? body, size);
      return { method: 'PUT', headers: { ...fb.headers, 'content-range': `bytes ${start}-${end}/${total}` }, body: fb.body, ...fb.init } as RequestInit;
    };
    const res = replayable ? await fetchRetry(this.fetchFn, t.u, init) : await this.fetchFn(t.u, init());
    await ensureOk(res, `OneDrive upload chunk ${n}`);
    await res.body?.cancel().catch(() => {});
    return { etag: `od-${n}` };
  }

  private async sessionParts(id: string): Promise<UploadedPart[]> {
    const t = this.parseToken(id);
    const res = await fetchRetry(this.fetchFn, t.u, () => ({}));
    if (res.status === 404) return [];
    await ensureOk(res, 'OneDrive upload session status');
    const j = (await res.json()) as { nextExpectedRanges?: string[] };
    const next = Math.min(...(j.nextExpectedRanges ?? [`${t.s}-`]).map((r) => Number(r.split('-')[0])));
    const done = Math.floor(next / t.p);
    return Array.from({ length: done }, (_, i) => ({ partNumber: i + 1, etag: `od-${i + 1}`, size: t.p }));
  }

  private async sessionComplete(path: string, id: string, parts: UploadedPart[]): Promise<void> {
    const t = this.parseToken(id);
    if (t.s === 0) {
      await this.write(path, new Uint8Array(0), { size: 0 });
      return;
    }
    // the last chunk already committed the file; make sure it exists with the right size
    const st = await this.stat(path);
    if (!st || st.size !== t.s) throw new ProviderError(409, `OneDrive upload incomplete (${st?.size ?? 0}/${t.s} bytes)`);
    // the browser reports the item id from the final chunk's response: it must be the item at this path
    const itemId = parts.map((p) => p.etag).find((e) => e?.startsWith('item:'))?.slice(5);
    if (itemId) {
      const it = await this.item(path);
      if (it && it.id !== itemId) throw new ProviderError(409, `OneDrive upload finished as item ${itemId}, but ${path} is ${it.id}`);
    }
  }

  private async sessionAbort(id: string): Promise<void> {
    const t = this.parseToken(id);
    const res = await this.fetchFn(t.u, { method: 'DELETE' });
    await res.body?.cancel().catch(() => {});
  }

  async mkdir(path: string): Promise<void> {
    const p = normalizePath(path);
    if (p === '/') return;
    if (await this.item(p)) return;
    await this.mkdir(dirname(p));
    const res = await this.api(this.itemUrl(dirname(p), '/children'), () => ({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: basename(p), folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }),
    }));
    await ensureOk(res, 'OneDrive mkdir', [409]);
  }

  async delete(path: string): Promise<void> {
    const res = await this.api(this.itemUrl(path), () => ({ method: 'DELETE' }));
    await ensureOk(res, 'OneDrive delete', [404]);
  }

  async rename(from: string, to: string): Promise<void> {
    const parent = await this.item(dirname(normalizePath(to)));
    if (!parent) await this.mkdir(dirname(normalizePath(to)));
    const par = parent ?? (await this.item(dirname(normalizePath(to))));
    const res = await this.api(this.itemUrl(from) + '?@microsoft.graph.conflictBehavior=replace', () => ({
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: basename(normalizePath(to)), parentReference: { id: par!.id } }),
    }));
    await ensureOk(res, 'OneDrive move');
  }

  async copy(from: string, to: string): Promise<void> {
    await this.mkdir(dirname(normalizePath(to)));
    const par = await this.item(dirname(normalizePath(to)));
    const res = await this.api(this.itemUrl(from, '/copy') + '?@microsoft.graph.conflictBehavior=replace', () => ({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: basename(normalizePath(to)), parentReference: { driveId: par?.parentReference?.driveId, id: par!.id } }),
    }));
    await ensureOk(res, 'OneDrive copy');
    const monitor = res.headers.get('location');
    await res.body?.cancel().catch(() => {});
    if (!monitor) return;
    // async job: poll the (unauthenticated) monitor URL for up to ~25 s
    for (let i = 0; i < 25; i++) {
      const m = await this.fetchFn(monitor);
      const j = (await m.json().catch(() => ({}))) as { status?: string };
      if (j.status === 'completed' || m.status === 303 || (m.status === 200 && !j.status)) return;
      if (j.status === 'failed') throw new ProviderError(502, 'OneDrive copy failed');
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  async test(): Promise<void> {
    await ensureOk(await this.api(this.drive()), 'OneDrive');
  }
}

export const onedriveDefinition: DriverDefinition = {
  type: 'onedrive',
  label: 'OneDrive / SharePoint (Microsoft Graph)',
  runtimes: ['workers', 'node'],
  oauth: 'onedrive',
  notes:
    'Register an app in Entra ID (Azure portal → App registrations), add the redirect URI below as a "Web" platform, create a client secret, grant Files.ReadWrite.All + offline_access, then press Authorize. Uploads use Graph upload sessions (in order, resumable); the browser sends the chunks straight to OneDrive, with the Worker as fallback.',
  notesZh:
    '在 Entra ID（Azure 入口網站 → 應用程式註冊）建立應用程式，平台選「Web」並加入下方 Redirect URI，建立用戶端密碼，授予 Files.ReadWrite.All 與 offline_access 權限，填入後按「授權」。上傳使用 Graph 上傳工作階段（依序、可續傳），由瀏覽器直接傳到 OneDrive，失敗時改走 Worker。',
  fields: [
    {
      key: 'driveType',
      label: 'Account type',
      labelZh: '帳號類型',
      type: 'select',
      default: 'personal',
      options: [
        { value: 'personal', label: 'Personal (個人)' },
        { value: 'business', label: 'Business / SharePoint (商務)' },
      ],
    },
    { key: 'region', label: 'Cloud', labelZh: '雲端區域', type: 'select', default: 'global', options: [{ value: 'global', label: 'Global' }, { value: 'cn', label: '21Vianet (China)' }] },
    { key: 'tenant', label: 'Tenant', labelZh: '租用戶（Tenant）', type: 'text', placeholder: 'common / organizations / <tenant id>', help: 'Default: common (personal) / organizations (business)', helpZh: '預設：個人用 common、商務用 organizations；單一租用戶應用程式請填租用戶 ID' },
    { key: 'clientId', label: 'Client ID', labelZh: '應用程式（用戶端）識別碼', type: 'text', required: true },
    { key: 'clientSecret', label: 'Client secret', labelZh: '用戶端密碼', type: 'password', secret: true },
    { key: 'refreshToken', label: 'Refresh token', labelZh: 'Refresh Token（可用下方授權按鈕自動取得）', type: 'password', secret: true },
    { key: 'driveId', label: 'Drive ID (optional)', labelZh: 'Drive ID（選填，SharePoint 文件庫等）', type: 'text', help: 'Empty = /me/drive', helpZh: '留空 = 自己的 OneDrive' },
    { key: 'root', label: 'Root folder', labelZh: '根目錄', type: 'text', default: '/' },
    { key: 'chunkSizeMB', label: 'Upload chunk (MiB)', labelZh: '上傳分段大小（MiB，自動對齊 320 KiB）', type: 'number', default: 10 },
  ],
  create: (config, ctx) => new OneDriveDriver(config as unknown as OneDriveConfig, ctx),
};
