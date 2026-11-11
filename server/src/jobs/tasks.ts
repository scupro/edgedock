/**
 * Long-running jobs, written as resumable "chunks" so they can run as
 * Cloudflare Workflow steps (each step = one chunk, state passed between
 * steps), or inline in a loop on Node / without Workflows.
 */
import { uuid } from '../lib/crypto';
import { joinPath } from '../lib/path';
import { consumeExpiredShares } from './cleanup';
import type { Env } from '../lib/types';
import { UploadService } from '../lib/uploads';
import { loadMounts, Vfs } from '../storage/mounts';

// ------------------------------------------------------------ job log
export async function startRun(env: Env, kind: string, ref?: string): Promise<string> {
  const id = uuid();
  await env.DB.prepare("INSERT INTO job_runs (id, kind, ref, status, started_at) VALUES (?, ?, ?, 'running', ?)").bind(id, kind, ref ?? null, Date.now()).run();
  return id;
}

export async function finishRun(env: Env, id: string, status: 'success' | 'failed', detail: unknown): Promise<void> {
  await env.DB.prepare('UPDATE job_runs SET status = ?, detail = ?, finished_at = ? WHERE id = ?')
    .bind(status, typeof detail === 'string' ? detail : JSON.stringify(detail), Date.now(), id)
    .run();
}

// ------------------------------------------------------------ search index
export interface IndexState {
  storageIds: string[];
  /** current storage being walked */
  current?: { storageId: string; queue: string[] };
  startedAt: number;
  indexed: number;
}

export async function indexInit(env: Env): Promise<IndexState> {
  const mounts = await loadMounts(env);
  return { storageIds: mounts.map((m) => m.row.id), startedAt: Date.now(), indexed: 0 };
}

/**
 * Process up to `maxDirs` directories. Returns the new state; `done` when finished.
 * Directory listings are written to file_index; stale rows of a storage are
 * removed once the storage walk finishes.
 */
export async function indexChunk(env: Env, state: IndexState, maxDirs = 25): Promise<{ state: IndexState; done: boolean }> {
  const vfs = await Vfs.create(env);
  const s: IndexState = JSON.parse(JSON.stringify(state));
  let dirs = 0;
  while (dirs < maxDirs) {
    if (!s.current) {
      const next = s.storageIds.shift();
      if (!next) return { state: s, done: true };
      s.current = { storageId: next, queue: ['/'] };
    }
    const mount = vfs.mounts.find((m) => m.row.id === s.current!.storageId);
    if (!mount || !s.current.queue.length) {
      if (mount) {
        await env.DB.prepare('DELETE FROM file_index WHERE storage_id = ? AND indexed_at < ?').bind(mount.row.id, s.startedAt).run();
      }
      s.current = undefined;
      continue;
    }
    const rel = s.current.queue.shift()!;
    dirs++;
    let entries;
    try {
      entries = await mount.driver.list(rel);
    } catch (e) {
      console.warn('[edgedock] index list failed', mount.row.name, rel, (e as Error).message);
      continue;
    }
    const now = Date.now();
    const stmts = entries.map((e) => {
      const vpath = joinPath(mount.mountPath, e.path);
      if (e.isDir) s.current!.queue.push(e.path);
      return env.DB.prepare(
        `INSERT INTO file_index (storage_id, path, name, is_dir, size, modified, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(storage_id, path) DO UPDATE SET name = excluded.name, is_dir = excluded.is_dir, size = excluded.size, modified = excluded.modified, indexed_at = excluded.indexed_at`,
      ).bind(mount.row.id, vpath, e.name, e.isDir ? 1 : 0, e.size ?? 0, e.modified ?? null, now);
    });
    for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
    s.indexed += entries.length;
  }
  return { state: s, done: false };
}

export async function runIndexInline(env: Env): Promise<number> {
  const run = await startRun(env, 'index');
  try {
    let state = await indexInit(env);
    for (;;) {
      const r = await indexChunk(env, state, 50);
      state = r.state;
      if (r.done) break;
    }
    // rows of storages that no longer exist
    await env.DB.prepare('DELETE FROM file_index WHERE storage_id NOT IN (SELECT id FROM storages)').run();
    await finishRun(env, run, 'success', { indexed: state.indexed });
    return state.indexed;
  } catch (e) {
    await finishRun(env, run, 'failed', (e as Error).message);
    throw e;
  }
}

