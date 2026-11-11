import { Hono } from 'hono';
import { assertAdmin } from '../lib/auth';
import { uuid } from '../lib/crypto';
import { badRequest, notFound } from '../lib/errors';
import { normalizePath } from '../lib/path';
import type { AppEnv } from '../lib/types';
import { buildDriver, invalidateMounts, splitConfig, type StorageRow } from '../storage/mounts';
import { getDriverDefinition, listDriverDefinitions } from '../storage/registry';
import { S3Driver } from '../storage/s3';
import { checkBucketCors } from '../lib/bucketcors';

export const storageRoutes = new Hono<AppEnv>();

storageRoutes.use('*', async (c, next) => {
  assertAdmin(c.get('principal'));
  await next();
});

function toPublic(row: StorageRow) {
  const def = getDriverDefinition(row.type);
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    mountPath: row.mount_path,
    config: JSON.parse(row.config || '{}'),
    secretFields: def?.fields.filter((f) => f.secret).map((f) => f.key) ?? [],
    hasSecret: !!row.secret,
    isDefault: !!row.is_default,
    enabled: !!row.enabled,
    sort: row.sort,
    available: !!def && def.runtimes.length > 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Driver types + their form fields, so the admin UI renders forms dynamically. */
storageRoutes.get('/types', (c) => {
  const rt = c.get('runtime').name;
  return c.json(
    listDriverDefinitions()
      .filter((d) => d.runtimes.includes(rt))
      .map((d) => ({ type: d.type, label: d.label, fields: d.fields, oauth: d.oauth ?? null, notes: d.notes, notesZh: d.notesZh })),
  );
});

storageRoutes.get('/', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM storages ORDER BY sort, mount_path').all<StorageRow>();
  return c.json(results.map(toPublic));
});

interface StorageBody {
  name: string;
  type: string;
  mountPath: string;
  config: Record<string, unknown>;
  isDefault?: boolean;
  enabled?: boolean;
  sort?: number;
}

function validateMount(p: string): string {
  return normalizePath(p);
}

storageRoutes.post('/', async (c) => {
  const b = await c.req.json<StorageBody>();
  if (!b.name || !b.type || !b.mountPath) throw badRequest('name, type and mountPath are required');
  const { config, secret } = await splitConfig(b.type, b.config ?? {}, c.env.ENCRYPTION_KEY);
  const now = Date.now();
  const id = uuid();
  const mount = validateMount(b.mountPath);
  const exists = await c.env.DB.prepare('SELECT 1 FROM storages WHERE mount_path = ?').bind(mount).first();
  if (exists) throw badRequest('Mount path already used');
  const count = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM storages').first<{ n: number }>();
  const isDefault = b.isDefault || Number(count?.n ?? 0) === 0;
  const stmts = [];
  if (isDefault) stmts.push(c.env.DB.prepare('UPDATE storages SET is_default = 0'));
  stmts.push(
    c.env.DB.prepare('INSERT INTO storages (id, name, type, mount_path, config, secret, is_default, enabled, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(
      id,
      b.name,
      b.type,
      mount,
      JSON.stringify(config),
      secret,
      isDefault ? 1 : 0,
      b.enabled === false ? 0 : 1,
      b.sort ?? 0,
      now,
      now,
    ),
  );
  await c.env.DB.batch(stmts);
  invalidateMounts();
  const row = await c.env.DB.prepare('SELECT * FROM storages WHERE id = ?').bind(id).first<StorageRow>();
  return c.json(toPublic(row!), 201);
});

storageRoutes.put('/:id', async (c) => {
  const id = c.req.param('id');
  const cur = await c.env.DB.prepare('SELECT * FROM storages WHERE id = ?').bind(id).first<StorageRow>();
  if (!cur) throw notFound();
  const b = await c.req.json<Partial<StorageBody>>();
  const type = b.type ?? cur.type;
  let config = cur.config;
  let secret = cur.secret;
  if (b.config) {
    const s = await splitConfig(type, b.config, c.env.ENCRYPTION_KEY, type === cur.type ? cur.secret : null);
    config = JSON.stringify(s.config);
    secret = s.secret;
  }
  const stmts = [];
  if (b.isDefault) stmts.push(c.env.DB.prepare('UPDATE storages SET is_default = 0'));
  stmts.push(
    c.env.DB.prepare('UPDATE storages SET name=?, type=?, mount_path=?, config=?, secret=?, is_default=?, enabled=?, sort=?, updated_at=? WHERE id=?').bind(
      b.name ?? cur.name,
      type,
      b.mountPath ? validateMount(b.mountPath) : cur.mount_path,
      config,
      secret,
      b.isDefault ? 1 : b.isDefault === false ? 0 : cur.is_default,
      b.enabled === undefined ? cur.enabled : b.enabled ? 1 : 0,
      b.sort ?? cur.sort,
      Date.now(),
      id,
    ),
  );
  await c.env.DB.batch(stmts);
  invalidateMounts();
  const row = await c.env.DB.prepare('SELECT * FROM storages WHERE id = ?').bind(id).first<StorageRow>();
  return c.json(toPublic(row!));
});

