/**
 * HuggingFace Hub — Dataset repos only.
 *
 * Read: tree API for listings, paths-info for stat, /resolve/ (CDN, Range) for downloads.
 * Write: commit API (NDJSON). Small/text files are committed inline (base64); files the Hub wants in
 * LFS (preupload → uploadMode "lfs") go through the git-lfs batch API and are committed as `lfsFile`.
 * Moves of LFS files are metadata-only commits (same oid).
 *
 * Large files (the browser upload manager, like huggingface.js `commit()`):
 *   1. the browser streams the file through SHA-256 (LFS oid) and opens an EdgeDock multipart session;
 *   2. `multipart.create` → preupload (must be "lfs") → LFS batch (transfers basic + multipart):
 *      no `actions` = object already on the Hub (nothing to upload); `header.chunk_size` = S3 multipart,
 *      the numbered header keys are presigned part URLs and `actions.upload.href` the completion URL;
 *      otherwise one presigned PUT (basic);
 *   3. the browser PUTs the parts straight to the presigned URLs (`presignParts` re-runs the batch for
 *      fresh URLs; parts can also be proxied through the Worker via `uploadPart`);
 *   4. `complete` POSTs {oid, parts:[{partNumber, etag}]} to the completion URL, then commits `lfsFile`.
 * The session's upload id is a JSON blob {oid, size, t, href, uid, cs} kept in D1.
 * Single-request writes (`write`: proxy PUT, WebDAV, copy) are buffered in the Worker, so they are
 * limited to `maxWriteSize` (100 MiB) and the Worker body limit.
 */
import { basename, joinPath, normalizePath } from '../lib/path';
import { mimeFromPath } from '../lib/mime';
import { HttpError } from '../lib/errors';
import { BaseDriver, rangeHeader } from './base';
import { b64, ensureOk, fetchRetry, ProviderError, readUpTo, sliceStream } from './http';
import { fetchBody } from './base';
import type { ByteRange, DriverCapabilities, DriverContext, DriverDefinition, FileEntry, MultipartCreated, MultipartCreateOptions, MultipartSupport, PresignedParts, PresignedRequest, ReadResult, UploadedPart, WriteBody, WriteOptions } from './types';

export interface HFConfig {
  repoId: string;
  revision?: string;
  token?: string;
  endpoint?: string;
  root?: string;
  maxUploadMB?: number;
}

interface TreeEntry {
  type: 'file' | 'directory';
  path: string;
  size?: number;
  oid?: string;
  lfs?: { oid: string; size: number };
  lastCommit?: { date?: string };
}

type CommitOp =
  | { key: 'file'; value: { path: string; content: string; encoding: 'base64' } }
  | { key: 'lfsFile'; value: { path: string; algo: 'sha256'; oid: string; size: number } }
  | { key: 'deletedFile'; value: { path: string } }
  | { key: 'deletedFolder'; value: { path: string } };

const MiB = 1024 * 1024;
/** default per-file limit for browser (multipart) uploads: the Hub rejects LFS files above 50 GB */
export const HF_DEFAULT_MAX_UPLOAD_MB = 50 * 1024;
/** single-request writes are buffered in memory */
export const HF_MAX_WRITE = 100 * MiB;
const LFS_HEADERS = { accept: 'application/vnd.git-lfs+json', 'content-type': 'application/vnd.git-lfs+json' };

/** Upload id of an LFS session (stored in D1 as JSON). */
export interface LfsSession {
  oid: string;
  size: number;
  /** transfer: S3 multipart, single presigned PUT, or object already present */
  t: 'multipart' | 'basic' | 'exists';
  /** completion URL (multipart) / PUT URL (basic) — refreshed on every batch call */
  href?: string;
  /** S3 upload id of the multipart upload (detects the Hub starting a new one) */
  uid?: string;
  /** chunk size (multipart) */
  cs?: number;
}

interface BatchObject {
  oid: string;
  size: number;
  actions?: { upload?: { href: string; header?: Record<string, string> }; verify?: { href: string; header?: Record<string, string> } };
  error?: { code?: number; message: string };
}