// ------------------------------------------------------------ sync
export interface SyncJobRow {
  id: string;
  name: string;
  source_path: string;
  target_path: string;
  enabled: number;
  overwrite: number;
  last_run_at: number | null;
  last_status: string | null;
  created_at: number;
}

export interface SyncState {
  jobId: string;
  /** relative sub-paths still to process (relative to source/target roots) */
  queue: string[];
  copied: number;
  skipped: number;
  errors: string[];
}

export async function syncInit(env: Env, jobId: string): Promise<SyncState> {
  const job = await env.DB.prepare('SELECT * FROM sync_jobs WHERE id = ?').bind(jobId).first<SyncJobRow>();
  if (!job) throw new Error('Sync job not found');
  return { jobId, queue: ['/'], copied: 0, skipped: 0, errors: [] };
}

/** One-way sync: copies files missing (or different in size, or all when overwrite) from source to target. */
export async function syncChunk(env: Env, state: SyncState, maxDirs = 10): Promise<{ state: SyncState; done: boolean }> {
  const job = await env.DB.prepare('SELECT * FROM sync_jobs WHERE id = ?').bind(state.jobId).first<SyncJobRow>();
  if (!job) return { state, done: true };
  const vfs = await Vfs.create(env);
  const s: SyncState = JSON.parse(JSON.stringify(state));
  let n = 0;
  while (s.queue.length && n < maxDirs) {
    const rel = s.queue.shift()!;
    n++;
    const src = joinPath(job.source_path, rel);
    const dst = joinPath(job.target_path, rel);
    let entries;
    try {
      entries = await vfs.list(src);
    } catch (e) {
      s.errors.push(`${src}: ${(e as Error).message}`);
      continue;
    }
    try {
      await vfs.mkdir(dst);
    } catch {
      /* may exist */
    }
    for (const e of entries) {
      const childRel = joinPath(rel, e.name);
      if (e.isDir) {
        s.queue.push(childRel);
        continue;
      }
      const target = joinPath(job.target_path, childRel);
      try {
        const existing = await vfs.stat(target);
        if (existing && !job.overwrite && existing.size === e.size) {
          s.skipped++;
          continue;
        }
        await vfs.transfer(joinPath(job.source_path, childRel), target, 'copy');
        s.copied++;
      } catch (err) {
        if (s.errors.length < 50) s.errors.push(`${childRel}: ${(err as Error).message}`);
      }
    }
  }
  return { state: s, done: s.queue.length === 0 };
}

export async function finishSync(env: Env, state: SyncState): Promise<void> {
  const status = state.errors.length ? `partial: ${state.copied} copied, ${state.skipped} skipped, ${state.errors.length} errors` : `ok: ${state.copied} copied, ${state.skipped} skipped`;
  await env.DB.prepare('UPDATE sync_jobs SET last_run_at = ?, last_status = ? WHERE id = ?').bind(Date.now(), status, state.jobId).run();
}

export async function runSyncInline(env: Env, jobId: string): Promise<SyncState> {
  const run = await startRun(env, 'sync', jobId);
  try {
    let st = await syncInit(env, jobId);
    for (;;) {
      const r = await syncChunk(env, st, 20);
      st = r.state;
      if (r.done) break;
    }
    await finishSync(env, st);
    await finishRun(env, run, st.errors.length ? 'failed' : 'success', st);
    return st;
  } catch (e) {
    await finishRun(env, run, 'failed', (e as Error).message);
    throw e;
  }
}

// ------------------------------------------------------------ cleanup
export async function runCleanup(env: Env): Promise<{ uploadsAborted: number; sharesDeleted: number }> {
  const vfs = await Vfs.create(env);
  const uploadsAborted = await new UploadService(env, vfs).cleanupExpired();
  const sharesDeleted = await consumeExpiredShares(env);
  await env.DB.prepare('DELETE FROM job_runs WHERE started_at < ?').bind(Date.now() - 30 * 86400_000).run();
  return { uploadsAborted, sharesDeleted };
}

