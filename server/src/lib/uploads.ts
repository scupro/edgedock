import { TMP_DIR } from '../storage/base';
import type { Resolved, Vfs } from '../storage/mounts';
import type { PresignedRequest, StorageDriver, WriteBody } from '../storage/types';
import { uuid } from './crypto';
import { badRequest, classifyUpstream, gone, HttpError, notFound, RetriableError } from './errors';
import { fromBase64, md5Tap, multipartEtag, toHex } from './md5';
import { normalizePath } from './path';
import type { Env } from './types';

export const MIN_PART_SIZE = 5 * 1024 * 1024; // S3 minimum (except last part)
export const MAX_PARTS = 10_000;
/** default cap: every part may have to go through the Worker (proxy fallback) */
export const DEFAULT_MAX_PART = 50 * 1024 * 1024;

export interface UploadSessionRow {
  id: string;
  fingerprint: string | null;
  path: string;
  storage_id: string;
  object_key: string;
  size: number;
  part_size: number;
  total_parts: number;
  content_type: string | null;
  mode: 'native' | 'emulated';
  upstream_upload_id: string | null;
  status: 'active' | 'completed' | 'aborted';
  checksum?: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
}

export interface PartRow {
  part_number: number;
  etag: string | null;
  size: number;
  /** md5 hex */
  checksum?: string | null;
}

/**
 * Choose a part size: respects the provider minimum (S3: 5 MiB), the 10k part maximum,
 * and a maximum (Worker body limit / provider part limit).
 */
export function choosePartSize(size: number, preferred: number, limits: { min?: number; max?: number } = {}): number {
  const min = limits.min ?? MIN_PART_SIZE;
  const max = limits.max ?? Number.MAX_SAFE_INTEGER;
  let ps = Math.min(Math.max(preferred, min), max);
  while (Math.ceil(size / ps) > MAX_PARTS && ps * 2 <= max) ps *= 2;
  if (Math.ceil(size / ps) > MAX_PARTS) throw badRequest(`File too large: needs more than ${MAX_PARTS} parts of ${ps} bytes`);
  return ps;
}

