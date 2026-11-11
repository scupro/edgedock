import { Hono } from 'hono';
import { assertWrite } from '../lib/auth';
import { badRequest, forbidden, HttpError } from '../lib/errors';
import { indexUpsert } from '../lib/fileindex';
import { normalizePath } from '../lib/path';
import { getSettings, proxyLimitBytes, type Settings } from '../lib/settings';
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
function clientLimits(settings: Settings) {
  return {
    proxyMaxBytes: proxyLimitBytes(settings),
    concurrency: Math.max(1, Math.min(8, settings.uploadConcurrency || 3)),
    retries: Math.max(1, Math.min(10, settings.uploadRetries || 5)),
    chunkTimeoutMs: Math.max(10, settings.uploadChunkTimeoutSec || 120) * 1000,
  };
}

uploadRoutes.post('/plan', async (c) => {
  const { path, size, contentType, noDirect } = await c.req.json<{ path: string; size: number; contentType?: string; noDirect?: boolean }>();
  const p = normalizePath(path);
  assertWrite(c.get('principal'), p);
  const settings = await getSettings(c.env);
  const vfs = await Vfs.create(c.env);
  const r = vfs.mustResolve(p);
  const driver = r.mount.driver;
  const caps = driver.capabilities;
  if (caps.readOnly) throw new HttpError(405, 'Storage is read-only', 'readonly');
  const limits = clientLimits(settings);
  if (caps.maxUploadSize !== undefined && size > caps.maxUploadSize) throw new HttpError(413, `This storage accepts files up to ${Math.floor(caps.maxUploadSize / MiB)} MiB through EdgeDock`, 'too_large');
  const base = { storageId: r.mount.row.id, limits };
  // Anything that might have to go through the Worker in one request must fit its body limit,
  // so files above min(threshold, proxy limit) are always chunked.
  const chunkAbove = Math.min(settings.multipartThresholdMB * MiB, limits.proxyMaxBytes);
  const mp = driver.multipart;
  // direct browser → provider parts: S3 presigned parts, HuggingFace LFS part URLs, OneDrive / Google Drive session URLs
  const directParts = !noDirect && !!(mp?.presignPart || mp?.presignParts) && (caps.presign || !!caps.directParts);
  const canDirect = !noDirect && caps.presign;
  // single-request writes are buffered by some drivers (HuggingFace): above that, always multipart
  const mustChunk = caps.maxWriteSize !== undefined && size > Math.min(caps.maxWriteSize, chunkAbove);
  if (size > chunkAbove || mustChunk) {
    return c.json({ ...base, strategy: 'multipart', direct: directParts, sha256: !!caps.needsSha256 });
  }
  if (canDirect && driver.presignPut) {
    const signed = await driver.presignPut(r.rel, { contentType });
    return c.json({ ...base, strategy: 'presigned', ...signed });
  }
  return c.json({ ...base, strategy: 'proxy' });
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
  const settings = await getSettings(c.env);
  if (size !== undefined && size > proxyLimitBytes(settings)) {
    throw new HttpError(413, `Body exceeds the Worker proxy limit (${settings.proxyMaxChunkMB} MiB); use multipart upload`, 'use_multipart');
  }
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

function sessionJson(s: { session: any; parts: any[]; resumed?: boolean }, sequential = false, signBatch = 1) {
  const { session, parts } = s;
  return {
    sequential,
    signBatch,
    id: session.id,
    path: session.path,
    size: session.size,
    partSize: session.part_size,
    totalParts: session.total_parts,
    mode: session.mode,
    status: session.status,
    expiresAt: session.expires_at,
    uploadedParts: parts.map((p) => p.part_number),
    partChecksums: Object.fromEntries(parts.filter((p) => p.checksum).map((p) => [p.part_number, p.checksum])),
    resumed: !!s.resumed,
  };
}

/** Origin the browser uploads from (Google Drive binds resumable sessions to it for CORS). */
function browserOrigin(c: { req: { header(n: string): string | undefined; url: string }; env: AppEnv['Bindings'] }): string {
  const o = c.req.header('origin');
  if (o && /^https?:\/\/[^/]+$/.test(o)) return o;
  if (c.env.PUBLIC_URL) {
    try {
      return new URL(c.env.PUBLIC_URL).origin;
    } catch {
      /* fallthrough */
    }
  }
  return new URL(c.req.url).origin;
}

function checkOwner(p: Principal, session: { created_by: string | null; path: string }) {
  if (p.permission === 'admin') return;
  if (session.created_by !== `${p.kind}:${p.id}`) throw forbidden('Not your upload session');
  assertWrite(p, session.path);
}

uploadRoutes.post('/multipart/init', async (c) => {
  const b = await c.req.json<{ path: string; size: number; contentType?: string; fingerprint?: string; sha256?: string; sample?: string }>();
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
    sha256: typeof b.sha256 === 'string' ? b.sha256 : undefined,
    sample: typeof b.sample === 'string' ? b.sample.slice(0, 1024) : undefined,
    origin: browserOrigin(c),
    partSize: settings.uploadPartSizeMB * MiB,
    maxPartSize: proxyLimitBytes(settings),
    createdBy: `${principal.kind}:${principal.id}`,
    ttlHours: settings.uploadSessionTtlHours,
  });
  const drv = (await Vfs.create(c.env)).mounts.find((m) => m.row.id === s.session.storage_id)?.driver;
  return c.json({ ...sessionJson(s, !!drv?.capabilities.sequentialParts && s.session.mode === 'native', drv?.multipart?.presignParts ? 10_000 : 1), limits: clientLimits(settings) });
});

