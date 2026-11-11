/**
 * GitHub (read-only): repository contents through the REST API and release assets as a directory
 * tree (/<tag>/<asset>). Token optional (public repos; 60 req/h unauthenticated, 5000 with a token).
 * Every write operation answers 405 (read-only storage).
 */
import { HttpError } from '../lib/errors';
import { basename, joinPath, normalizePath } from '../lib/path';
import { mimeFromPath } from '../lib/mime';
import { BaseDriver, rangeHeader } from './base';
import { ensureOk, fetchRetry, ProviderError, sliceStream } from './http';
import type { ByteRange, DriverContext, DriverDefinition, FileEntry, ReadResult } from './types';

export interface GitHubConfig {
  owner: string;
  repo: string;
  ref?: string;
  token?: string;
  /** contents | releases | both (both: /code and /releases) */
  mode?: string;
  apiBase?: string;
}

interface ContentItem {
  type: 'file' | 'dir' | 'symlink' | 'submodule';
  name: string;
  path: string;
  size: number;
  sha: string;
}

interface Release {
  tag_name: string;
  published_at?: string;
  created_at?: string;
  assets: { id: number; name: string; size: number; updated_at?: string; content_type?: string }[];
}

const readonly = () => new HttpError(405, 'GitHub storage is read-only', 'readonly');

