import { Hono } from 'hono';
import { sign, verify } from 'hono/jwt';
import { assertRead, assertWrite, canRead, canTraverse } from '../lib/auth';
import { jwtSecret } from '../lib/crypto';
import { badRequest, forbidden, notFound, unauthorized } from '../lib/errors';
import { indexRemove, indexUpsert, searchIndex } from '../lib/fileindex';
import { basename, isWithin, joinPath, normalizePath } from '../lib/path';
import { serveVfsFile } from '../lib/serve';
import type { AppEnv, Env } from '../lib/types';
import { Vfs } from '../storage/mounts';
import type { S3Driver } from '../storage/s3';

export const fsRoutes = new Hono<AppEnv>();
/** Signed, cookie-less file links (usable in <img>/<video>/<iframe>). Mounted at /api/file */
export const fileLinkRoutes = new Hono<AppEnv>();

const qpath = (v: string | undefined) => normalizePath(v ?? '/');

fsRoutes.get('/list', async (c) => {
  const p = c.get('principal');
  const path = qpath(c.req.query('path'));
  if (p.kind === 'anonymous') throw unauthorized();
  if (!canTraverse(p, path)) throw forbidden();
  const vfs = await Vfs.create(c.env);
  let items = await vfs.list(path);
  // keys confined to a prefix only see the branch leading to it
  if (!canRead(p, path)) items = items.filter((i) => isWithin(p.pathPrefix, i.path));
  items.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, 'zh-Hant') : a.isDir ? -1 : 1));
  const r = vfs.resolve(path);
  return c.json({
    path,
    items,
    storage: r ? { id: r.mount.row.id, name: r.mount.row.name, type: r.mount.row.type, capabilities: r.mount.driver.capabilities } : null,
    writable: !!r && p.permission !== 'read' && canRead(p, path),
  });
});

fsRoutes.get('/stat', async (c) => {
  const path = qpath(c.req.query('path'));
  assertRead(c.get('principal'), path);
  const st = await (await Vfs.create(c.env)).stat(path);
  if (!st) throw notFound();
  return c.json(st);
});

fsRoutes.post('/mkdir', async (c) => {
  const { path } = await c.req.json<{ path: string }>();
  const p = normalizePath(path);
  assertWrite(c.get('principal'), p);
  const vfs = await Vfs.create(c.env);
  await vfs.mkdir(p);
  const r = vfs.resolve(p);
  if (r) await indexUpsert(c.env, r.mount.row.id, p, { isDir: true });
  return c.json({ ok: true });
});

fsRoutes.post('/delete', async (c) => {
  const { paths } = await c.req.json<{ paths: string[] }>();
  if (!Array.isArray(paths) || !paths.length) throw badRequest('paths required');
  const vfs = await Vfs.create(c.env);
  for (const raw of paths) {
    const p = normalizePath(raw);
    assertWrite(c.get('principal'), p);
    await vfs.delete(p);
    await indexRemove(c.env, p);
  }
  return c.json({ ok: true });
});

fsRoutes.post('/rename', async (c) => {
  const { path, name } = await c.req.json<{ path: string; name: string }>();
  const p = normalizePath(path);
  const vfs = await Vfs.create(c.env);
  const target = joinPath(p, '..', name);
  assertWrite(c.get('principal'), p);
  assertWrite(c.get('principal'), target);
  await vfs.rename(p, name);
  await reindexMoved(c.env, vfs, p, target);
  return c.json({ ok: true, path: target });
});

async function reindexMoved(env: Env, vfs: Vfs, from: string, to: string) {
  await indexRemove(env, from);
  const st = await vfs.stat(to).catch(() => null);
  const r = vfs.resolve(to);
  if (st && r) await indexUpsert(env, r.mount.row.id, to, st);
}