/** Session state; `?verify=1` reconciles recorded parts against the provider (ListParts / temp parts). */
uploadRoutes.get('/multipart/:id', async (c) => {
  const service = await svc(c);
  const s = await service.get(c.req.param('id'));
  checkOwner(c.get('principal'), s.session);
  if (c.req.query('verify')) s.parts = await service.reconcile(s.session, s.parts);
  return c.json(sessionJson(s));
});

uploadRoutes.post('/multipart/:id/sign', async (c) => {
  const service = await svc(c);
  const s = await service.get(c.req.param('id'));
  checkOwner(c.get('principal'), s.session);
  const { partNumbers } = await c.req.json<{ partNumbers: number[] }>();
  return c.json(await service.signParts(s.session.id, partNumbers ?? []));
});

uploadRoutes.put('/multipart/:id/parts/:n', async (c) => {
  const service = await svc(c);
  const s = await service.get(c.req.param('id'));
  checkOwner(c.get('principal'), s.session);
  const n = Number(c.req.param('n'));
  const len = Number(c.req.header('content-length') ?? NaN);
  const settings = await getSettings(c.env);
  if (Number.isFinite(len) && len > proxyLimitBytes(settings)) throw new HttpError(413, 'Part exceeds the Worker proxy limit', 'part_too_large');
  const md5 = c.req.header('content-md5') ?? c.req.header('x-part-md5') ?? null;
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
  const part = await service.uploadPart(s.session.id, n, body, size, md5);
  c.header('X-EdgeDock-Part-MD5', part.checksum ?? '');
  return c.json({ partNumber: part.part_number, etag: part.etag, md5: part.checksum });
});

uploadRoutes.post('/multipart/:id/parts/:n/ack', async (c) => {
  const service = await svc(c);
  const s = await service.get(c.req.param('id'));
  checkOwner(c.get('principal'), s.session);
  const { etag, size, md5 } = await c.req.json<{ etag?: string; size: number; md5?: string }>();
  const part = await service.ackPart(s.session.id, Number(c.req.param('n')), etag || null, Number(size), md5 || null);
  return c.json({ partNumber: part.part_number });
});

uploadRoutes.post('/multipart/:id/complete', async (c) => {
  const service = await svc(c);
  const s = await service.get(c.req.param('id'));
  checkOwner(c.get('principal'), s.session);
  const done = await service.complete(s.session.id);
  await indexUpsert(c.env, done.storage_id, done.path, { isDir: false, size: done.size });
  return c.json({ ok: true, path: done.path, size: done.size, checksum: done.checksum ?? null });
});

uploadRoutes.delete('/multipart/:id', async (c) => {
  const service = await svc(c);
  const s = await service.get(c.req.param('id'));
  checkOwner(c.get('principal'), s.session);
  await service.abort(s.session.id);
  return c.json({ ok: true });
});