interface BatchPlan {
  session: LfsSession;
  /** part number → presigned URL (multipart) */
  parts: Record<number, string>;
  /** headers for the basic PUT */
  basicHeaders?: Record<string, string>;
  verify?: { href: string; header?: Record<string, string> };
}

function s3UploadId(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).searchParams.get('uploadId') ?? undefined;
  } catch {
    return undefined;
  }
}

function encPath(p: string): string {
  return p
    .split('/')
    .filter(Boolean)
    .map((s) => encodeURIComponent(s))
    .join('/');
}

async function sha256Hex(b: Uint8Array): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', b as BufferSource);
  return [...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export class HuggingFaceDriver extends BaseDriver {
  readonly type = 'huggingface';
  readonly capabilities: DriverCapabilities;
  readonly multipart: MultipartSupport;
  private ep: string;
  private rev: string;
  private root: string;
  private fetchFn: typeof fetch;

  constructor(
    private cfg: HFConfig,
    ctx: DriverContext,
  ) {
    super();
    if (!cfg.repoId || !cfg.repoId.includes('/')) throw new Error('HuggingFace repo id must look like "user/name"');
    this.ep = (cfg.endpoint || 'https://huggingface.co').replace(/\/+$/, '');
    this.rev = cfg.revision || 'main';
    this.root = normalizePath(cfg.root || '/');
    this.fetchFn = ctx.fetch;
    this.capabilities = {
      presign: false,
      multipart: true,
      rangeRead: true,
      directParts: true,
      needsSha256: true,
      maxUploadSize: Math.max(1, Number(cfg.maxUploadMB) || HF_DEFAULT_MAX_UPLOAD_MB) * MiB,
      maxWriteSize: HF_MAX_WRITE,
    };
    this.multipart = {
      create: (p, o) => this.mpCreate(p, o),
      presignPart: async (p, id, n, exp) => {
        const r = await this.mpPresignParts(p, id, [n], exp);
        const u = r.urls[n];
        if (!u) throw new ProviderError(409, `HuggingFace LFS: no URL for part ${n}`);
        return u;
      },
      presignParts: (p, id, ns, exp) => this.mpPresignParts(p, id, ns, exp),
      uploadPart: (p, id, n, body, size) => this.mpUploadPart(p, id, n, body, size),
      complete: (p, id, parts) => this.mpComplete(p, id, parts),
      // the Hub has no abort for LFS multipart uploads; unfinished uploads expire on its side
      abort: async () => {},
    };
  }

  private get apiRepo(): string {
    return `${this.ep}/api/datasets/${this.cfg.repoId}`;
  }
  private get webRepo(): string {
    return `${this.ep}/datasets/${this.cfg.repoId}`;
  }
  /** storage path → repo path (no leading slash) */
  private repoPath(p: string): string {
    return joinPath(this.root, p).slice(1);
  }
  private relPath(repoPath: string): string {
    const full = normalizePath('/' + repoPath);
    return this.root === '/' ? full : normalizePath(full.slice(this.root.length));
  }
  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return this.cfg.token ? { authorization: `Bearer ${this.cfg.token}`, ...extra } : extra;
  }
  private req(url: string, init: () => RequestInit = () => ({})): Promise<Response> {
    return fetchRetry(this.fetchFn, url, () => {
      const i = init();
      return { ...i, headers: this.headers((i.headers as Record<string, string>) ?? {}) };
    });
  }

  private toEntry(t: TreeEntry): FileEntry {
    const name = basename('/' + t.path);
    const isDir = t.type === 'directory';
    return {
      name,
      path: this.relPath(t.path),
      isDir,
      size: isDir ? 0 : Number(t.lfs?.size ?? t.size ?? 0),
      etag: t.lfs?.oid ?? t.oid,
      modified: t.lastCommit?.date ? Date.parse(t.lastCommit.date) : undefined,
      contentType: isDir ? undefined : mimeFromPath(name),
    };
  }

  private async tree(path: string, recursive = false): Promise<TreeEntry[]> {
    const rp = this.repoPath(path);
    let url: string | null = `${this.apiRepo}/tree/${encodeURIComponent(this.rev)}${rp ? '/' + encPath(rp) : ''}${recursive ? '?recursive=true' : ''}`;
    const out: TreeEntry[] = [];
    while (url) {
      const res: Response = await this.req(url);
      if (res.status === 404) throw new ProviderError(404, `Not found: ${path}`);
      await ensureOk(res, 'HuggingFace tree');
      out.push(...((await res.json()) as TreeEntry[]));
      const link = res.headers.get('link');
      const m = link ? /<([^>]+)>;\s*rel="next"/.exec(link) : null;
      url = m ? m[1] : null;
    }
    return out;
  }

  async list(path: string): Promise<FileEntry[]> {
    return (await this.tree(path)).filter((t) => basename('/' + t.path) !== '.gitkeep').map((t) => this.toEntry(t));
  }

  private async info(path: string): Promise<TreeEntry | null> {
    const rp = this.repoPath(path);
    const form = new URLSearchParams();
    form.append('paths', rp);
    form.set('expand', 'false');
    const res = await this.req(`${this.apiRepo}/paths-info/${encodeURIComponent(this.rev)}`, () => ({
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    }));
    await ensureOk(res, 'HuggingFace paths-info');
    const arr = (await res.json()) as TreeEntry[];
    return arr.find((x) => x.path === rp) ?? null;
  }

  async stat(path: string): Promise<FileEntry | null> {
    const p = normalizePath(path);
    if (p === '/') return { name: '', path: '/', isDir: true, size: 0 };
    const t = await this.info(p);
    return t ? { ...this.toEntry(t), path: p } : null;
  }

  async read(path: string, opts: { range?: ByteRange } = {}): Promise<ReadResult> {
    const p = normalizePath(path);
    const t = await this.info(p);
    if (!t || t.type !== 'file') throw new ProviderError(404, `Not found: ${p}`);
    const size = Number(t.lfs?.size ?? t.size ?? 0);
    const headers: Record<string, string> = opts.range ? { range: rangeHeader(opts.range) } : {};
    const res = await this.req(`${this.webRepo}/resolve/${encodeURIComponent(this.rev)}/${encPath(this.repoPath(p))}`, () => ({ headers }));
    await ensureOk(res, 'HuggingFace download');
    const r: ReadResult = { body: res.body, size, contentType: mimeFromPath(p), etag: t.lfs?.oid ?? t.oid };
    if (opts.range) {
      const end = Math.min(opts.range.end ?? size - 1, size - 1);
      r.range = { start: opts.range.start, end };
      if (res.status !== 206 && res.body) r.body = sliceStream(res.body, opts.range.start, end);
    }
    return r;
  }

  // ------------------------------------------------------------ write side
  async commit(summary: string, ops: CommitOp[]): Promise<void> {
    if (!this.cfg.token) throw new HttpError(401, 'A HuggingFace token with write access is required', 'unauthorized');
    const lines = [JSON.stringify({ key: 'header', value: { summary, description: 'via EdgeDock' } }), ...ops.map((o) => JSON.stringify(o))].join('\n');
    const res = await this.req(`${this.apiRepo}/commit/${encodeURIComponent(this.rev)}`, () => ({ method: 'POST', headers: { 'content-type': 'application/x-ndjson' }, body: lines }));
    await ensureOk(res, 'HuggingFace commit');
  }

  private async uploadMode(repoPath: string, size: number, sample: string): Promise<'lfs' | 'regular'> {
    const res = await this.req(`${this.apiRepo}/preupload/${encodeURIComponent(this.rev)}`, () => ({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ files: [{ path: repoPath, size, sample }] }),
    }));
    await ensureOk(res, 'HuggingFace preupload');
    const j = (await res.json()) as { files: { path: string; uploadMode: 'lfs' | 'regular' }[] };
    return j.files.find((f) => f.path === repoPath)?.uploadMode ?? 'regular';
  }

  /** git-lfs batch request for one object → parsed upload plan. */
  async lfsBatch(oid: string, size: number): Promise<BatchPlan> {
    if (!this.cfg.token) throw new HttpError(401, 'A HuggingFace token with write access is required', 'unauthorized');
    const res = await this.req(`${this.webRepo}.git/info/lfs/objects/batch`, () => ({
      method: 'POST',
      headers: LFS_HEADERS,
      body: JSON.stringify({ operation: 'upload', transfers: ['basic', 'multipart'], hash_algo: 'sha_256', ref: { name: this.rev }, objects: [{ oid, size }] }),
    }));
    await ensureOk(res, 'HuggingFace LFS batch');
    const j = (await res.json()) as { transfer?: string; objects: BatchObject[] };
    const obj = j.objects?.find((o) => o.oid === oid) ?? j.objects?.[0];
    if (!obj) throw new ProviderError(502, 'HuggingFace LFS batch returned no object');
    if (obj.error) throw new ProviderError(obj.error.code && obj.error.code >= 400 && obj.error.code < 500 ? obj.error.code : 502, `HuggingFace LFS: ${obj.error.message}`);
    const up = obj.actions?.upload;
    if (!up) return { session: { oid, size, t: 'exists' }, parts: {} };
    const header = { ...(up.header ?? {}) };
    if (header.chunk_size) {
      const cs = Number(header.chunk_size);
      const parts: Record<number, string> = {};
      for (const k of Object.keys(header).filter((k) => /^\d+$/.test(k)).sort((x, y) => Number(x) - Number(y))) parts[Number(k)] = header[k];
      const n = Object.keys(parts).length;
      if (!(cs > 0) || n !== Math.max(1, Math.ceil(size / cs))) throw new ProviderError(502, `HuggingFace LFS: unexpected multipart layout (${n} parts of ${cs} bytes for ${size} bytes)`);
      return { session: { oid, size, t: 'multipart', href: up.href, cs, uid: s3UploadId(parts[1]) }, parts, verify: obj.actions?.verify };
    }
    return { session: { oid, size, t: 'basic', href: up.href }, parts: { 1: up.href }, basicHeaders: header, verify: obj.actions?.verify };
  }

  private parseSession(id: string): LfsSession {
    try {
      const s = JSON.parse(id) as LfsSession;
      if (s && typeof s.oid === 'string') return s;
    } catch {
      /* fallthrough */
    }
    throw new ProviderError(400, 'Invalid HuggingFace upload session');
  }

  private layout(s: LfsSession): { partSize: number; totalParts: number } {
    if (s.t === 'multipart') return { partSize: s.cs!, totalParts: Math.max(1, Math.ceil(s.size / s.cs!)) };
    return { partSize: Math.max(1, s.size), totalParts: 1 };
  }

  private async mpCreate(path: string, o: MultipartCreateOptions): Promise<MultipartCreated> {
    const oid = (o.sha256 ?? '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(oid)) throw new HttpError(400, 'HuggingFace uploads need the SHA-256 of the file (sha256)', 'sha256_required');
    const size = Number(o.size ?? 0);
    const rp = this.repoPath(path);
    const mode = await this.uploadMode(rp, size, o.sample ?? '');
    if (mode !== 'lfs') throw new HttpError(400, 'The Hub wants this file stored as a regular (non-LFS) git file, which EdgeDock can only commit in one request (≤ 100 MiB). Add an LFS rule to .gitattributes for it or upload it with huggingface-cli.', 'hf_regular_too_large');
    const plan = await this.lfsBatch(oid, size);
    const { partSize, totalParts } = this.layout(plan.session);
    const created: MultipartCreated = { uploadId: JSON.stringify(plan.session), partSize, totalParts, checksum: `sha256:${oid}` };
    if (plan.session.t === 'exists') {
      created.uploadedParts = [{ partNumber: 1, etag: 'lfs-exists', size: partSize }];
    }
    return created;
  }

  private presigned(plan: BatchPlan, n: number, expiresIn: number): PresignedRequest | undefined {
    const url = plan.parts[n];
    if (!url) return undefined;
    return { url, method: 'PUT', headers: plan.session.t === 'basic' ? { ...(plan.basicHeaders ?? {}) } : {}, expiresIn };
  }

  /** One batch call → fresh URLs for the requested parts (presigned URLs expire). */
  private async mpPresignParts(_path: string, id: string, partNumbers: number[], expiresIn: number): Promise<PresignedParts> {
    const cur = this.parseSession(id);
    if (cur.t === 'exists') return { urls: {}, alreadyComplete: true };
    const plan = await this.lfsBatch(cur.oid, cur.size);
    const next = plan.session;
    if (next.t === 'exists') return { urls: {}, uploadId: JSON.stringify(next), alreadyComplete: true };
    const restarted = next.t !== cur.t || next.cs !== cur.cs || (!!cur.uid && !!next.uid && cur.uid !== next.uid);
    const urls: Record<number, PresignedRequest> = {};
    for (const n of partNumbers) {
      const u = this.presigned(plan, n, expiresIn);
      if (u) urls[n] = u;
    }
    return { urls, uploadId: JSON.stringify(next), restarted };
  }

  /** Worker-proxied part (fallback when the browser cannot reach the presigned URL): streamed, not buffered. */
  private async mpUploadPart(_path: string, id: string, n: number, body: WriteBody, size: number): Promise<{ etag: string }> {
    const cur = this.parseSession(id);
    if (cur.t === 'exists') return { etag: 'lfs-exists' };
    const plan = await this.lfsBatch(cur.oid, cur.size);
    const u = this.presigned(plan, n, 3600);
    if (!u) throw new ProviderError(409, `HuggingFace LFS: no URL for part ${n}`);
    const fb = fetchBody(body, size);
    const res = await this.fetchFn(u.url, { method: 'PUT', headers: { ...u.headers, ...fb.headers }, body: fb.body, ...fb.init } as RequestInit);
    await ensureOk(res, `HuggingFace LFS part ${n}`);
    await res.body?.cancel().catch(() => {});
    return { etag: res.headers.get('etag') ?? '' };
  }

  private async mpComplete(path: string, id: string, parts: UploadedPart[]): Promise<{ checksum: string }> {
    let cur = this.parseSession(id);
    if (cur.t === 'multipart') {
      const body = JSON.stringify({ oid: cur.oid, parts: [...parts].sort((a, b) => a.partNumber - b.partNumber).map((p) => ({ partNumber: p.partNumber, etag: p.etag })) });
      const post = (href: string) => this.fetchFn(href, { method: 'POST', headers: LFS_HEADERS, body });
      let res = await post(cur.href!);
      if (res.status === 401 || res.status === 403) {
        // the signed completion URL expired (resumed later): ask the batch API for a fresh one
        await res.body?.cancel().catch(() => {});
        const plan = await this.lfsBatch(cur.oid, cur.size);
        if (plan.session.t === 'multipart') {
          if (cur.uid && plan.session.uid && cur.uid !== plan.session.uid) throw new HttpError(409, 'HuggingFace started a new multipart upload; upload the file again', 'hf_restarted');
          cur = plan.session;
          res = await post(cur.href!);
        } else if (plan.session.t !== 'exists') throw new HttpError(409, 'HuggingFace LFS upload state changed; upload the file again', 'hf_restarted');
      }
      await ensureOk(res, 'HuggingFace LFS multipart complete');
      await res.body?.cancel().catch(() => {});
    }
    const rp = this.repoPath(path);
    await this.commit(`Upload ${rp}`, [{ key: 'lfsFile', value: { path: rp, algo: 'sha256', oid: cur.oid, size: cur.size } }]);
    return { checksum: `sha256:${cur.oid}` };
  }

  /** git-lfs upload of an in-memory object (single-request writes). */
  async lfsUpload(bytes: Uint8Array): Promise<{ oid: string; size: number }> {
    const oid = await sha256Hex(bytes);
    const size = bytes.byteLength;
    const plan = await this.lfsBatch(oid, size);
    if (plan.session.t === 'multipart') {
      const cs = plan.session.cs!;
      const parts: UploadedPart[] = [];
      for (const [k, url] of Object.entries(plan.parts)) {
        const n = Number(k);
        const piece = bytes.subarray((n - 1) * cs, Math.min(size, n * cs));
        const r = await fetchRetry(this.fetchFn, url, () => ({ method: 'PUT', body: piece as BodyInit }));
        await ensureOk(r, `HuggingFace LFS part ${n}`);
        parts.push({ partNumber: n, etag: r.headers.get('etag') ?? '' });
      }
      const done = await this.fetchFn(plan.session.href!, { method: 'POST', headers: LFS_HEADERS, body: JSON.stringify({ oid, parts }) });
      await ensureOk(done, 'HuggingFace LFS multipart complete');
    } else if (plan.session.t === 'basic') {
      const r = await fetchRetry(this.fetchFn, plan.session.href!, () => ({ method: 'PUT', headers: plan.basicHeaders ?? {}, body: bytes as BodyInit }));
      await ensureOk(r, 'HuggingFace LFS upload');
    }
    const v = plan.verify;
    if (v && plan.session.t !== 'exists') {
      const r = await fetchRetry(this.fetchFn, v.href, () => ({ method: 'POST', headers: { ...(v.header ?? {}), ...LFS_HEADERS }, body: JSON.stringify({ oid, size }) }));
      await ensureOk(r, 'HuggingFace LFS verify');
    }
    return { oid, size };
  }

  private async fileOp(repoPath: string, bytes: Uint8Array): Promise<CommitOp> {
    if ((await this.uploadMode(repoPath, bytes.byteLength, b64(bytes.subarray(0, 512)))) === 'lfs') {
      const { oid, size } = await this.lfsUpload(bytes);
      return { key: 'lfsFile', value: { path: repoPath, algo: 'sha256', oid, size } };
    }
    return { key: 'file', value: { path: repoPath, content: b64(bytes), encoding: 'base64' } };
  }

  /** Single-request write (Worker proxy PUT, WebDAV, copy): buffered, so capped at `maxWriteSize`. */
  async write(path: string, body: WriteBody, opts: WriteOptions = {}): Promise<void> {
    const max = Math.min(this.capabilities.maxWriteSize!, this.capabilities.maxUploadSize!);
    if (opts.size !== undefined && opts.size > max)
      throw new HttpError(413, `Single-request uploads to HuggingFace are limited to ${Math.floor(max / MiB)} MiB; use the browser upload (multipart) for larger files`, 'too_large');
    const bytes = await readUpTo(body as ReadableStream<Uint8Array>, max);
    const rp = this.repoPath(path);
    await this.commit(`Upload ${rp}`, [await this.fileOp(rp, bytes)]);
  }

  async mkdir(path: string): Promise<void> {
    const p = normalizePath(path);
    if (p === '/' || (await this.stat(p))) return;
    await this.commit(`Create ${this.repoPath(p)}/`, [{ key: 'file', value: { path: this.repoPath(joinPath(p, '.gitkeep')), content: '', encoding: 'base64' } }]);
  }

  async delete(path: string): Promise<void> {
    const p = normalizePath(path);
    const st = await this.stat(p);
    if (!st) return;
    const rp = this.repoPath(p);
    await this.commit(`Delete ${rp}`, [st.isDir ? { key: 'deletedFolder', value: { path: rp + '/' } } : { key: 'deletedFile', value: { path: rp } }]);
  }

  private async transferOps(from: string, to: string): Promise<{ ops: CommitOp[]; removed: string[] }> {
    const st = await this.stat(from);
    if (!st) throw new ProviderError(404, `Not found: ${from}`);
    const files: TreeEntry[] = st.isDir ? (await this.tree(from, true)).filter((t) => t.type === 'file') : [(await this.info(from))!];
    const fromRp = this.repoPath(from);
    const toRp = this.repoPath(to);
    const ops: CommitOp[] = [];
    for (const f of files) {
      const dest = toRp + f.path.slice(fromRp.length);
      if (f.lfs) ops.push({ key: 'lfsFile', value: { path: dest, algo: 'sha256', oid: f.lfs.oid, size: f.lfs.size } });
      else {
        const r = await this.read(this.relPath(f.path));
        ops.push({ key: 'file', value: { path: dest, content: b64(await readUpTo(r.body!)), encoding: 'base64' } });
      }
    }
    return { ops, removed: files.map((f) => f.path) };
  }

  /** LFS files are re-pointed (same oid), regular files copied inline — one commit. */
  async copy(from: string, to: string): Promise<void> {
    const { ops } = await this.transferOps(from, to);
    await this.commit(`Copy ${this.repoPath(from)} → ${this.repoPath(to)}`, ops);
  }

  async rename(from: string, to: string): Promise<void> {
    const { ops, removed } = await this.transferOps(from, to);
    await this.commit(`Move ${this.repoPath(from)} → ${this.repoPath(to)}`, [...ops, ...removed.map((path) => ({ key: 'deletedFile' as const, value: { path } }))]);
  }

  async test(): Promise<void> {
    await ensureOk(await this.req(`${this.apiRepo}/revision/${encodeURIComponent(this.rev)}`), 'HuggingFace repo');
  }
}

