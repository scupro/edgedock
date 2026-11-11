import { Hono } from 'hono';
import { assertWrite } from '../lib/auth';
import { badRequest, forbidden } from '../lib/errors';
import { indexUpsert } from '../lib/fileindex';
import { normalizePath } from '../lib/path';
import { getSettings } from '../lib/settings';
import type { AppEnv, Principal } from '../lib/types';
import { UploadService } from '../lib/uploads';
import { Vfs } from '../storage/mounts';

export const uploadRoutes = new Hono<AppEnv>();

const MiB = 1024 * 1024;

/**
 * Decide how the browser should upload a file:
 *  - "presigned": direct PUT to S3 (needs bucket CORS); falls back to "proxy" client-side on failure
 *  - "proxy": stream the body through the worker (PUT /api/upload/proxy)
 *  - "multipart": chunked, resumable (POST /api/upload/multipart/init)
 */
uploadRoutes.post('/plan', async (c) => {
  const { path, size, contentType } = await c.req.json<{ path: string; size: number; contentType?: string }>();
  const p = normalizePath(path);
  assertWrite(c.get('principal'), p);
  const settings = await getSettings(c.env);
  const vfs = await Vfs.create(c.env);
  const r = vfs.mustResolve(p);
  const driver = r.mount.driver;
  const caps = driver.capabilities;
  if (size >= settings.multipartThresholdMB * MiB) {
    return c.json({ strategy: 'multipart', direct: caps.presign && !!driver.multipart?.presignPart });
  }
  if (caps.presign && driver.presignPut) {
    const signed = await driver.presignPut(r.rel, { contentType });
    return c.json({ strategy: 'presigned', ...signed });
  }
  return c.json({ strategy: 'proxy' });
});

/** After a successful presigned PUT, let the server update the index. */
uploadRoutes.post('/finalize', async (c) => {
  const { path } = await c.req.json<{ path: string }>();
  const p = normalizePath(path);
  assertWrite(c.get('principal'), p);
  const vfs = await Vfs.create(c.env);
  const st = await vfs.stat(p);
  const r = vfs.resolve(p);
  if (st && r) await indexUpsert(c.env, r.mount.row.id, p, st);
  return c.json({ ok: !!st, size: st?.size ?? 0 });
});

/** Streaming upload through the worker (Workers request body limit applies: 100 MB on Free/Pro). */
uploadRoutes.put('/proxy', async (c) => {
  const p = normalizePath(c.req.query('path'));
  assertWrite(c.get('principal'), p);
  const len = c.req.header('content-length');
  const size = len ? Number(len) : undefined;
  const vfs = await Vfs.create(c.env);
  const body = c.req.raw.body ?? new Uint8Array(0);
  await vfs.write(p, body, { size, contentType: c.req.header('content-type') ?? undefined });
  const r = vfs.resolve(p);
  if (r) await indexUpsert(c.env, r.mount.row.id, p, { isDir: false, size: size ?? 0 });
  return c.json({ ok: true, path: p });
});

// ------------------------------------------------------------ multipart
async function svc(c: { env: AppEnv['Bindings'] }) {
  return new UploadService(c.env, await Vfs.create(c.env));
}

function sessionJson(s: { session: any; parts: any[]; resumed?: boolean }) {
  const { session, parts } = s;
  return {
    id: session.id,
    path: session.path,
    size: session.size,
    partSize: session.part_size,
    totalParts: session.total_parts,
    mode: session.mode,
    status: session.status,
    expiresAt: session.expires_at,
    uploadedParts: parts.map((p) => p.part_number),
    resumed: !!s.resumed,
  };
}

function checkOwner(p: Principal, session: { created_by: string | null; path: string }) {
  if (p.permission === 'admin') return;
  if (session.created_by !== `${p.kind}:${p.id}`) throw forbidden('Not your upload session');
  assertWrite(p, session.path);
}

uploadRoutes.post('/multipart/init', async (c) => {
  const b = await c.req.json<{ path: string; size: number; contentType?: string; fingerprint?: string }>();
  const p = normalizePath(b.path);
  const principal = c.get('principal');
  assertWrite(principal, p);
  if (typeof b.size !== 'number' || b.size < 0) throw badRequest('size required');
  const settings = await getSettings(c.env);
  const s = await (await svc(c)).init({
    path: p,
    size: b.size,
    contentType: b.contentType,
    fingerprint: b.fingerprint,
    partSize: settings.uploadPartSizeMB * MiB,
    createdBy: `${principal.kind}:${principal.id}`,
    ttlHours: settings.uploadSessionTtlHours,
  });
  return c.json(sessionJson(s));
});

uploadRoutes.get('/multipart/:id', async (c) => {
  const s = await (await svc(c)).get(c.req.param('id'));
  checkOwner(c.get('principal'), s.session);
  return c.json(sessionJson(s));
});

uploadRoutes.post('/multipart/:id/sign', async (c) => {
  const service = await svc(c);
  const s = await service.get(c.req.param('id'));
  checkOwner(c.get('principal'), s.session);
  const { partNumbers } = await c.req.json<{ partNumbers: number[] }>();
  return c.json({ urls: await service.signParts(s.session.id, partNumbers ?? []) });
});

uploadRoutes.put('/multipart/:id/parts/:n', async (c) => {
  const service = await svc(c);
  const s = await service.get(c.req.param('id'));
  checkOwner(c.get('principal'), s.session);
  const n = Number(c.req.param('n'));
  const len = Number(c.req.header('content-length') ?? NaN);
  let body: ReadableStream<Uint8Array> | Uint8Array;
  let size: number;
  if (Number.isFinite(len) && c.req.raw.body) {
    body = c.req.raw.body;
    size = len;
  } else {
    const buf = new Uint8Array(await c.req.arrayBuffer());
    body = buf;
    size = buf.byteLength;
  }
  const part = await service.uploadPart(s.session.id, n, body, size);
  return c.json({ partNumber: part.part_number, etag: part.etag });
});

uploadRoutes.post('/multipart/:id/parts/:n/ack', async (c) => {
  const service = await svc(c);
  const s = await service.get(c.req.param('id'));
  checkOwner(c.get('principal'), s.session);
  const { etag, size } = await c.req.json<{ etag?: string; size: number }>();
  const part = await service.ackPart(s.session.id, Number(c.req.param('n')), etag || null, Number(size));
  return c.json({ partNumber: part.part_number });
});

uploadRoutes.post('/multipart/:id/complete', async (c) => {
  const service = await svc(c);
  const s = await service.get(c.req.param('id'));
  checkOwner(c.get('principal'), s.session);
  const done = await service.complete(s.session.id);
  await indexUpsert(c.env, done.storage_id, done.path, { isDir: false, size: done.size });
  return c.json({ ok: true, path: done.path, size: done.size });
});

uploadRoutes.delete('/multipart/:id', async (c) => {
  const service = await svc(c);
  const s = await service.get(c.req.param('id'));
  checkOwner(c.get('principal'), s.session);
  await service.abort(s.session.id);
  return c.json({ ok: true });
});
