/**
 * HuggingFace Hub (model / dataset / space repos).
 *
 * Read: tree API for listings, paths-info for stat, /resolve/ (CDN, Range) for downloads.
 * Write: commit API (NDJSON). Small/text files are committed inline (base64); files the Hub wants in
 * LFS (preupload → uploadMode "lfs") are uploaded through the git-lfs batch API (basic or multipart
 * transfer) and committed as `lfsFile`. Moves of LFS files are metadata-only commits (same oid).
 * Every write is one commit, so a file is written in one request: the size limit is `maxUploadMB`
 * (default 50 MiB, also capped by the Worker proxy limit). Use huggingface-cli for bigger files.
 */
import { basename, joinPath, normalizePath } from '../lib/path';
import { mimeFromPath } from '../lib/mime';
import { HttpError } from '../lib/errors';
import { BaseDriver, rangeHeader } from './base';
import { b64, ensureOk, fetchRetry, ProviderError, readUpTo, sliceStream } from './http';
import type { ByteRange, DriverContext, DriverDefinition, FileEntry, ReadResult, WriteBody, WriteOptions } from './types';

export interface HFConfig {
  repoId: string;
  repoType?: 'model' | 'dataset' | 'space';
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
  readonly capabilities: { presign: false; multipart: false; rangeRead: true; maxUploadSize: number };
  private ep: string;
  private kind: 'model' | 'dataset' | 'space';
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
    this.kind = cfg.repoType || 'model';
    this.rev = cfg.revision || 'main';
    this.root = normalizePath(cfg.root || '/');
    this.fetchFn = ctx.fetch;
    this.capabilities = { presign: false, multipart: false, rangeRead: true, maxUploadSize: Math.max(1, Number(cfg.maxUploadMB) || 50) * MiB };
  }

  private get apiRepo(): string {
    return `${this.ep}/api/${this.kind}s/${this.cfg.repoId}`;
  }
  private get webRepo(): string {
    const prefix = this.kind === 'dataset' ? 'datasets/' : this.kind === 'space' ? 'spaces/' : '';
    return `${this.ep}/${prefix}${this.cfg.repoId}`;
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

  private async uploadMode(repoPath: string, bytes: Uint8Array): Promise<'lfs' | 'regular'> {
    const res = await this.req(`${this.apiRepo}/preupload/${encodeURIComponent(this.rev)}`, () => ({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ files: [{ path: repoPath, size: bytes.byteLength, sample: b64(bytes.subarray(0, 512)) }] }),
    }));
    await ensureOk(res, 'HuggingFace preupload');
    const j = (await res.json()) as { files: { path: string; uploadMode: 'lfs' | 'regular' }[] };
    return j.files.find((f) => f.path === repoPath)?.uploadMode ?? 'regular';
  }

  /** git-lfs batch upload (basic or multipart transfer). */
  async lfsUpload(bytes: Uint8Array): Promise<{ oid: string; size: number }> {
    const oid = await sha256Hex(bytes);
    const size = bytes.byteLength;
    const res = await this.req(`${this.webRepo}.git/info/lfs/objects/batch`, () => ({
      method: 'POST',
      headers: { accept: 'application/vnd.git-lfs+json', 'content-type': 'application/vnd.git-lfs+json' },
      body: JSON.stringify({ operation: 'upload', transfers: ['basic', 'multipart'], hash_algo: 'sha256', ref: { name: this.rev }, objects: [{ oid, size }] }),
    }));
    await ensureOk(res, 'HuggingFace LFS batch');
    const j = (await res.json()) as {
      transfer?: string;
      objects: { actions?: { upload?: { href: string; header?: Record<string, string> }; verify?: { href: string; header?: Record<string, string> } }; error?: { message: string } }[];
    };
    const obj = j.objects[0];
    if (obj?.error) throw new ProviderError(502, `HuggingFace LFS: ${obj.error.message}`);
    const up = obj?.actions?.upload;
    if (up) {
      const header = up.header ?? {};
      if (header.chunk_size) {
        const chunk = Number(header.chunk_size);
        const keys = Object.keys(header).filter((k) => /^\d+$/.test(k)).sort((a, b) => Number(a) - Number(b));
        const parts: { partNumber: number; etag: string }[] = [];
        for (const k of keys) {
          const n = Number(k);
          const piece = bytes.subarray((n - 1) * chunk, Math.min(size, n * chunk));
          const r = await fetchRetry(this.fetchFn, header[k], () => ({ method: 'PUT', body: piece as BodyInit }));
          await ensureOk(r, `HuggingFace LFS part ${n}`);
          parts.push({ partNumber: n, etag: r.headers.get('etag') ?? '' });
        }
        const done = await this.req(up.href, () => ({ method: 'POST', headers: { accept: 'application/vnd.git-lfs+json', 'content-type': 'application/vnd.git-lfs+json' }, body: JSON.stringify({ oid, parts }) }));
        await ensureOk(done, 'HuggingFace LFS multipart complete');
      } else {
        const r = await fetchRetry(this.fetchFn, up.href, () => ({ method: 'PUT', headers: header, body: bytes as BodyInit }));
        await ensureOk(r, 'HuggingFace LFS upload');
      }
      const v = obj.actions?.verify;
      if (v) {
        const r = await fetchRetry(this.fetchFn, v.href, () => ({ method: 'POST', headers: { ...(v.header ?? {}), 'content-type': 'application/vnd.git-lfs+json' }, body: JSON.stringify({ oid, size }) }));
        await ensureOk(r, 'HuggingFace LFS verify');
      }
    }
    return { oid, size };
  }

  private async fileOp(repoPath: string, bytes: Uint8Array): Promise<CommitOp> {
    if ((await this.uploadMode(repoPath, bytes)) === 'lfs') {
      const { oid, size } = await this.lfsUpload(bytes);
      return { key: 'lfsFile', value: { path: repoPath, algo: 'sha256', oid, size } };
    }
    return { key: 'file', value: { path: repoPath, content: b64(bytes), encoding: 'base64' } };
  }

  async write(path: string, body: WriteBody, opts: WriteOptions = {}): Promise<void> {
    const max = this.capabilities.maxUploadSize;
    if (opts.size !== undefined && opts.size > max) throw new HttpError(413, `HuggingFace uploads through EdgeDock are limited to ${max / MiB} MiB`, 'too_large');
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
  label: 'HuggingFace Hub',
  runtimes: ['workers', 'node'],
  notes:
    'Token: huggingface.co → Settings → Access Tokens (read for browsing, write / fine-grained "write to repo" for uploads). Every upload / delete / move is a commit; large binary files go through Git LFS automatically. Files are uploaded in one request (limit: max upload size and the Worker proxy limit).',
  notesZh:
    'Token：huggingface.co → Settings → Access Tokens（瀏覽用 read；上傳需要 write 或細粒度「write to repo」）。每次上傳／刪除／移動都是一次 commit，大型二進位檔會自動走 Git LFS。檔案以單一請求上傳（上限：下方「上傳大小上限」與 Worker 代理上限）。',
  fields: [
    { key: 'repoId', label: 'Repository', labelZh: 'Repo（使用者/名稱）', type: 'text', required: true, placeholder: 'user/my-dataset' },
    {
      key: 'repoType',
      label: 'Repository type',
      labelZh: 'Repo 類型',
      type: 'select',
      default: 'dataset',
      options: [
        { value: 'dataset', label: 'Dataset' },
        { value: 'model', label: 'Model' },
        { value: 'space', label: 'Space' },
      ],
    },
    { key: 'revision', label: 'Branch / revision', labelZh: '分支（revision）', type: 'text', default: 'main' },
    { key: 'token', label: 'Access token', labelZh: 'Access Token', type: 'password', secret: true },
    { key: 'root', label: 'Root folder', labelZh: '根目錄', type: 'text', default: '/' },
    { key: 'maxUploadMB', label: 'Max upload size (MiB)', labelZh: '上傳大小上限（MiB）', type: 'number', default: 50 },
    { key: 'endpoint', label: 'Hub endpoint', labelZh: 'Hub 位址（鏡像站可改）', type: 'text', default: 'https://huggingface.co' },
  ],
  create: (config, ctx) => new HuggingFaceDriver(config as unknown as HFConfig, ctx),
};
