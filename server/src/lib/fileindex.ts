import { basename, normalizePath } from './path';
import type { Env } from './types';

export interface IndexHit {
  storage_id: string;
  path: string;
  name: string;
  is_dir: number;
  size: number;
  modified: number | null;
}

export async function indexUpsert(
  env: Env,
  storageId: string,
  vpath: string,
  entry: { isDir: boolean; size?: number; modified?: number },
): Promise<void> {
  const p = normalizePath(vpath);
  await env.DB.prepare(
    `INSERT INTO file_index (storage_id, path, name, is_dir, size, modified, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(storage_id, path) DO UPDATE SET name = excluded.name, is_dir = excluded.is_dir, size = excluded.size, modified = excluded.modified, indexed_at = excluded.indexed_at`,
  )
    .bind(storageId, p, basename(p), entry.isDir ? 1 : 0, entry.size ?? 0, entry.modified ?? Date.now(), Date.now())
    .run();
}

export async function indexRemove(env: Env, vpath: string): Promise<void> {
  const p = normalizePath(vpath);
  await env.DB.prepare("DELETE FROM file_index WHERE path = ? OR path LIKE ? ESCAPE '\\'").bind(p, escapeLike(p) + '/%').run();
}

export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

export async function searchIndex(env: Env, q: string, opts: { prefix?: string; limit?: number } = {}): Promise<IndexHit[]> {
  const terms = q.trim().split(/\s+/).filter(Boolean).slice(0, 5);
  if (!terms.length) return [];
  const where: string[] = [];
  const binds: unknown[] = [];
  for (const t of terms) {
    where.push("name LIKE ? ESCAPE '\\'");
    binds.push('%' + escapeLike(t) + '%');
  }
  const prefix = normalizePath(opts.prefix || '/');
  if (prefix !== '/') {
    where.push("(path = ? OR path LIKE ? ESCAPE '\\')");
    binds.push(prefix, escapeLike(prefix) + '/%');
  }
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const { results } = await env.DB.prepare(
    `SELECT storage_id, path, name, is_dir, size, modified FROM file_index WHERE ${where.join(' AND ')} ORDER BY is_dir DESC, length(name), name LIMIT ${limit}`,
  )
    .bind(...binds)
    .all<IndexHit>();
  return results;
}
