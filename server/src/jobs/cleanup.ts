import type { Env } from '../lib/types';

/** Delete expired shares, and view-exhausted shares untouched for a day. Returns rows deleted. */
export async function consumeExpiredShares(env: Env, now = Date.now()): Promise<number> {
  const a = await env.DB.prepare('DELETE FROM shares WHERE expires_at IS NOT NULL AND expires_at <= ?').bind(now).run();
  const b = await env.DB.prepare('DELETE FROM shares WHERE max_views IS NOT NULL AND views >= max_views AND updated_at < ?').bind(now - 86400_000).run();
  return Number(a.meta?.changes ?? 0) + Number(b.meta?.changes ?? 0);
}
