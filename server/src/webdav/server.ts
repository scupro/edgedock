import { Hono, type Context } from 'hono';
import { canRead, canTraverse, canWrite } from '../lib/auth';
import { HttpError } from '../lib/errors';
import { indexRemove, indexUpsert } from '../lib/fileindex';
import { mimeFromPath } from '../lib/mime';
import { dirname, isWithin, normalizePath } from '../lib/path';
import { serveVfsFile } from '../lib/serve';
import { getSettings } from '../lib/settings';
import type { AppEnv, Principal } from '../lib/types';
import { encodeKey } from '../storage/s3';
import { Vfs } from '../storage/mounts';
import type { FileEntry } from '../storage/types';

export const DAV_PREFIX = '/dav';
const ALLOW = 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, MOVE, COPY, LOCK, UNLOCK';

export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function davHref(vpath: string, isDir: boolean): string {
  const p = normalizePath(vpath);
  const enc = p === '/' ? '' : '/' + encodeKey(p.slice(1));
  return DAV_PREFIX + enc + (isDir ? '/' : '');
}

/** Build a 207 multistatus body for PROPFIND. Exported for tests. */
export function propfindXml(entries: FileEntry[]): string {
  const parts = entries.map((e) => {
    const props = [
      `<d:displayname>${escapeXml(e.name)}</d:displayname>`,
      e.isDir ? '<d:resourcetype><d:collection/></d:resourcetype>' : '<d:resourcetype/>',
      e.modified ? `<d:getlastmodified>${new Date(e.modified).toUTCString()}</d:getlastmodified>` : '',
      e.modified ? `<d:creationdate>${new Date(e.modified).toISOString()}</d:creationdate>` : '',
      e.isDir ? '' : `<d:getcontentlength>${e.size}</d:getcontentlength>`,
      e.isDir ? '' : `<d:getcontenttype>${escapeXml((e.contentType || mimeFromPath(e.name)).split(';')[0])}</d:getcontenttype>`,
      e.etag ? `<d:getetag>"${escapeXml(e.etag)}"</d:getetag>` : '',
      '<d:supportedlock><d:lockentry><d:lockscope><d:exclusive/></d:lockscope><d:locktype><d:write/></d:locktype></d:lockentry></d:supportedlock>',
    ].join('');
    return `<d:response><d:href>${escapeXml(davHref(e.path, e.isDir))}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
  });
  return `<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus xmlns:d="DAV:">${parts.join('')}</d:multistatus>`;
}

function lockXml(token: string, owner: string, depth: string, timeout: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<d:prop xmlns:d="DAV:"><d:lockdiscovery><d:activelock><d:locktype><d:write/></d:locktype><d:lockscope><d:exclusive/></d:lockscope><d:depth>${escapeXml(depth)}</d:depth><d:owner>${owner}</d:owner><d:timeout>${escapeXml(timeout)}</d:timeout><d:locktoken><d:href>${token}</d:href></d:locktoken></d:activelock></d:lockdiscovery></d:prop>`;
}

/** URL path (/dav/a%20b/c) -> virtual path (/a b/c) */
export function davPathFromUrl(pathname: string): string {
  let rest = pathname.startsWith(DAV_PREFIX) ? pathname.slice(DAV_PREFIX.length) : pathname;
  rest = rest
    .split('/')
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    })
    .join('/');
  return normalizePath(rest);
}

