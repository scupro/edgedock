import { Hono } from 'hono';
import { assertAdmin, createApiKey, type ApiKeyRow } from '../lib/auth';
import { uuid } from '../lib/crypto';
import { badRequest, notFound } from '../lib/errors';
import { normalizePath } from '../lib/path';
import { getSettings, saveSettings, type Settings } from '../lib/settings';
import type { AppEnv } from '../lib/types';
import type { SyncJobRow } from '../jobs/tasks';

/** Admin-only: API keys, settings, jobs. */
export const adminRoutes = new Hono<AppEnv>();

adminRoutes.use('*', async (c, next) => {
  assertAdmin(c.get('principal'));
  await next();
});

// ------------------------------------------------------------ API keys
const keyJson = (k: ApiKeyRow) => ({
  id: k.id,
  name: k.name,
  prefix: k.key_prefix,
  permission: k.permission,
  pathPrefix: k.path_prefix,
  expiresAt: k.expires_at,
  revokedAt: k.revoked_at,
  lastUsedAt: k.last_used_at,
  createdAt: k.created_at,
  active: !k.revoked_at && (!k.expires_at || k.expires_at > Date.now()),
});

adminRoutes.get('/keys', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM api_keys ORDER BY created_at DESC').all<ApiKeyRow>();
  return c.json(results.map(keyJson));
});

adminRoutes.post('/keys', async (c) => {
  const b = await c.req.json<{ name: string; permission: 'read' | 'readwrite'; pathPrefix?: string; expiresAt?: number | null; expiresInDays?: number }>();
  if (b.permission !== 'read' && b.permission !== 'readwrite') throw badRequest('permission must be read or readwrite');
  const expiresAt = b.expiresAt ?? (b.expiresInDays ? Date.now() + b.expiresInDays * 86400_000 : null);
  const { key, row } = await createApiKey(c.env, { name: b.name, permission: b.permission, pathPrefix: b.pathPrefix, expiresAt });
  // the plaintext key is only returned once
  return c.json({ ...keyJson(row), key }, 201);
});

adminRoutes.patch('/keys/:id', async (c) => {
  const b = await c.req.json<{ name?: string; expiresAt?: number | null; pathPrefix?: string; permission?: 'read' | 'readwrite' }>();
  const cur = await c.env.DB.prepare('SELECT * FROM api_keys WHERE id = ?').bind(c.req.param('id')).first<ApiKeyRow>();
  if (!cur) throw notFound();
  await c.env.DB.prepare('UPDATE api_keys SET name = ?, expires_at = ?, path_prefix = ?, permission = ? WHERE id = ?')
    .bind(
      b.name ?? cur.name,
      b.expiresAt === undefined ? cur.expires_at : b.expiresAt,
      b.pathPrefix ? normalizePath(b.pathPrefix) : cur.path_prefix,
      b.permission === 'read' || b.permission === 'readwrite' ? b.permission : cur.permission,
      cur.id,
    )
    .run();
  return c.json({ ok: true });
});

adminRoutes.post('/keys/:id/revoke', async (c) => {
  await c.env.DB.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').bind(Date.now(), c.req.param('id')).run();
  return c.json({ ok: true });
});

adminRoutes.delete('/keys/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM api_keys WHERE id = ?').bind(c.req.param('id')).run();
  return c.json({ ok: true });
});

// ------------------------------------------------------------ settings
adminRoutes.get('/settings', async (c) => c.json(await getSettings(c.env)));
adminRoutes.put('/settings', async (c) => c.json(await saveSettings(c.env, await c.req.json<Partial<Settings>>())));

// ------------------------------------------------------------ jobs
adminRoutes.post('/jobs/index', async (c) => {
  const id = await c.get('runtime').triggerIndex(c.env);
  return c.json({ ok: true, id });
});

adminRoutes.get('/jobs/runs', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM job_runs ORDER BY started_at DESC LIMIT 50').all();
  return c.json(results);
});

adminRoutes.get('/sync', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM sync_jobs ORDER BY created_at DESC').all<SyncJobRow>();
  return c.json(results);
});

adminRoutes.post('/sync', async (c) => {
  const b = await c.req.json<{ name: string; sourcePath: string; targetPath: string; overwrite?: boolean; enabled?: boolean }>();
  if (!b.sourcePath || !b.targetPath) throw badRequest('sourcePath and targetPath required');
  const id = uuid();
  await c.env.DB.prepare('INSERT INTO sync_jobs (id, name, source_path, target_path, enabled, overwrite, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, b.name || 'sync', normalizePath(b.sourcePath), normalizePath(b.targetPath), b.enabled === false ? 0 : 1, b.overwrite ? 1 : 0, Date.now())
    .run();
  return c.json({ id }, 201);
});

adminRoutes.delete('/sync/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM sync_jobs WHERE id = ?').bind(c.req.param('id')).run();
  return c.json({ ok: true });
});

adminRoutes.post('/sync/:id/run', async (c) => {
  const id = await c.get('runtime').triggerSync(c.env, c.req.param('id'));
  return c.json({ ok: true, id });
});
