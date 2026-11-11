import { Hono } from 'hono';
import { adminCount, assertAdmin, checkAdminCredentials, createAdmin, ensureBootstrapAdmin, issueToken } from '../lib/auth';
import { hashPassword, verifyPassword } from '../lib/crypto';
import { badRequest, forbidden, unauthorized } from '../lib/errors';
import { getSettings, PUBLIC_KEYS } from '../lib/settings';
import type { AppEnv } from '../lib/types';

export const authRoutes = new Hono<AppEnv>();

/** Public bootstrap info for the SPA. */
authRoutes.get('/status', async (c) => {
  await ensureBootstrapAdmin(c.env);
  const settings = await getSettings(c.env);
  const pub: Record<string, unknown> = {};
  for (const k of PUBLIC_KEYS) pub[k] = settings[k];
  const p = c.get('principal');
  return c.json({
    needsSetup: (await adminCount(c.env)) === 0,
    runtime: c.get('runtime').name,
    settings: pub,
    user: p.kind === 'anonymous' ? null : { kind: p.kind, name: p.name, permission: p.permission, pathPrefix: p.pathPrefix },
  });
});

/** First-run setup: create the admin account when none exists and no ADMIN_* secrets are configured. */
authRoutes.post('/setup', async (c) => {
  await ensureBootstrapAdmin(c.env);
  if ((await adminCount(c.env)) > 0) throw forbidden('Already initialized');
  const { username, password } = await c.req.json<{ username: string; password: string }>();
  if (!username || !password || password.length < 8) throw badRequest('Username required; password must be ≥ 8 characters');
  await createAdmin(c.env, username, password);
  const u = await checkAdminCredentials(c.env, username, password);
  return c.json(await issueToken(c.env, u!));
});

authRoutes.post('/login', async (c) => {
  const { username, password } = await c.req.json<{ username: string; password: string }>();
  if (!username || !password) throw badRequest('Username and password required');
  const u = await checkAdminCredentials(c.env, username, password);
  if (!u) throw unauthorized('Invalid username or password');
  return c.json({ ...(await issueToken(c.env, u)), user: { name: u.username } });
});

authRoutes.get('/me', (c) => {
  const p = c.get('principal');
  if (p.kind === 'anonymous') throw unauthorized();
  return c.json({ kind: p.kind, name: p.name, permission: p.permission, pathPrefix: p.pathPrefix });
});

authRoutes.post('/password', async (c) => {
  const p = c.get('principal');
  assertAdmin(p);
  if (p.kind !== 'admin') throw forbidden();
  const { oldPassword, newPassword } = await c.req.json<{ oldPassword: string; newPassword: string }>();
  if (!newPassword || newPassword.length < 8) throw badRequest('Password must be ≥ 8 characters');
  const row = await c.env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(Number(p.id)).first<{ password_hash: string }>();
  if (!row || !(await verifyPassword(oldPassword ?? '', row.password_hash))) throw unauthorized('Old password incorrect');
  await c.env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(await hashPassword(newPassword), Number(p.id)).run();
  return c.json({ ok: true });
});
