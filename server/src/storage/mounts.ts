import { decryptString, encryptString } from '../lib/crypto';
import { badRequest, notFound } from '../lib/errors';
import { mimeFromPath } from '../lib/mime';
import { basename, dirname, isWithin, joinPath, normalizePath } from '../lib/path';
import type { Env } from '../lib/types';
import { getDriverDefinition } from './registry';
import type { ByteRange, FileEntry, ReadResult, StorageDriver, WriteBody, WriteOptions } from './types';

export interface StorageRow {
  id: string;
  name: string;
  type: string;
  mount_path: string;
  config: string;
  secret: string | null;
  is_default: number;
  enabled: number;
  sort: number;
  created_at: number;
  updated_at: number;
}

export interface MountedStorage {
  row: StorageRow;
  mountPath: string;
  driver: StorageDriver;
}

export interface Resolved {
  mount: MountedStorage;
  /** storage-relative path */
  rel: string;
  /** virtual path */
  vpath: string;
}

let cache: { at: number; key: string; mounts: MountedStorage[] } | null = null;
const CACHE_MS = 30_000;

export function invalidateMounts(): void {
  cache = null;
}

/** Split a config object into public config and secret part according to the driver definition. */
export async function splitConfig(type: string, input: Record<string, unknown>, encryptionKey: string, prevSecret?: string | null) {
  const def = getDriverDefinition(type);
  if (!def) throw badRequest(`Unknown storage type: ${type}`);
  const pub: Record<string, unknown> = {};
  let secret: Record<string, unknown> = {};
  if (prevSecret) secret = JSON.parse(await decryptString(prevSecret, encryptionKey));
  for (const f of def.fields) {
    const v = input[f.key];
    if (f.secret) {
      // empty/undefined secret on update = keep previous value
      if (v !== undefined && v !== '' && v !== null) secret[f.key] = v;
    } else if (v !== undefined) {
      pub[f.key] = f.type === 'boolean' ? v === true || v === 'true' || v === 1 : f.type === 'number' ? Number(v) : v;
    } else if (f.default !== undefined) {
      pub[f.key] = f.default;
    }
  }
  for (const f of def.fields) {
    if (f.required && pub[f.key] === undefined && secret[f.key] === undefined) throw badRequest(`Missing field: ${f.key}`);
  }
  const enc = Object.keys(secret).length ? await encryptString(JSON.stringify(secret), encryptionKey) : null;
  return { config: pub, secret: enc };
}

export async function buildDriver(row: StorageRow, env: Env, fetchFn: typeof fetch = (...a) => fetch(...a)): Promise<StorageDriver> {
  const def = getDriverDefinition(row.type);
  if (!def) throw new Error(`Storage driver "${row.type}" is not available in this runtime`);
  const cfg = JSON.parse(row.config || '{}');
  const secret = row.secret ? JSON.parse(await decryptString(row.secret, env.ENCRYPTION_KEY)) : {};
  return def.create({ ...cfg, ...secret }, { fetch: fetchFn });
}

export async function loadMounts(env: Env): Promise<MountedStorage[]> {
  const ver = await env.DB.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(updated_at),0) AS u FROM storages').first<{ n: number; u: number }>();
  const key = `${ver?.n}:${ver?.u}`;
  if (cache && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.mounts;
  const { results } = await env.DB.prepare('SELECT * FROM storages WHERE enabled = 1 ORDER BY sort, mount_path').all<StorageRow>();
  const mounts: MountedStorage[] = [];
  for (const row of results) {
    try {
      mounts.push({ row, mountPath: normalizePath(row.mount_path), driver: await buildDriver(row, env) });
    } catch (e) {
      console.warn(`[edgedock] storage ${row.name} unavailable: ${(e as Error).message}`);
    }
  }
  cache = { at: Date.now(), key, mounts };
  return mounts;
}

/** Virtual file system over all mounted storages. */
export class Vfs {
  constructor(public mounts: MountedStorage[]) {}

  static async create(env: Env): Promise<Vfs> {
    return new Vfs(await loadMounts(env));
  }

  get defaultMount(): MountedStorage | undefined {
    return this.mounts.find((m) => m.row.is_default) ?? this.mounts[0];
  }

  resolve(vpath: string): Resolved | null {
    const p = normalizePath(vpath);
    let best: MountedStorage | null = null;
    for (const m of this.mounts) {
      if (isWithin(p, m.mountPath) && (!best || m.mountPath.length > best.mountPath.length)) best = m;
    }
    if (!best) return null;
    const rel = best.mountPath === '/' ? p : normalizePath(p.slice(best.mountPath.length));
    return { mount: best, rel, vpath: p };
  }

