import { sign, verify } from 'hono/jwt';
import type { Context, MiddlewareHandler } from 'hono';
import { hashPassword, jwtSecret, randomToken, sha256Hex, uuid, verifyPassword } from './crypto';
import { forbidden, unauthorized } from './errors';
import { isWithin, normalizePath } from './path';
import type { AppEnv, Env, Principal } from './types';

export const ANONYMOUS: Principal = { kind: 'anonymous', id: '', name: 'anonymous', permission: 'read', pathPrefix: '/' };

// ------------------------------------------------------------------ admin
export async function adminCount(env: Env): Promise<number> {
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
  return Number(r?.n ?? 0);
}

/** Seed the initial admin from ADMIN_USERNAME / ADMIN_PASSWORD if no user exists. */
export async function ensureBootstrapAdmin(env: Env): Promise<void> {
  if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD) return;
  if ((await adminCount(env)) > 0) return;
  await createAdmin(env, env.ADMIN_USERNAME, env.ADMIN_PASSWORD);
}

export async function createAdmin(env: Env, username: string, password: string): Promise<void> {
  if (!username || password.length < 8) throw new Error('Username required and password must be at least 8 characters');
  await env.DB.prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)')
    .bind(username, await hashPassword(password), 'admin', Date.now())
    .run();
}

