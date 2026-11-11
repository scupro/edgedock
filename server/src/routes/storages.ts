import { Hono } from 'hono';
import { assertAdmin } from '../lib/auth';
import { uuid } from '../lib/crypto';
import { badRequest, notFound } from '../lib/errors';
import { normalizePath } from '../lib/path';
import type { AppEnv } from '../lib/types';
import { buildDriver, invalidateMounts, splitConfig, type StorageRow } from '../storage/mounts';
import { getDriverDefinition, listDriverDefinitions } from '../storage/registry';

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
      .map((d) => ({ type: d.type, label: d.label, fields: d.fields })),
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
