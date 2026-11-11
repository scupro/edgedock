import { sign, verify } from 'hono/jwt';
import { hashPassword, jwtSecret, randomSlug, uuid, verifyPassword } from './crypto';
import { badRequest, conflict } from './errors';
import { normalizePath } from './path';
import type { Env } from './types';

export type ShareType = 'markdown' | 'text' | 'file';

export interface ShareRow {
  id: string;
  slug: string;
  type: ShareType;
  title: string | null;
  content: string | null;
  content_type: string | null;
  storage_path: string | null;
  password_hash: string | null;
  expires_at: number | null;
  max_views: number | null;
  views: number;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export type ShareState = 'ok' | 'expired' | 'exhausted';

/** Pure rule check: expiry and view limit. */
export function shareState(s: Pick<ShareRow, 'expires_at' | 'max_views' | 'views'>, now = Date.now()): ShareState {
  if (s.expires_at && s.expires_at <= now) return 'expired';
  if (s.max_views !== null && s.max_views !== undefined && s.max_views > 0 && s.views >= s.max_views) return 'exhausted';
  return 'ok';
}

export const SLUG_RE = /^[A-Za-z0-9_-]{3,64}$/;

export interface ShareInput {
  type: ShareType;
  title?: string;
  content?: string;
  contentType?: string;
  storagePath?: string;
  slug?: string;
  password?: string | null;
  expiresAt?: number | null;
  /** seconds from now; alternative to expiresAt */
  expiresIn?: number | null;
  maxViews?: number | null;
}

export async function createShare(env: Env, input: ShareInput, createdBy: string, maxContentKB = 900): Promise<ShareRow> {
  if (!['markdown', 'text', 'file'].includes(input.type)) throw badRequest('Invalid share type');
  if (input.type === 'file') {
    if (!input.storagePath) throw badRequest('storagePath is required for file shares');
  } else {
    if (typeof input.content !== 'string') throw badRequest('content is required');
    if (new TextEncoder().encode(input.content).byteLength > maxContentKB * 1024) throw badRequest(`Content exceeds ${maxContentKB} KiB`);
  }
  let slug = input.slug?.trim();
  if (slug) {
    if (!SLUG_RE.test(slug)) throw badRequest('Slug must be 3-64 chars: letters, digits, - or _');
    const exists = await env.DB.prepare('SELECT 1 FROM shares WHERE slug = ?').bind(slug).first();
    if (exists) throw conflict('Slug already in use');
  } else {
    slug = randomSlug(8);
  }
  const now = Date.now();
  const row: ShareRow = {
    id: uuid(),
    slug,
    type: input.type,
    title: input.title ?? null,
    content: input.type === 'file' ? null : input.content!,
    content_type: input.contentType ?? (input.type === 'markdown' ? 'text/markdown; charset=utf-8' : input.type === 'text' ? 'text/plain; charset=utf-8' : null),
    storage_path: input.type === 'file' ? normalizePath(input.storagePath) : null,
    password_hash: input.password ? await hashPassword(input.password) : null,
    expires_at: input.expiresAt ?? (input.expiresIn ? now + input.expiresIn * 1000 : null),
    max_views: input.maxViews && input.maxViews > 0 ? Math.floor(input.maxViews) : null,
    views: 0,
    created_by: createdBy,
    created_at: now,
    updated_at: now,
  };
  await env.DB.prepare(
    `INSERT INTO shares (id, slug, type, title, content, content_type, storage_path, password_hash, expires_at, max_views, views, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
  )
    .bind(row.id, row.slug, row.type, row.title, row.content, row.content_type, row.storage_path, row.password_hash, row.expires_at, row.max_views, row.created_by, now, now)
    .run();
  return row;
}

export async function updateShare(env: Env, id: string, patch: Partial<ShareInput>, maxContentKB = 900): Promise<ShareRow | null> {
  const cur = await env.DB.prepare('SELECT * FROM shares WHERE id = ?').bind(id).first<ShareRow>();
  if (!cur) return null;
  const next = { ...cur };
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.content !== undefined && cur.type !== 'file') {
    if (new TextEncoder().encode(patch.content).byteLength > maxContentKB * 1024) throw badRequest(`Content exceeds ${maxContentKB} KiB`);
    next.content = patch.content;
  }
  if (patch.contentType !== undefined) next.content_type = patch.contentType;
  if (patch.password !== undefined) next.password_hash = patch.password ? await hashPassword(patch.password) : null;
  if (patch.expiresAt !== undefined) next.expires_at = patch.expiresAt;
  if (patch.expiresIn !== undefined) next.expires_at = patch.expiresIn ? Date.now() + patch.expiresIn * 1000 : null;
  if (patch.maxViews !== undefined) next.max_views = patch.maxViews && patch.maxViews > 0 ? Math.floor(patch.maxViews) : null;
  next.updated_at = Date.now();
  await env.DB.prepare('UPDATE shares SET title=?, content=?, content_type=?, password_hash=?, expires_at=?, max_views=?, updated_at=? WHERE id=?')
    .bind(next.title, next.content, next.content_type, next.password_hash, next.expires_at, next.max_views, next.updated_at, id)
    .run();
  return next;
}

export async function getShareBySlug(env: Env, slug: string): Promise<ShareRow | null> {
  return env.DB.prepare('SELECT * FROM shares WHERE slug = ?').bind(slug).first<ShareRow>();
}

/** Atomically count a view. Returns false if the limit was already reached. */
export async function consumeView(env: Env, share: ShareRow): Promise<boolean> {
  const r = await env.DB.prepare('UPDATE shares SET views = views + 1 WHERE id = ? AND (max_views IS NULL OR views < max_views)').bind(share.id).run();
  return Number(r.meta?.changes ?? 0) > 0;
}

export async function checkSharePassword(share: ShareRow, password: string | null | undefined): Promise<boolean> {
  if (!share.password_hash) return true;
  if (!password) return false;
  return verifyPassword(password, share.password_hash);
}

/** Short-lived token proving the password was entered (so the password isn't re-sent / re-hashed per request). */
export async function issueShareToken(env: Env, share: ShareRow, ttlSec = 3600): Promise<string> {
  return sign({ sh: share.id, exp: Math.floor(Date.now() / 1000) + ttlSec }, (await jwtSecret(env)) + ':share', 'HS256');
}

export async function verifyShareToken(env: Env, share: ShareRow, token: string | null | undefined): Promise<boolean> {
  if (!token) return false;
  try {
    const p = (await verify(token, (await jwtSecret(env)) + ':share', 'HS256')) as { sh: string };
    return p.sh === share.id;
  } catch {
    return false;
  }
}

export function publicShare(s: ShareRow) {
  return {
    id: s.id,
    slug: s.slug,
    type: s.type,
    title: s.title,
    contentType: s.content_type,
    storagePath: s.storage_path,
    hasPassword: !!s.password_hash,
    expiresAt: s.expires_at,
    maxViews: s.max_views,
    views: s.views,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
  };
}