/** tags may contain "/" — keep them one path segment */
export function tagDir(tag: string): string {
  return tag.replace(/\//g, '∕');
}

export class GitHubDriver extends BaseDriver {
  readonly type = 'github';
  readonly capabilities = { presign: false, multipart: false, rangeRead: true, readOnly: true };
  private api: string;
  private fetchFn: typeof fetch;
  private mode: 'contents' | 'releases' | 'both';
  private releases: { at: number; list: Release[] } | null = null;

  constructor(
    private cfg: GitHubConfig,
    ctx: DriverContext,
  ) {
    super();
    if (!cfg.owner || !cfg.repo) throw new Error('GitHub owner and repo are required');
    this.api = (cfg.apiBase || 'https://api.github.com').replace(/\/+$/, '');
    this.fetchFn = ctx.fetch;
    this.mode = (['contents', 'releases', 'both'].includes(cfg.mode ?? '') ? cfg.mode : 'contents') as 'contents' | 'releases' | 'both';
  }

  private headers(accept = 'application/vnd.github+json'): Record<string, string> {
    const h: Record<string, string> = { accept, 'x-github-api-version': '2022-11-28', 'user-agent': 'edgedock' };
    if (this.cfg.token) h.authorization = `Bearer ${this.cfg.token}`;
    return h;
  }

  private get repoUrl() {
    return `${this.api}/repos/${encodeURIComponent(this.cfg.owner)}/${encodeURIComponent(this.cfg.repo)}`;
  }

  /** split a storage path into section + inner path */
  private section(path: string): { kind: 'root' | 'contents' | 'releases'; inner: string } {
    const p = normalizePath(path);
    if (this.mode === 'contents') return { kind: 'contents', inner: p };
    if (this.mode === 'releases') return { kind: 'releases', inner: p };
    if (p === '/') return { kind: 'root', inner: '/' };
    const [, top, ...rest] = p.split('/');
    const inner = '/' + rest.join('/');
    if (top === 'code') return { kind: 'contents', inner: normalizePath(inner) };
    if (top === 'releases') return { kind: 'releases', inner: normalizePath(inner) };
    return { kind: 'root', inner: p };
  }

  private prefix(kind: 'contents' | 'releases'): string {
    return this.mode === 'both' ? (kind === 'contents' ? '/code' : '/releases') : '';
  }

  // ------------------------------------------------------------ contents
  private contentsUrl(inner: string): string {
    const enc = inner
      .split('/')
      .filter(Boolean)
      .map((s) => encodeURIComponent(s))
      .join('/');
    const u = `${this.repoUrl}/contents/${enc}`;
    return this.cfg.ref ? `${u}?ref=${encodeURIComponent(this.cfg.ref)}` : u;
  }

  private async contents(inner: string): Promise<ContentItem | ContentItem[] | null> {
    const res = await fetchRetry(this.fetchFn, this.contentsUrl(inner), () => ({ headers: this.headers() }));
    if (res.status === 404) return null;
    await ensureOk(res, 'GitHub contents');
    return (await res.json()) as ContentItem | ContentItem[];
  }

  private itemEntry(it: ContentItem): FileEntry {
    const isDir = it.type === 'dir' || it.type === 'submodule';
    return { name: it.name, path: joinPath(this.prefix('contents'), '/' + it.path), isDir, size: isDir ? 0 : it.size, etag: it.sha, contentType: isDir ? undefined : mimeFromPath(it.name) };
  }

  // ------------------------------------------------------------ releases
  private async releaseList(): Promise<Release[]> {
    if (this.releases && Date.now() - this.releases.at < 60_000) return this.releases.list;
    const list: Release[] = [];
    for (let page = 1; page <= 10; page++) {
      const res = await fetchRetry(this.fetchFn, `${this.repoUrl}/releases?per_page=100&page=${page}`, () => ({ headers: this.headers() }));
      await ensureOk(res, 'GitHub releases');
      const batch = (await res.json()) as Release[];
      list.push(...batch);
      if (batch.length < 100) break;
    }
    this.releases = { at: Date.now(), list };
    return list;
  }

  private async findAsset(inner: string) {
    const [, tag, name, ...more] = inner.split('/');
    if (!tag || !name || more.length) return null;
    const rel = (await this.releaseList()).find((r) => tagDir(r.tag_name) === tag);
    const asset = rel?.assets.find((a) => a.name === name);
    return rel && asset ? { rel, asset } : null;
  }

  // ------------------------------------------------------------ driver API
  async list(path: string): Promise<FileEntry[]> {
    const s = this.section(path);
    if (s.kind === 'root') {
      if (s.inner !== '/') throw new ProviderError(404, `Not found: ${path}`);
      return [
        { name: 'code', path: '/code', isDir: true, size: 0 },
        { name: 'releases', path: '/releases', isDir: true, size: 0 },
      ];
    }
    if (s.kind === 'contents') {
      const c = await this.contents(s.inner);
      if (!c || !Array.isArray(c)) throw new ProviderError(404, `Not a directory: ${path}`);
      return c.map((it) => this.itemEntry(it));
    }
    const rels = await this.releaseList();
    const pre = this.prefix('releases');
    if (s.inner === '/') {
      return rels.map((r) => ({ name: tagDir(r.tag_name), path: joinPath(pre, '/' + tagDir(r.tag_name)), isDir: true, size: 0, modified: Date.parse(r.published_at ?? r.created_at ?? '') || undefined }));
    }
    const tag = s.inner.split('/')[1];
    const rel = rels.find((r) => tagDir(r.tag_name) === tag);
    if (!rel || s.inner.split('/').length > 2) throw new ProviderError(404, `Not found: ${path}`);
    return rel.assets.map((a) => ({
      name: a.name,
      path: joinPath(pre, `/${tag}/${a.name}`),
      isDir: false,
      size: a.size,
      modified: a.updated_at ? Date.parse(a.updated_at) : undefined,
      contentType: a.content_type || mimeFromPath(a.name),
      etag: String(a.id),
    }));
  }

  async stat(path: string): Promise<FileEntry | null> {
    const p = normalizePath(path);
    if (p === '/') return { name: '', path: '/', isDir: true, size: 0 };
    const s = this.section(p);
    if (s.kind === 'root') return null;
    if (s.inner === '/') return { name: basename(p), path: p, isDir: true, size: 0 };
    if (s.kind === 'contents') {
      const c = await this.contents(s.inner);
      if (!c) return null;
      if (Array.isArray(c)) return { name: basename(p), path: p, isDir: true, size: 0 };
      return { ...this.itemEntry(c), path: p };
    }
    const parts = s.inner.split('/');
    if (parts.length === 2) {
      const rel = (await this.releaseList()).find((r) => tagDir(r.tag_name) === parts[1]);
      return rel ? { name: parts[1], path: p, isDir: true, size: 0 } : null;
    }
    const f = await this.findAsset(s.inner);
    return f ? { name: f.asset.name, path: p, isDir: false, size: f.asset.size, contentType: f.asset.content_type || mimeFromPath(f.asset.name), etag: String(f.asset.id) } : null;
  }

  async read(path: string, opts: { range?: ByteRange } = {}): Promise<ReadResult> {
    const st = await this.stat(path);
    if (!st || st.isDir) throw new ProviderError(404, `Not found: ${path}`);
    const s = this.section(path);
    const headers: Record<string, string> = {};
    if (opts.range) headers.range = rangeHeader(opts.range);
    let res: Response;
    if (s.kind === 'contents') {
      // raw media type: up to 100 MB per file through the API
      res = await fetchRetry(this.fetchFn, this.contentsUrl(s.inner), () => ({ headers: { ...this.headers('application/vnd.github.raw'), ...headers } }));
    } else {
      const f = (await this.findAsset(s.inner))!;
      // redirects to a signed storage URL; fetch drops Authorization on the cross-origin hop
      res = await fetchRetry(this.fetchFn, `${this.repoUrl}/releases/assets/${f.asset.id}`, () => ({ headers: { ...this.headers('application/octet-stream'), ...headers } }));
    }
    await ensureOk(res, 'GitHub download');
    const r: ReadResult = { body: res.body, size: st.size, contentType: st.contentType, etag: st.etag };
    if (opts.range) {
      const end = Math.min(opts.range.end ?? st.size - 1, st.size - 1);
      r.range = { start: opts.range.start, end };
      if (res.status !== 206 && res.body) r.body = sliceStream(res.body, opts.range.start, end);
    }
    return r;
  }

  async write(): Promise<void> {
    throw readonly();
  }
  async delete(): Promise<void> {
    throw readonly();
  }
  async mkdir(): Promise<void> {
    throw readonly();
  }
  async rename(): Promise<void> {
    throw readonly();
  }
  async move(): Promise<void> {
    throw readonly();
  }
  async copy(): Promise<void> {
    throw readonly();
  }

  async test(): Promise<void> {
    await ensureOk(await fetchRetry(this.fetchFn, this.repoUrl, () => ({ headers: this.headers() })), 'GitHub repository');
  }
}

export const githubDefinition: DriverDefinition = {
  type: 'github',
  label: 'GitHub（唯讀：Repo 內容 / Releases）',
  runtimes: ['workers', 'node'],
  readOnly: true,
  notes:
    'Read-only. Token optional for public repos (raises the rate limit from 60 to 5000 requests/hour); for private repos use a fine-grained token with "Contents: read". Mode "both" shows /code and /releases.',
  notesZh:
    '唯讀。公開 Repo 可不填 Token（填了 API 額度由每小時 60 次提高到 5000 次）；私人 Repo 請用細粒度 Token 並給「Contents: Read」。模式選「兩者」時會顯示 /code 與 /releases 兩個資料夾。',
  fields: [
    { key: 'owner', label: 'Owner', labelZh: '擁有者（使用者或組織）', type: 'text', required: true },
    { key: 'repo', label: 'Repository', labelZh: 'Repo 名稱', type: 'text', required: true },
    {
      key: 'mode',
      label: 'Show',
      labelZh: '顯示內容',
      type: 'select',
      default: 'contents',
      options: [
        { value: 'contents', label: 'Repository contents（程式碼）' },
        { value: 'releases', label: 'Release assets（發行檔案）' },
        { value: 'both', label: 'Both（兩者）' },
      ],
    },
    { key: 'ref', label: 'Branch / tag / commit', labelZh: '分支／標籤／commit（留空 = 預設分支）', type: 'text' },
    { key: 'token', label: 'Token (optional)', labelZh: 'Token（選填）', type: 'password', secret: true },
    { key: 'apiBase', label: 'API base (GitHub Enterprise)', labelZh: 'API 位址（GitHub Enterprise 才需修改）', type: 'text', default: 'https://api.github.com' },
  ],
  create: (config, ctx) => new GitHubDriver(config as unknown as GitHubConfig, ctx),
};