export async function checkAdminCredentials(env: Env, username: string, password: string): Promise<{ id: number; username: string } | null> {
  await ensureBootstrapAdmin(env);
  const u = await env.DB.prepare('SELECT id, username, password_hash FROM users WHERE username = ?').bind(username).first<{ id: number; username: string; password_hash: string }>();
  if (!u) {
    // constant-ish time: still run a hash
    await verifyPassword(password, 'pbkdf2$sha256$1000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    return null;
  }
  return (await verifyPassword(password, u.password_hash)) ? { id: u.id, username: u.username } : null;
}

export async function issueToken(env: Env, user: { id: number; username: string }): Promise<{ token: string; expiresAt: number }> {
  const ttlH = Number(env.JWT_TTL_HOURS) || 24 * 7;
  const exp = Math.floor(Date.now() / 1000) + ttlH * 3600;
  const token = await sign({ sub: String(user.id), name: user.username, role: 'admin', exp }, await jwtSecret(env), 'HS256');
  return { token, expiresAt: exp * 1000 };
}

export async function verifyToken(env: Env, token: string): Promise<Principal | null> {
  try {
    const p = (await verify(token, await jwtSecret(env), 'HS256')) as { sub: string; name: string; role: string };
    if (p.role !== 'admin') return null;
    return { kind: 'admin', id: p.sub, name: p.name, permission: 'admin', pathPrefix: '/' };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ API keys
export interface ApiKeyRow {
  id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  permission: 'read' | 'readwrite';
  path_prefix: string;
  expires_at: number | null;
  revoked_at: number | null;
  last_used_at: number | null;
  created_at: number;
}

export const API_KEY_PREFIX = 'edk_';

export async function createApiKey(
  env: Env,
  input: { name: string; permission: 'read' | 'readwrite'; pathPrefix?: string; expiresAt?: number | null },
): Promise<{ key: string; row: ApiKeyRow }> {
  if (input.permission !== 'read' && input.permission !== 'readwrite') throw new Error('Invalid permission');
  const key = API_KEY_PREFIX + randomToken(24);
  const row: ApiKeyRow = {
    id: uuid(),
    name: input.name || 'API key',
    key_hash: await sha256Hex(key),
    key_prefix: key.slice(0, 10),
    permission: input.permission,
    path_prefix: normalizePath(input.pathPrefix || '/'),
    expires_at: input.expiresAt ?? null,
    revoked_at: null,
    last_used_at: null,
    created_at: Date.now(),
  };
  await env.DB.prepare(
    'INSERT INTO api_keys (id, name, key_hash, key_prefix, permission, path_prefix, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(row.id, row.name, row.key_hash, row.key_prefix, row.permission, row.path_prefix, row.expires_at, row.created_at)
    .run();
  return { key, row };
}

/** Validates a raw API key; updates last_used_at. Returns null when invalid/expired/revoked. */
export async function verifyApiKey(env: Env, raw: string, now = Date.now()): Promise<Principal | null> {
  if (!raw.startsWith(API_KEY_PREFIX)) return null;
  const row = await env.DB.prepare('SELECT * FROM api_keys WHERE key_hash = ?').bind(await sha256Hex(raw)).first<ApiKeyRow>();
  if (!row) return null;
  if (row.revoked_at) return null;
  if (row.expires_at && row.expires_at <= now) return null;
  // throttle writes: update at most once a minute
  if (!row.last_used_at || now - row.last_used_at > 60_000) {
    await env.DB.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').bind(now, row.id).run();
  }
  return { kind: 'apikey', id: row.id, name: row.name, permission: row.permission, pathPrefix: row.path_prefix };
}

// ------------------------------------------------------------------ scopes
export function canRead(p: Principal, vpath: string): boolean {
  if (p.kind === 'anonymous') return false;
  if (p.permission === 'admin') return true;
  return isWithin(vpath, p.pathPrefix);
}

export function canWrite(p: Principal, vpath: string): boolean {
  if (p.permission === 'admin') return true;
  if (p.kind !== 'apikey' || p.permission !== 'readwrite') return false;
  return isWithin(vpath, p.pathPrefix);
}

/**
 * Listing ancestors of the key's prefix is allowed so clients can navigate
 * down to it (the listing is filtered to the prefix branch).
 */
export function canTraverse(p: Principal, vpath: string): boolean {
  if (canRead(p, vpath)) return true;
  if (p.kind === 'apikey') return isWithin(p.pathPrefix, vpath);
  return false;
}

export function assertRead(p: Principal, vpath: string): void {
  if (p.kind === 'anonymous') throw unauthorized();
  if (!canRead(p, vpath)) throw forbidden('Path is outside of this key\'s scope');
}

export function assertWrite(p: Principal, vpath: string): void {
  if (p.kind === 'anonymous') throw unauthorized();
  if (!canWrite(p, vpath)) throw forbidden(p.permission === 'read' ? 'This key is read-only' : 'Path is outside of this key\'s scope');
}

export function assertAdmin(p: Principal): void {
  if (p.kind === 'anonymous') throw unauthorized();
  if (p.permission !== 'admin') throw forbidden('Admin only');
}

// ------------------------------------------------------------------ middleware
export function extractCredential(c: Context): { bearer?: string; basic?: { user: string; pass: string } } {
  const h = c.req.header('authorization') ?? '';
  if (/^bearer /i.test(h)) return { bearer: h.slice(7).trim() };
  if (/^basic /i.test(h)) {
    try {
      const bin = atob(h.slice(6).trim());
      const decoded = new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
      const i = decoded.indexOf(':');
      return { basic: { user: decoded.slice(0, i), pass: decoded.slice(i + 1) } };
    } catch {
      return {};
    }
  }
  const k = c.req.header('x-api-key');
  if (k) return { bearer: k };
  return {};
}

export async function resolvePrincipal(c: Context<AppEnv>): Promise<Principal> {
  const cred = extractCredential(c);
  const env = c.env;
  if (cred.bearer) {
    if (cred.bearer.startsWith(API_KEY_PREFIX)) return (await verifyApiKey(env, cred.bearer)) ?? ANONYMOUS;
    return (await verifyToken(env, cred.bearer)) ?? ANONYMOUS;
  }
  if (cred.basic) {
    // WebDAV clients: password = API key (username ignored), or admin username/password
    if (cred.basic.pass.startsWith(API_KEY_PREFIX)) return (await verifyApiKey(env, cred.basic.pass)) ?? ANONYMOUS;
    const u = await checkAdminCredentials(env, cred.basic.user, cred.basic.pass);
    if (u) return { kind: 'admin', id: String(u.id), name: u.username, permission: 'admin', pathPrefix: '/' };
  }
  return ANONYMOUS;
}

export const principalMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('principal', await resolvePrincipal(c));
  await next();
};