function davError(status: number, text = ''): Response {
  return new Response(text, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

function unauthorizedResponse(): Response {
  return new Response('Unauthorized', { status: 401, headers: { 'www-authenticate': 'Basic realm="EdgeDock WebDAV", charset="UTF-8"' } });
}

// ------------------------------------------------------------ cache
function cacheKey(url: URL, kind: 'get' | 'propfind', depth = '1'): Request {
  const u = new URL(url.toString());
  u.search = '';
  if (kind === 'propfind') u.searchParams.set('__edgedock_propfind', depth);
  return new Request(u.toString(), { method: 'GET' });
}

async function invalidate(c: Context<AppEnv>, vpaths: string[]) {
  const cache = c.get('runtime').cache();
  if (!cache) return;
  const origin = new URL(c.req.url).origin;
  const jobs: Promise<unknown>[] = [];
  for (const vp of vpaths) {
    for (const p of [vp, dirname(vp)]) {
      for (const isDir of [true, false]) {
        const u = new URL(davHref(p, isDir), origin);
        jobs.push(cache.delete(cacheKey(u, 'get')), cache.delete(cacheKey(u, 'propfind', '0')), cache.delete(cacheKey(u, 'propfind', '1')));
      }
    }
  }
  await Promise.allSettled(jobs);
}

// ------------------------------------------------------------ handler
export const davRoutes = new Hono<AppEnv>();

davRoutes.all('*', async (c) => {
  const method = c.req.method.toUpperCase();
  const url = new URL(c.req.url);
  const vpath = davPathFromUrl(url.pathname);
  const p = c.get('principal');

  if (method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: { dav: '1, 2', allow: ALLOW, 'ms-author-via': 'DAV', 'content-length': '0' } });
  }
  if (p.kind === 'anonymous') return unauthorizedResponse();

  try {
    switch (method) {
      case 'PROPFIND':
        return await handlePropfind(c, p, vpath, url);
      case 'PROPPATCH':
        return handleProppatch(vpath);
      case 'GET':
      case 'HEAD':
        return await handleGet(c, p, vpath, url, method);
      case 'PUT':
        return await handlePut(c, p, vpath);
      case 'DELETE':
        return await handleDelete(c, p, vpath);
      case 'MKCOL':
        return await handleMkcol(c, p, vpath);
      case 'MOVE':
      case 'COPY':
        return await handleMoveCopy(c, p, vpath, method);
      case 'LOCK': {
        // Fake exclusive lock so Windows Explorer / macOS Finder can write.
        const token = `opaquelocktoken:${crypto.randomUUID()}`;
        const body = await c.req.text().catch(() => '');
        const owner = /<(?:\w+:)?owner[^>]*>([\s\S]*?)<\/(?:\w+:)?owner>/i.exec(body)?.[1] ?? '';
        const timeout = c.req.header('timeout') ?? 'Second-3600';
        return new Response(lockXml(token, owner, c.req.header('depth') ?? '0', timeout.split(',')[0]), {
          status: 200,
          headers: { 'content-type': 'application/xml; charset=utf-8', 'lock-token': `<${token}>` },
        });
      }
      case 'UNLOCK':
        return new Response(null, { status: 204 });
      default:
        return new Response('Method Not Allowed', { status: 405, headers: { allow: ALLOW } });
    }
  } catch (e) {
    if (e instanceof HttpError) return davError(e.status, e.message);
    const status = (e as { status?: number }).status;
    if (status === 404) return davError(404, 'Not Found');
    console.error('[edgedock] dav error', method, vpath, e);
    return davError(500, (e as Error).message);
  }
});