for (const op of ['move', 'copy'] as const) {
  fsRoutes.post('/' + op, async (c) => {
    const { paths, to } = await c.req.json<{ paths: string[]; to: string }>();
    if (!Array.isArray(paths) || !paths.length || !to) throw badRequest('paths and to required');
    const dest = normalizePath(to);
    const vfs = await Vfs.create(c.env);
    for (const raw of paths) {
      const src = normalizePath(raw);
      const target = joinPath(dest, basename(src));
      if (op === 'move') assertWrite(c.get('principal'), src);
      else assertRead(c.get('principal'), src);
      assertWrite(c.get('principal'), target);
      await vfs.transfer(src, target, op);
      if (op === 'move') await reindexMoved(c.env, vfs, src, target);
      else {
        const r = vfs.resolve(target);
        const st = await vfs.stat(target).catch(() => null);
        if (r && st) await indexUpsert(c.env, r.mount.row.id, target, st);
      }
    }
    return c.json({ ok: true });
  });
}

/** Write a (small) text/binary body to a path; used by the Markdown editor "save". */
fsRoutes.put('/write', async (c) => {
  const p = qpath(c.req.query('path'));
  assertWrite(c.get('principal'), p);
  const vfs = await Vfs.create(c.env);
  const body = new Uint8Array(await c.req.arrayBuffer());
  await vfs.write(p, body, { size: body.byteLength, contentType: c.req.header('content-type') ?? undefined });
  const r = vfs.resolve(p);
  if (r) await indexUpsert(c.env, r.mount.row.id, p, { isDir: false, size: body.byteLength });
  return c.json({ ok: true, size: body.byteLength });
});

/** Direct streaming download for API clients (Authorization header). */
fsRoutes.on(['GET', 'HEAD'], '/download', async (c) => {
  const p = qpath(c.req.query('path'));
  assertRead(c.get('principal'), p);
  return serveVfsFile(await Vfs.create(c.env), p, {
    download: c.req.query('download') === '1',
    method: c.req.method,
    rangeHeader: c.req.header('range'),
    ifNoneMatch: c.req.header('if-none-match'),
  });
});

async function linkSecret(env: Env) {
  return (await jwtSecret(env)) + ':file';
}

/** Create a signed link for previews (<video src>, pdf.js, iframes). */
fsRoutes.post('/sign', async (c) => {
  const { path, expiresIn } = await c.req.json<{ path: string; expiresIn?: number }>();
  const p = normalizePath(path);
  assertRead(c.get('principal'), p);
  const ttl = Math.min(Math.max(Number(expiresIn) || 3600, 60), 7 * 86400);
  const token = await sign({ p, exp: Math.floor(Date.now() / 1000) + ttl }, await linkSecret(c.env), 'HS256');
  return c.json({ url: `/api/file/${token}/${encodeURIComponent(basename(p))}`, expiresIn: ttl });
});

fileLinkRoutes.on(['GET', 'HEAD'], '/:token/:name?', async (c) => {
  let payload: { p: string };
  try {
    payload = (await verify(c.req.param('token'), await linkSecret(c.env), 'HS256')) as { p: string };
  } catch {
    throw unauthorized('Link expired or invalid');
  }
  const vfs = await Vfs.create(c.env);
  const r = vfs.resolve(payload.p);
  const drv = r?.mount.driver as S3Driver | undefined;
  if (r && drv && 'directDownload' in drv && drv.directDownload && drv.presignGet && c.req.method === 'GET') {
    const signed = await drv.presignGet(r.rel, { expiresIn: 3600, filename: basename(payload.p) });
    return c.redirect(signed.url, 302);
  }
  return serveVfsFile(vfs, payload.p, {
    download: c.req.query('download') === '1',
    safeInline: true,
    method: c.req.method,
    rangeHeader: c.req.header('range'),
    ifNoneMatch: c.req.header('if-none-match'),
  });
});

fsRoutes.get('/search', async (c) => {
  const p = c.get('principal');
  if (p.kind === 'anonymous') throw unauthorized();
  const q = c.req.query('q') ?? '';
  let prefix = qpath(c.req.query('path'));
  if (p.permission !== 'admin' && !isWithin(prefix, p.pathPrefix)) prefix = p.pathPrefix;
  const hits = await searchIndex(c.env, q, { prefix, limit: Number(c.req.query('limit')) || 100 });
  return c.json(hits.map((h) => ({ name: h.name, path: h.path, isDir: !!h.is_dir, size: h.size, modified: h.modified, storageId: h.storage_id })));
});