function hexToBase64(hex: string): string {
  let s = '';
  for (let i = 0; i < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  return btoa(s);
}

/** Accept Content-MD5 (base64) or hex. Returns lowercase hex, or null when absent. */
export function normalizeMd5(v: string | null | undefined): string | null {
  if (!v) return null;
  const t = v.trim();
  if (/^[0-9a-f]{32}$/i.test(t)) return t.toLowerCase();
  try {
    const b = fromBase64(t);
    if (b.length === 16) return toHex(b);
  } catch {
    /* fallthrough */
  }
  throw badRequest('Invalid Content-MD5');
}

function rethrowUpstream(e: unknown, what: string): never {
  if (e instanceof HttpError) throw e;
  const k = classifyUpstream(e);
  const msg = (e as Error)?.message ?? String(e);
  if (k.retriable) throw new RetriableError(`${what} failed temporarily (${k.status || 'network'}): ${msg}`, k.status === 429 ? 5 : undefined);
  throw new HttpError(k.status >= 400 && k.status < 500 ? k.status : 502, `${what} failed: ${msg}`, 'upstream');
}

export function expectedPartSize(s: Pick<UploadSessionRow, 'size' | 'part_size' | 'total_parts'>, n: number): number {
  if (n < 1 || n > s.total_parts) return -1;
  if (n < s.total_parts) return s.part_size;
  return s.size - s.part_size * (s.total_parts - 1);
}

function tmpPartPath(sessionId: string, n: number): string {
  return `/${TMP_DIR}/${sessionId}/${String(n).padStart(5, '0')}`;
}

export class UploadService {
  constructor(
    private env: Env,
    private vfs: Vfs,
  ) {}

  private storageOf(s: UploadSessionRow): { driver: StorageDriver } {
    const m = this.vfs.mounts.find((x) => x.row.id === s.storage_id);
    if (!m) throw notFound('Storage of this upload session no longer exists');
    return m;
  }

  async get(id: string): Promise<{ session: UploadSessionRow; parts: PartRow[] }> {
    const session = await this.env.DB.prepare('SELECT * FROM upload_sessions WHERE id = ?').bind(id).first<UploadSessionRow>();
    if (!session) throw notFound('Upload session not found');
    const { results } = await this.env.DB.prepare('SELECT part_number, etag, size, checksum FROM upload_parts WHERE session_id = ? ORDER BY part_number').bind(id).all<PartRow>();
    return { session, parts: results };
  }

  async init(input: {
    path: string;
    size: number;
    contentType?: string;
    fingerprint?: string;
    partSize: number;
    /** max bytes per part (Worker body limit) */
    maxPartSize?: number;
    createdBy: string;
    ttlHours: number;
  }): Promise<{ session: UploadSessionRow; parts: PartRow[]; resumed: boolean }> {
    const path = normalizePath(input.path);
    if (!(input.size >= 0)) throw badRequest('size is required');
    // resume an active session for the same file
    if (input.fingerprint) {
      const ex = await this.env.DB.prepare(
        "SELECT id FROM upload_sessions WHERE fingerprint = ? AND path = ? AND size = ? AND status = 'active' AND expires_at > ? ORDER BY created_at DESC LIMIT 1",
      )
        .bind(input.fingerprint, path, input.size, Date.now())
        .first<{ id: string }>();
      if (ex) {
        const cur = await this.get(ex.id);
        // verify what the server/provider really has before telling the client to skip parts
        const parts = await this.reconcile(cur.session, cur.parts).catch(() => cur.parts);
        return { session: cur.session, parts, resumed: true };
      }
    }
    const r: Resolved = this.vfs.mustResolve(path);
    const driver = r.mount.driver;
    if (driver.capabilities.readOnly) throw badRequest('Storage is read-only');
    const caps = driver.capabilities;
    const mode = driver.multipart ? 'native' : 'emulated';
    const max = Math.min(input.maxPartSize ?? DEFAULT_MAX_PART, caps.maxPartSize ?? Number.MAX_SAFE_INTEGER);
    const min = Math.min(caps.minPartSize ?? (mode === 'native' ? MIN_PART_SIZE : 1024 * 1024), max);
    const partSize = choosePartSize(input.size, input.partSize, { min, max });
    const totalParts = Math.max(1, Math.ceil(input.size / partSize));
    let upstreamId: string | null = null;
    if (driver.multipart) {
      try {
        upstreamId = await driver.multipart.create(r.rel, { contentType: input.contentType });
      } catch (e) {
        rethrowUpstream(e, 'Create multipart upload');
      }
    }
    const now = Date.now();
    const s: UploadSessionRow = {
      id: uuid(),
      fingerprint: input.fingerprint ?? null,
      path,
      storage_id: r.mount.row.id,
      object_key: r.rel,
      size: input.size,
      part_size: partSize,
      total_parts: totalParts,
      content_type: input.contentType ?? null,
      mode,
      upstream_upload_id: upstreamId,
      status: 'active',
      created_by: input.createdBy,
      created_at: now,
      updated_at: now,
      expires_at: now + input.ttlHours * 3600_000,
    };
    await this.env.DB.prepare(
      `INSERT INTO upload_sessions (id, fingerprint, path, storage_id, object_key, size, part_size, total_parts, content_type, mode, upstream_upload_id, status, created_by, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
    )
      .bind(s.id, s.fingerprint, s.path, s.storage_id, s.object_key, s.size, s.part_size, s.total_parts, s.content_type, s.mode, s.upstream_upload_id, s.created_by, now, now, s.expires_at)
      .run();
    return { session: s, parts: [], resumed: false };
  }

  private assertActive(s: UploadSessionRow) {
    if (s.status !== 'active') throw gone(`Upload session is ${s.status}`);
    if (s.expires_at <= Date.now()) throw gone('Upload session expired');
  }

  /** Presigned URLs for direct-to-S3 part uploads (native mode + presign-capable driver only). */
  async signParts(id: string, partNumbers: number[], expiresIn = 3600): Promise<Record<number, PresignedRequest>> {
    const { session } = await this.get(id);
    this.assertActive(session);
    const { driver } = this.storageOf(session);
    if (session.mode !== 'native' || !driver.multipart?.presignPart) throw badRequest('Direct part upload is not supported by this storage');
    const out: Record<number, PresignedRequest> = {};
    for (const n of partNumbers.slice(0, 100)) {
      if (expectedPartSize(session, n) < 0) throw badRequest(`Invalid part number ${n}`);
      out[n] = await driver.multipart.presignPart(session.object_key, session.upstream_upload_id!, n, expiresIn);
    }
    return out;
  }

  /**
   * Upload a part through the worker. The body is streamed (never buffered) and hashed on the fly;
   * `md5` (Content-MD5 base64 or hex) is verified: natively by S3, and by us for emulated parts.
   * Upstream failures are classified: retriable → 503 + X-EdgeDock-Retriable, otherwise 4xx/502.
   */
  async uploadPart(id: string, n: number, body: WriteBody, size: number, md5?: string | null): Promise<PartRow> {
    const { session } = await this.get(id);
    this.assertActive(session);
    const expected = expectedPartSize(session, n);
    if (expected < 0) throw badRequest(`Invalid part number ${n}`);
    if (size !== expected) throw badRequest(`Part ${n} must be ${expected} bytes, got ${size}`);
    const want = normalizeMd5(md5);
    const { driver } = this.storageOf(session);
    const tap = md5Tap();
    const src: ReadableStream<Uint8Array> =
      body instanceof ReadableStream
        ? body
        : new ReadableStream({
            start(c) {
              c.enqueue(typeof body === 'string' ? new TextEncoder().encode(body) : body instanceof ArrayBuffer ? new Uint8Array(body) : body);
              c.close();
            },
          });
    const hashed = src.pipeThrough(tap.stream);
    let etag: string;
    try {
      if (session.mode === 'native') {
        etag = (await driver.multipart!.uploadPart(session.object_key, session.upstream_upload_id!, n, hashed, size, want ? { md5: hexToBase64(want) } : undefined)).etag;
      } else {
        await driver.write(tmpPartPath(session.id, n), hashed, { size, contentType: 'application/octet-stream' });
        etag = `emulated-${n}`;
      }
    } catch (e) {
      rethrowUpstream(e, `Part ${n} upload`);
    }
    const got = tap.result();
    if (got.bytes !== size || (want && got.hex !== want)) {
      // corrupted / truncated in transit: drop it so the client re-sends
      if (session.mode === 'emulated') await driver.delete(tmpPartPath(session.id, n)).catch(() => {});
      throw new RetriableError(got.bytes !== size ? `Part ${n} truncated: received ${got.bytes} of ${size} bytes` : `Part ${n} checksum mismatch`, undefined, 422);
    }
    return this.recordPart(session, n, etag, size, got.hex);
  }

  /**
   * Bring D1's part list in line with what the provider actually holds:
   * native → ListParts (drops parts S3 doesn't have, adopts parts uploaded directly whose ack was lost);
   * emulated → stat each temp part (drops missing / wrong-size parts).
   */
  async reconcile(session: UploadSessionRow, parts: PartRow[]): Promise<PartRow[]> {
    if (session.status !== 'active') return parts;
    const { driver } = this.storageOf(session);
    const keep = new Map<number, PartRow>();
    if (session.mode === 'native') {
      if (!driver.multipart?.listParts) return parts;
      const upstream = await driver.multipart.listParts(session.object_key, session.upstream_upload_id!);
      const byN = new Map(upstream.map((p) => [p.partNumber, p]));
      for (const p of parts) {
        const u = byN.get(p.part_number);
        if (u && (u.size === undefined || u.size === p.size)) keep.set(p.part_number, { ...p, etag: p.etag || u.etag });
      }
      for (const u of upstream) {
        if (keep.has(u.partNumber)) continue;
        const exp = expectedPartSize(session, u.partNumber);
        if (exp >= 0 && u.size === exp) keep.set(u.partNumber, { part_number: u.partNumber, etag: u.etag, size: exp, checksum: null });
      }
    } else {
      const listed = await driver.list(`/${TMP_DIR}/${session.id}`).catch(() => []);
      const sizes = new Map(listed.map((e) => [Number(e.name), e.size]));
      for (const p of parts) if (sizes.get(p.part_number) === p.size) keep.set(p.part_number, p);
    }
    const final = [...keep.values()].sort((a, b) => a.part_number - b.part_number);
    const changed = final.length !== parts.length || final.some((p, i) => p.part_number !== parts[i]?.part_number);
    if (changed) {
      const stmts = [this.env.DB.prepare('DELETE FROM upload_parts WHERE session_id = ?').bind(session.id)];
      for (const p of final)
        stmts.push(
          this.env.DB.prepare('INSERT INTO upload_parts (session_id, part_number, etag, size, checksum, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(session.id, p.part_number, p.etag, p.size, p.checksum ?? null, Date.now()),
        );
      await this.env.DB.batch(stmts);
    }
    return final;
  }

  /** Record a part uploaded directly to S3 via presigned URL. */
  async ackPart(id: string, n: number, etag: string | null, size: number, md5?: string | null): Promise<PartRow> {
    const { session } = await this.get(id);
    this.assertActive(session);
    const expected = expectedPartSize(session, n);
    if (expected < 0) throw badRequest(`Invalid part number ${n}`);
    if (size !== expected) throw badRequest(`Part ${n} must be ${expected} bytes`);
    const want = normalizeMd5(md5);
    const plainEtag = etag?.replace(/"/g, '').toLowerCase() ?? '';
    // for plain (non-KMS) S3 the part ETag *is* its MD5: catch corruption on direct uploads
    if (want && /^[0-9a-f]{32}$/.test(plainEtag) && plainEtag !== want) throw new RetriableError(`Part ${n} checksum mismatch (ETag ${plainEtag})`, undefined, 422);
    return this.recordPart(session, n, etag, size, want);
  }

  private async recordPart(s: UploadSessionRow, n: number, etag: string | null, size: number, checksum: string | null = null): Promise<PartRow> {
    const now = Date.now();
    await this.env.DB.batch([
      this.env.DB.prepare(
        'INSERT INTO upload_parts (session_id, part_number, etag, size, checksum, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(session_id, part_number) DO UPDATE SET etag = excluded.etag, size = excluded.size, checksum = excluded.checksum, created_at = excluded.created_at',
      ).bind(s.id, n, etag, size, checksum, now),
      this.env.DB.prepare('UPDATE upload_sessions SET updated_at = ? WHERE id = ?').bind(now, s.id),
    ]);
    return { part_number: n, etag, size, checksum };
  }

  async complete(id: string): Promise<UploadSessionRow> {
    const { session, parts } = await this.get(id);
    this.assertActive(session);
    const missing: number[] = [];
    const have = new Map(parts.map((p) => [p.part_number, p]));
    for (let i = 1; i <= session.total_parts; i++) if (!have.has(i)) missing.push(i);
    if (missing.length) throw badRequest(`Missing parts: ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? '…' : ''}`);
    const { driver } = this.storageOf(session);
    let checksum: string | null = null;
    if (session.mode === 'native') {
      let list = parts.map((p) => ({ partNumber: p.part_number, etag: p.etag ?? '' }));
      if (list.some((p) => !p.etag) && driver.multipart?.listParts) {
        // ETag header not exposed to browser (bucket CORS) -> ask S3
        const upstream = await driver.multipart.listParts(session.object_key, session.upstream_upload_id!);
        const map = new Map(upstream.map((p) => [p.partNumber, p.etag]));
        list = list.map((p) => ({ partNumber: p.partNumber, etag: p.etag || map.get(p.partNumber) || '' }));
      }
      if (list.some((p) => !p.etag)) throw badRequest('Some parts have no ETag; expose the ETag header in bucket CORS');
      try {
        await driver.multipart!.complete(session.object_key, session.upstream_upload_id!, list);
      } catch (e) {
        rethrowUpstream(e, 'Complete multipart upload');
      }
    } else {
      // every temp part must be present with the right size before we concatenate
      const listed = await driver.list(`/${TMP_DIR}/${session.id}`);
      const sizes = new Map(listed.map((e) => [Number(e.name), e.size]));
      const bad = parts.filter((p) => sizes.get(p.part_number) !== p.size).map((p) => p.part_number);
      if (bad.length) {
        await this.env.DB.prepare(`DELETE FROM upload_parts WHERE session_id = ? AND part_number IN (${bad.map(() => '?').join(',')})`).bind(id, ...bad).run();
        throw new HttpError(409, `Parts missing on storage, re-upload: ${bad.slice(0, 20).join(', ')}`, 'parts_missing');
      }
      // concatenate temp parts into the final object, streaming
      const total = session.total_parts;
      let i = 1;
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      const stream = new ReadableStream<Uint8Array>({
        async pull(ctrl) {
          for (;;) {
            if (!reader) {
              if (i > total) {
                ctrl.close();
                return;
              }
              const r = await driver.read(tmpPartPath(session.id, i++));
              reader = r.body!.getReader();
            }
            const { done, value } = await reader.read();
            if (done) {
              reader = null;
              continue;
            }
            ctrl.enqueue(value);
            return;
          }
        },
      });
      const tap = md5Tap();
      try {
        await driver.write(session.object_key, stream.pipeThrough(tap.stream), { size: session.size, contentType: session.content_type ?? undefined });
      } catch (e) {
        rethrowUpstream(e, 'Assemble upload');
      }
      if (tap.result().bytes !== session.size) throw new HttpError(500, `Assembled ${tap.result().bytes} bytes, expected ${session.size}`, 'integrity');
      checksum = tap.result().hex;
      await driver.delete(`/${TMP_DIR}/${session.id}`).catch(() => {});
    }
    // final verification: size (and multipart ETag when every part MD5 is known)
    const st = await driver.stat(session.object_key).catch(() => null);
    if (st && !st.isDir && st.size !== session.size) throw new HttpError(500, `Final object is ${st.size} bytes, expected ${session.size}`, 'integrity');
    if (session.mode === 'native') {
      const sums = parts.map((p) => p.checksum);
      if (sums.every((x): x is string => !!x)) {
        const expectedEtag = multipartEtag(sums);
        checksum = expectedEtag;
        const actual = st?.etag?.replace(/"/g, '');
        if (actual && /^[0-9a-f]{32}-\d+$/.test(actual) && actual !== expectedEtag) throw new HttpError(500, `Final ETag ${actual} != expected ${expectedEtag}`, 'integrity');
      }
    }
    const now = Date.now();
    await this.env.DB.batch([
      this.env.DB.prepare("UPDATE upload_sessions SET status = 'completed', checksum = ?, updated_at = ? WHERE id = ?").bind(checksum, now, id),
      this.env.DB.prepare('DELETE FROM upload_parts WHERE session_id = ?').bind(id),
    ]);
    return { ...session, status: 'completed', checksum, updated_at: now };
  }

  async abort(id: string): Promise<void> {
    const { session } = await this.get(id);
    if (session.status !== 'active') return;
    try {
      const { driver } = this.storageOf(session);
      if (session.mode === 'native') await driver.multipart!.abort(session.object_key, session.upstream_upload_id!);
      else await driver.delete(`/${TMP_DIR}/${session.id}`);
    } catch (e) {
      console.warn('[edgedock] abort upstream failed', (e as Error).message);
    }
    await this.env.DB.batch([
      this.env.DB.prepare("UPDATE upload_sessions SET status = 'aborted', updated_at = ? WHERE id = ?").bind(Date.now(), id),
      this.env.DB.prepare('DELETE FROM upload_parts WHERE session_id = ?').bind(id),
    ]);
  }

  /** Abort expired active sessions and purge old finished ones. Returns number aborted. */
  async cleanupExpired(now = Date.now()): Promise<number> {
    const { results } = await this.env.DB.prepare("SELECT id FROM upload_sessions WHERE status = 'active' AND expires_at <= ? LIMIT 200").bind(now).all<{ id: string }>();
    for (const r of results) await this.abort(r.id);
    await this.env.DB.prepare("DELETE FROM upload_sessions WHERE status != 'active' AND updated_at < ?").bind(now - 7 * 86400_000).run();
    return results.length;
  }

  /**
   * Abort provider-side multipart uploads / emulated temp folders that no active session owns
   * (e.g. the D1 row was purged, or a crash happened between create and insert).
   * Only touches uploads older than `minAgeMs` so in-flight inits are safe.
   */
  async cleanupOrphans(minAgeMs = 24 * 3600_000, now = Date.now()): Promise<number> {
    const { results } = await this.env.DB.prepare("SELECT id, storage_id, upstream_upload_id FROM upload_sessions WHERE status = 'active'").all<{
      id: string;
      storage_id: string;
      upstream_upload_id: string | null;
    }>();
    const activeIds = new Set(results.map((r) => r.id));
    const activeUpstream = new Set(results.map((r) => r.upstream_upload_id).filter(Boolean));
    let n = 0;
    for (const m of this.vfs.mounts) {
      const d = m.driver;
      if (d.capabilities.readOnly) continue;
      try {
        if (d.multipart?.listUploads) {
          for (const u of await d.multipart.listUploads()) {
            if (activeUpstream.has(u.uploadId)) continue;
            if (u.initiated && now - u.initiated < minAgeMs) continue;
            await d.multipart.abort(u.key, u.uploadId);
            n++;
          }
        }
        const tmp = await d.list(`/${TMP_DIR}`).catch(() => []);
        for (const e of tmp) {
          if (!e.isDir || activeIds.has(e.name)) continue;
          if (e.modified && now - e.modified < minAgeMs) continue;
          await d.delete(e.path);
          n++;
        }
      } catch (e) {
        console.warn('[edgedock] orphan cleanup failed for', m.row.mount_path, (e as Error).message);
      }
    }
    return n;
  }
}