async function handlePropfind(c: Context<AppEnv>, p: Principal, vpath: string, url: URL): Promise<Response> {
  if (!canTraverse(p, vpath)) return davError(403, 'Forbidden');
  let depth = c.req.header('depth') ?? '1';
  if (depth !== '0') depth = '1'; // "infinity" is not supported -> 1
  const cache = c.get('runtime').cache();
  const settings = await getSettings(c.env);
  const ttl = settings.webdavCacheTtl;
  const key = cacheKey(url, 'propfind', depth);
  if (cache && ttl > 0) {
    const hit = await cache.match(key);
    if (hit) {
      const res = new Response(hit.body, hit);
      res.headers.set('x-edgedock-cache', 'HIT');
      return res;
    }
  }
  const vfs = await Vfs.create(c.env);
  const self = await vfs.stat(vpath);
  if (!self) return davError(404, 'Not Found');
  const entries: FileEntry[] = [{ ...self, path: vpath, name: vpath === '/' ? '' : self.name }];
  if (self.isDir && depth === '1') {
    let children = await vfs.list(vpath);
    if (!canRead(p, vpath)) children = children.filter((ch) => isWithin(p.pathPrefix, ch.path));
    entries.push(...children);
  }
  const res = new Response(propfindXml(entries), { status: 207, headers: { 'content-type': 'application/xml; charset=utf-8', dav: '1, 2' } });
  if (cache && ttl > 0) {
    const toCache = res.clone();
    const cached = new Response(toCache.body, { status: 200, headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': `max-age=${ttl}` } });
    const put = cache.put(key, cached).catch(() => {});
    c.get('runtime').waitUntil?.(put);
    // 207 must be returned, cache stores it as 200
    return new Response(res.body, { status: 207, headers: res.headers });
  }
  return res;
}

function handleProppatch(vpath: string): Response {
  // Accept and ignore (Windows sets Win32 timestamps); report success.
  const body = `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>${escapeXml(davHref(vpath, false))}</d:href><d:propstat><d:prop/><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
  return new Response(body, { status: 207, headers: { 'content-type': 'application/xml; charset=utf-8' } });
}

async function handleGet(c: Context<AppEnv>, p: Principal, vpath: string, url: URL, method: string): Promise<Response> {
  if (!canRead(p, vpath) && !canTraverse(p, vpath)) return davError(403, 'Forbidden');
  const vfs = await Vfs.create(c.env);
  const st = await vfs.stat(vpath);
  if (!st) return davError(404, 'Not Found');
  if (st.isDir) {
    const items = await vfs.list(vpath).catch(() => []);
    const html = `<!doctype html><meta charset="utf-8"><title>${escapeXml(vpath)}</title><h1>Index of ${escapeXml(vpath)}</h1><ul>${items
      .filter((i) => canRead(p, i.path) || canTraverse(p, i.path))
      .map((i) => `<li><a href="${escapeXml(davHref(i.path, i.isDir))}">${escapeXml(i.name)}${i.isDir ? '/' : ''}</a></li>`)
      .join('')}</ul>`;
    return new Response(method === 'HEAD' ? null : html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
  if (!canRead(p, vpath)) return davError(403, 'Forbidden');
  const cache = c.get('runtime').cache();
  const ttl = (await getSettings(c.env)).webdavCacheTtl;
  const range = c.req.header('range');
  const key = cacheKey(url, 'get');
  if (cache && ttl > 0 && method === 'GET') {
    // The Cache API answers Range requests from a cached full object.
    const hit = await cache.match(range ? new Request(key.url, { headers: { range } }) : key);
    if (hit) {
      const res = new Response(hit.body, hit);
      res.headers.set('x-edgedock-cache', 'HIT');
      return res;
    }
  }
  const res = await serveVfsFile(vfs, vpath, { method, rangeHeader: range, ifNoneMatch: c.req.header('if-none-match'), download: false });
  if (cache && ttl > 0 && method === 'GET' && !range && res.status === 200 && st.size <= 100 * 1024 * 1024) {
    const [a, b] = res.body!.tee();
    const headers = new Headers(res.headers);
    headers.set('cache-control', `max-age=${ttl}`);
    const put = cache.put(key, new Response(b, { status: 200, headers })).catch(() => {});
    c.get('runtime').waitUntil?.(put);
    return new Response(a, { status: 200, headers: res.headers });
  }
  return res;
}

async function handlePut(c: Context<AppEnv>, p: Principal, vpath: string): Promise<Response> {
  if (!canWrite(p, vpath)) return davError(403, 'Forbidden');
  const vfs = await Vfs.create(c.env);
  const existed = await vfs.stat(vpath).catch(() => null);
  if (existed?.isDir) return davError(405, 'Is a collection');
  const len = c.req.header('content-length');
  const size = len !== undefined ? Number(len) : undefined;
  const body = c.req.raw.body ?? new Uint8Array(0);
  if (size === undefined && c.req.raw.body) {
    // chunked transfer (e.g. macOS Finder): buffer it
    const buf = new Uint8Array(await c.req.arrayBuffer());
    await vfs.write(vpath, buf, { size: buf.byteLength, contentType: c.req.header('content-type') ?? undefined });
  } else {
    await vfs.write(vpath, size === 0 ? new Uint8Array(0) : body, { size, contentType: c.req.header('content-type') ?? undefined });
  }
  const r = vfs.resolve(vpath);
  if (r) await indexUpsert(c.env, r.mount.row.id, vpath, { isDir: false, size: size ?? 0 });
  await invalidate(c, [vpath]);
  return new Response(null, { status: existed ? 204 : 201 });
}

async function handleDelete(c: Context<AppEnv>, p: Principal, vpath: string): Promise<Response> {
  if (!canWrite(p, vpath)) return davError(403, 'Forbidden');
  const vfs = await Vfs.create(c.env);
  const st = await vfs.stat(vpath);
  if (!st) return davError(404, 'Not Found');
  await vfs.delete(vpath);
  await indexRemove(c.env, vpath);
  await invalidate(c, [vpath]);
  return new Response(null, { status: 204 });
}

async function handleMkcol(c: Context<AppEnv>, p: Principal, vpath: string): Promise<Response> {
  if (!canWrite(p, vpath)) return davError(403, 'Forbidden');
  const vfs = await Vfs.create(c.env);
  if (await vfs.stat(vpath)) return davError(405, 'Already exists');
  await vfs.mkdir(vpath);
  const r = vfs.resolve(vpath);
  if (r) await indexUpsert(c.env, r.mount.row.id, vpath, { isDir: true });
  await invalidate(c, [vpath]);
  return new Response(null, { status: 201 });
}

async function handleMoveCopy(c: Context<AppEnv>, p: Principal, vpath: string, method: 'MOVE' | 'COPY'): Promise<Response> {
  const destHeader = c.req.header('destination');
  if (!destHeader) return davError(400, 'Destination header required');
  let dest: string;
  try {
    dest = davPathFromUrl(new URL(destHeader, c.req.url).pathname);
  } catch {
    return davError(400, 'Bad Destination');
  }
  if (method === 'MOVE' ? !canWrite(p, vpath) : !canRead(p, vpath)) return davError(403, 'Forbidden');
  if (!canWrite(p, dest)) return davError(403, 'Forbidden');
  const overwrite = (c.req.header('overwrite') ?? 'T').toUpperCase() !== 'F';
  const vfs = await Vfs.create(c.env);
  if (!(await vfs.stat(vpath))) return davError(404, 'Not Found');
  const existing = await vfs.stat(dest);
  if (existing && !overwrite) return davError(412, 'Destination exists');
  if (existing) await vfs.delete(dest);
  await vfs.transfer(vpath, dest, method === 'MOVE' ? 'move' : 'copy');
  if (method === 'MOVE') await indexRemove(c.env, vpath);
  const r = vfs.resolve(dest);
  const st = await vfs.stat(dest).catch(() => null);
  if (r && st) await indexUpsert(c.env, r.mount.row.id, dest, st);
  await invalidate(c, [vpath, dest]);
  return new Response(null, { status: existing ? 204 : 201 });
}