export const huggingfaceDefinition: DriverDefinition = {
  type: 'huggingface',
  label: 'HuggingFace Dataset',
  runtimes: ['workers', 'node'],
  notes:
    'Token: huggingface.co → Settings → Access Tokens (read for browsing, write / fine-grained "write to repo" for uploads). Every upload / delete / move is a commit; large binary files go through Git LFS automatically. Browser uploads above the multipart threshold are hashed (SHA-256) in the browser and sent straight to the Hub LFS storage in parts (resumable); WebDAV / single-request writes go through the Worker (≤ 100 MiB).',
  notesZh:
    'Token：huggingface.co → Settings → Access Tokens（瀏覽用 read；上傳需要 write 或細粒度「write to repo」）。每次上傳／刪除／移動都是一次 commit，大型二進位檔會自動走 Git LFS。瀏覽器上傳的大檔會先在瀏覽器計算 SHA-256，再分段直傳到 Hub 的 LFS 儲存（可續傳）；WebDAV／單一請求寫入仍經 Worker（上限 100 MiB）。',
  fields: [
    { key: 'repoId', label: 'Repository', labelZh: 'Dataset Repo（使用者/名稱）', type: 'text', required: true, placeholder: 'user/my-dataset' },
    { key: 'revision', label: 'Branch / revision', labelZh: '分支（revision）', type: 'text', default: 'main' },
    { key: 'token', label: 'Access token', labelZh: 'Access Token', type: 'password', secret: true },
    { key: 'root', label: 'Root folder', labelZh: '根目錄', type: 'text', default: '/' },
    {
      key: 'maxUploadMB',
      label: 'Max upload size (MiB)',
      labelZh: '上傳大小上限（MiB）',
      type: 'number',
      default: HF_DEFAULT_MAX_UPLOAD_MB,
      help: 'Per-file limit for browser uploads. The Hub rejects LFS files above 50 GB and recommends keeping files under ~20 GB.',
      helpZh: '瀏覽器上傳的單檔上限。Hub 不接受超過 50 GB 的 LFS 檔案，並建議單檔維持在約 20 GB 以下。',
    },
    { key: 'endpoint', label: 'Hub endpoint', labelZh: 'Hub 位址（鏡像站可改）', type: 'text', default: 'https://huggingface.co' },
  ],
  create: (config, ctx) => new HuggingFaceDriver(config as unknown as HFConfig, ctx),
};