  mustResolve(vpath: string): Resolved {
    const r = this.resolve(vpath);
    if (!r) throw notFound(`No storage mounted at ${normalizePath(vpath)}`);
    return r;
  }

  /** Mount points that appear as virtual directories directly below `vpath`. */
  private childMounts(vpath: string): FileEntry[] {
    const p = normalizePath(vpath);
    const names = new Map<string, FileEntry>();
    for (const m of this.mounts) {
      if (m.mountPath === p || !isWithin(m.mountPath, p)) continue;
      const rest = m.mountPath.slice(p === '/' ? 1 : p.length + 1);
      const name = rest.split('/')[0];
      if (name && !names.has(name)) names.set(name, { name, path: joinPath(p, name), isDir: true, size: 0 });
    }
    return [...names.values()];
  }

  async list(vpath: string): Promise<FileEntry[]> {
    const p = normalizePath(vpath);
    const virtual = this.childMounts(p);
    const r = this.resolve(p);
    if (!r) {
      if (!virtual.length && p !== '/') throw notFound();
      return virtual;
    }
    const items = (await r.mount.driver.list(r.rel)).map((e) => ({ ...e, path: joinPath(r.mount.mountPath, e.path) }));
    const seen = new Set(items.map((i) => i.name));
    for (const v of virtual) if (!seen.has(v.name)) items.push(v);
    return items;
  }

  async stat(vpath: string): Promise<FileEntry | null> {
    const p = normalizePath(vpath);
    if (p === '/' || this.childMounts(p).length || this.mounts.some((m) => m.mountPath === p)) {
      return { name: basename(p), path: p, isDir: true, size: 0 };
    }
    const r = this.resolve(p);
    if (!r) return null;
    const st = await r.mount.driver.stat(r.rel);
    return st ? { ...st, path: p, name: basename(p) } : null;
  }

  read(vpath: string, range?: ByteRange): Promise<ReadResult> {
    const r = this.mustResolve(vpath);
    return r.mount.driver.read(r.rel, { range });
  }

  write(vpath: string, body: WriteBody, opts: WriteOptions = {}): Promise<void> {
    const r = this.mustResolve(vpath);
    if (r.mount.driver.capabilities.readOnly) throw badRequest('Storage is read-only');
    // HTTP clients (curl, some WebDAV clients) send form/octet defaults: store a real type instead
    const ct = opts.contentType;
    const contentType = !ct || /x-www-form-urlencoded|multipart\/form-data|^application\/octet-stream/i.test(ct) ? mimeFromPath(vpath) : ct;
    return r.mount.driver.write(r.rel, body, { ...opts, contentType });
  }

  async mkdir(vpath: string): Promise<void> {
    const r = this.mustResolve(vpath);
    await r.mount.driver.mkdir(r.rel);
  }

  async delete(vpath: string): Promise<void> {
    const r = this.mustResolve(vpath);
    if (r.rel === '/') throw badRequest('Cannot delete a mount root');
    await r.mount.driver.delete(r.rel);
  }

  /** Move/rename/copy within or across storages. */
  async transfer(from: string, to: string, op: 'move' | 'copy'): Promise<void> {
    const a = this.mustResolve(from);
    const b = this.mustResolve(to);
    if (a.rel === '/') throw badRequest('Cannot move a mount root');
    if (isWithin(b.vpath, a.vpath)) throw badRequest('Destination is inside source');
    if (a.mount === b.mount) {
      if (op === 'move') await a.mount.driver.move(a.rel, b.rel);
      else await a.mount.driver.copy(a.rel, b.rel);
      return;
    }
    // cross-storage: stream copy, then delete
    await this.crossCopy(a, b);
    if (op === 'move') await a.mount.driver.delete(a.rel);
  }

  private async crossCopy(a: Resolved, b: Resolved): Promise<void> {
    const st = await a.mount.driver.stat(a.rel);
    if (!st) throw notFound();
    if (st.isDir) {
      await b.mount.driver.mkdir(b.rel);
      for (const c of await a.mount.driver.list(a.rel)) {
        await this.crossCopy({ ...a, rel: c.path }, { ...b, rel: joinPath(b.rel, c.name) });
      }
      return;
    }
    const r = await a.mount.driver.read(a.rel);
    await b.mount.driver.write(b.rel, r.body ?? new Uint8Array(), { size: r.size, contentType: r.contentType });
  }

  rename(vpath: string, newName: string): Promise<void> {
    if (!newName || newName.includes('/')) throw badRequest('Invalid name');
    return this.transfer(vpath, joinPath(dirname(vpath), newName), 'move');
  }
}
