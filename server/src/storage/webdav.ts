import { XMLParser } from 'fast-xml-parser';
import { basename, joinPath, normalizePath } from '../lib/path';
import { mimeFromPath } from '../lib/mime';
import { BaseDriver, fetchBody, isHidden, rangeHeader } from './base';
import { encodeKey } from './s3';
import type { ByteRange, DriverContext, DriverDefinition, FileEntry, ReadResult, WriteBody, WriteOptions } from './types';

export interface WebDAVConfig {
  url: string;
  username?: string;
  password?: string;
  root?: string;
}

const xml = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  parseTagValue: false,
  isArray: (name) => name === 'response' || name === 'propstat',
});

export class WebDAVError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface DavProps {
  href: string;
  isDir: boolean;
  size: number;
  modified?: number;
  etag?: string;
  contentType?: string;
}

/** Parse a WebDAV multistatus PROPFIND response. Exported for tests. */
export function parseMultistatus(text: string): DavProps[] {
  const doc = xml.parse(text);
  const responses: any[] = doc?.multistatus?.response ?? [];
  const out: DavProps[] = [];
  for (const r of responses) {
    const href = String(r.href ?? '');
    const okStat = (r.propstat ?? []).find((ps: any) => /\s200\s/.test(String(ps.status ?? ' 200 '))) ?? r.propstat?.[0];
    const prop = okStat?.prop ?? {};
    const rt = prop.resourcetype;
    const isDir = rt !== undefined && rt !== '' && typeof rt === 'object' && 'collection' in rt;
    out.push({
      href,
      isDir: isDir || href.endsWith('/'),
      size: Number(prop.getcontentlength ?? 0) || 0,
      modified: prop.getlastmodified ? Date.parse(prop.getlastmodified) : undefined,
      etag: prop.getetag ? String(prop.getetag).replace(/"/g, '') : undefined,
      contentType: prop.getcontenttype || undefined,
    });
  }
  return out;
}

const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:getetag/><d:getcontenttype/></d:prop></d:propfind>';

export class WebDAVDriver extends BaseDriver {
  readonly type = 'webdav';
  readonly capabilities = { presign: false, multipart: false, rangeRead: true };
  private base: URL;
  private root: string;
  private auth?: string;
  private fetchFn: typeof fetch;

  constructor(cfg: WebDAVConfig, ctx: DriverContext = { fetch: (...a) => fetch(...a) }) {
    super();
    if (!cfg.url) throw new Error('WebDAV url is required');
    this.base = new URL(cfg.url.endsWith('/') ? cfg.url : cfg.url + '/');
    this.root = normalizePath(cfg.root || '/');
    if (cfg.username) this.auth = 'Basic ' + btoa(String.fromCharCode(...new TextEncoder().encode(`${cfg.username}:${cfg.password ?? ''}`)));
    this.fetchFn = ctx.fetch;
  }

  private url(path: string, dir = false): string {
    const full = joinPath(this.root, path);
    const rel = encodeKey(full.slice(1));
    return new URL(rel + (dir && rel ? '/' : ''), this.base).toString();
  }

  private hrefToPath(href: string): string {
    let pathname: string;
    try {
      pathname = new URL(href, this.base).pathname;
    } catch {
      pathname = href;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      decoded = pathname;
    }
    const basePath = decodeURIComponent(this.base.pathname);
    const relToBase = normalizePath(decoded.startsWith(basePath) ? decoded.slice(basePath.length) : decoded);
    if (this.root === '/') return relToBase;
    return normalizePath(relToBase.slice(this.root.length));
  }

  private async req(method: string, url: string, init: { headers?: Record<string, string>; body?: WriteBody; size?: number; ok?: number[] } = {}) {
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (this.auth) headers['authorization'] = this.auth;
    let body: BodyInit | undefined;
    let extra: Record<string, unknown> = {};
    if (init.body !== undefined) {
      const fb = fetchBody(init.body, init.size);
      body = fb.body;
      extra = fb.init;
      Object.assign(headers, fb.headers);
    }
    const res = await this.fetchFn(url, { method, headers, body, ...extra } as RequestInit);
    if (!res.ok && !(init.ok ?? []).includes(res.status)) {
      const t = await res.text().catch(() => '');
      throw new WebDAVError(res.status, `WebDAV ${method} ${res.status}: ${t.slice(0, 200)}`);
    }
    return res;
  }

  private async propfind(path: string, depth: '0' | '1'): Promise<DavProps[] | null> {
    const res = await this.req('PROPFIND', this.url(path, depth === '1'), {
      headers: { depth, 'content-type': 'application/xml; charset=utf-8' },
      body: PROPFIND_BODY,
      ok: [404],
    });
    if (res.status === 404) return null;
    return parseMultistatus(await res.text());
  }

  async list(path: string): Promise<FileEntry[]> {
    const self = normalizePath(path);
    const items = (await this.propfind(self, '1')) ?? [];
    const out: FileEntry[] = [];
    for (const it of items) {
      const p = this.hrefToPath(it.href);
      if (p === self) continue;
      const name = basename(p);
      if (!name || isHidden(name)) continue;
      out.push({
        name,
        path: p,
        isDir: it.isDir,
        size: it.size,
        modified: it.modified,
        etag: it.etag,
        contentType: it.isDir ? undefined : it.contentType || mimeFromPath(name),
      });
    }
    return out;
  }

  async stat(path: string): Promise<FileEntry | null> {
    const p = normalizePath(path);
    const items = await this.propfind(p, '0');
    if (!items || !items.length) return null;
    const it = items[0];
    return { name: basename(p), path: p, isDir: it.isDir, size: it.size, modified: it.modified, etag: it.etag, contentType: it.contentType };
  }

  async read(path: string, opts: { range?: ByteRange } = {}): Promise<ReadResult> {
    const headers: Record<string, string> = {};
    if (opts.range) headers['range'] = rangeHeader(opts.range);
    const res = await this.req('GET', this.url(path), { headers });
    let size = Number(res.headers.get('content-length') ?? 0);
    let range: ReadResult['range'];
    const cr = res.headers.get('content-range');
    if (res.status === 206 && cr) {
      const m = /bytes (\d+)-(\d+)\/(\d+|\*)/.exec(cr);
      if (m) {
        range = { start: Number(m[1]), end: Number(m[2]) };
        if (m[3] !== '*') size = Number(m[3]);
      }
    }
    return { body: res.body, size, range, contentType: res.headers.get('content-type') ?? mimeFromPath(path), etag: res.headers.get('etag') ?? undefined };
  }

  async write(path: string, body: WriteBody, opts: WriteOptions = {}): Promise<void> {
    await this.req('PUT', this.url(path), { body, size: opts.size, headers: { 'content-type': opts.contentType || mimeFromPath(path) } });
  }

  async mkdir(path: string): Promise<void> {
    // create parents as needed
    const parts = normalizePath(path).split('/').filter(Boolean);
    let cur = '';
    for (const part of parts) {
      cur += '/' + part;
      await this.req('MKCOL', this.url(cur, true), { ok: [405, 301] }); // 405 = exists
    }
  }

  async delete(path: string): Promise<void> {
    await this.req('DELETE', this.url(path), { ok: [404] });
  }

  private async moveOrCopy(method: 'MOVE' | 'COPY', from: string, to: string) {
    const st = await this.stat(from);
    await this.req(method, this.url(from, st?.isDir), { headers: { destination: this.url(to, st?.isDir), overwrite: 'T', depth: 'infinity' } });
  }

  rename(from: string, to: string) {
    return this.moveOrCopy('MOVE', from, to);
  }
  move(from: string, to: string) {
    return this.moveOrCopy('MOVE', from, to);
  }
  copy(from: string, to: string) {
    return this.moveOrCopy('COPY', from, to);
  }

  async test(): Promise<void> {
    const r = await this.propfind('/', '0');
    if (!r) throw new WebDAVError(404, 'Root not found');
  }
}

export const webdavDefinition: DriverDefinition = {
  type: 'webdav',
  label: 'WebDAV（上游）',
  runtimes: ['workers', 'node'],
  fields: [
    { key: 'url', label: 'WebDAV URL', type: 'text', required: true, placeholder: 'https://dav.example.com/remote.php/dav/files/me/' },
    { key: 'username', label: 'Username', type: 'text', secret: true },
    { key: 'password', label: 'Password', type: 'password', secret: true },
    { key: 'root', label: 'Root path', type: 'text', default: '/' },
  ],
  create: (config, ctx) => new WebDAVDriver(config as unknown as WebDAVConfig, ctx),
};