storageRoutes.post('/:id/default', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE storages SET is_default = 0'),
    c.env.DB.prepare('UPDATE storages SET is_default = 1, updated_at = ? WHERE id = ?').bind(Date.now(), id),
  ]);
  invalidateMounts();
  return c.json({ ok: true });
});

storageRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.batch([c.env.DB.prepare('DELETE FROM storages WHERE id = ?').bind(id), c.env.DB.prepare('DELETE FROM file_index WHERE storage_id = ?').bind(id)]);
  invalidateMounts();
  return c.json({ ok: true });
});

/** Test a saved storage, or an unsaved config (body.type + body.config). */
storageRoutes.post('/test', async (c) => {
  const b = await c.req.json<{ id?: string; type?: string; config?: Record<string, unknown> }>();
  let row: StorageRow | null = null;
  if (b.id) row = await c.env.DB.prepare('SELECT * FROM storages WHERE id = ?').bind(b.id).first<StorageRow>();
  if (b.type && b.config) {
    const s = await splitConfig(b.type, b.config, c.env.ENCRYPTION_KEY, row && row.type === b.type ? row.secret : null);
    row = { ...(row ?? ({} as StorageRow)), type: b.type, config: JSON.stringify(s.config), secret: s.secret };
  }
  if (!row) throw badRequest('Nothing to test');
  try {
    const d = await buildDriver(row, c.env);
    if (d.test) await d.test();
    else await d.list('/');
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message });
  }
});

// ------------------------------------------------------------ S3 bucket CORS
async function s3Of(c: { env: AppEnv['Bindings'] }, id: string): Promise<{ row: StorageRow; driver: S3Driver }> {
  const row = await c.env.DB.prepare('SELECT * FROM storages WHERE id = ?').bind(id).first<StorageRow>();
  if (!row) throw notFound();
  const driver = await buildDriver(row, c.env);
  if (!(driver instanceof S3Driver)) throw badRequest('Bucket CORS only applies to S3-compatible storages');
  return { row, driver };
}

/** The browser origin that will PUT to the bucket: explicit > PUBLIC_URL > caller's Origin > this request's origin. */
function siteOrigin(c: { env: AppEnv['Bindings']; req: { header(n: string): string | undefined; url: string } }, explicit?: string): string {
  const pick = explicit || c.env.PUBLIC_URL || c.req.header('origin') || new URL(c.req.url).origin;
  return new URL(pick).origin;
}

/** 一鍵設定 CORS: PutBucketCors with origin = site origin. */
storageRoutes.post('/:id/cors/apply', async (c) => {
  const b = await c.req.json<{ origin?: string }>().catch(() => ({}) as { origin?: string });
  const { row, driver } = await s3Of(c, c.req.param('id'));
  const origin = siteOrigin(c, b.origin);
  const cfg = JSON.parse(row.config || '{}');
  try {
    await driver.putBucketCors([origin]);
  } catch (e) {
    const r = await checkBucketCors(driver, origin, cfg.bucket, cfg.provider);
    return c.json({ ...r, applied: false, applyError: (e as Error).message });
  }
  const r = await checkBucketCors(driver, origin, cfg.bucket, cfg.provider);
  return c.json({ ...r, applied: true });
});

/** 檢測 CORS (server side): GetBucketCors + simulated browser preflight. */
storageRoutes.post('/:id/cors/check', async (c) => {
  const b = await c.req.json<{ origin?: string }>().catch(() => ({}) as { origin?: string });
  const { row, driver } = await s3Of(c, c.req.param('id'));
  const cfg = JSON.parse(row.config || '{}');
  return c.json(await checkBucketCors(driver, siteOrigin(c, b.origin), cfg.bucket, cfg.provider));
});

/** Presigned PUT for a tiny probe object: the browser tries it to prove CORS really works end to end. */
storageRoutes.post('/:id/cors/probe', async (c) => {
  const { driver } = await s3Of(c, c.req.param('id'));
  const key = `/.edgedock-uploads/cors-probe-${uuid()}.txt`;
  const signed = await driver.presignPut(key, { contentType: 'text/plain', expiresIn: 300 });
  return c.json({ key, ...signed });
});

storageRoutes.post('/:id/cors/probe/cleanup', async (c) => {
  const { key } = await c.req.json<{ key: string }>();
  if (!/^\/\.edgedock-uploads\/cors-probe-[0-9a-f-]+\.txt$/.test(key)) throw badRequest('Invalid probe key');
  const { driver } = await s3Of(c, c.req.param('id'));
  await driver.delete(key).catch(() => {});
  return c.json({ ok: true });
});
