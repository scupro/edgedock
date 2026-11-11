import { TMP_DIR } from '../storage/base';
import type { Resolved, Vfs } from '../storage/mounts';
import type { PresignedRequest, StorageDriver, WriteBody } from '../storage/types';
import { uuid } from './crypto';
import { badRequest, gone, notFound } from './errors';
import { normalizePath } from './path';
import type { Env } from './types';

export const MIN_PART_SIZE = 5 * 1024 * 1024; // S3 minimum (except last part)
export const MAX_PARTS = 10_000;

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
  created_by: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
}

export interface PartRow {
  part_number: number;
  etag: string | null;
  size: number;
}

/** Choose a part size that respects S3's minimum and 10k part maximum. */
export function choosePartSize(size: number, preferred: number): number {
  let ps = Math.max(preferred, MIN_PART_SIZE);
  while (Math.ceil(size / ps) > MAX_PARTS) ps *= 2;
  return ps;
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
    const { results } = await this.env.DB.prepare('SELECT part_number, etag, size FROM upload_parts WHERE session_id = ? ORDER BY part_number').bind(id).all<PartRow>();
    return { session, parts: results };
  }

  async init(input: {
    path: string;
    size: number;
    contentType?: string;
    fingerprint?: string;
    partSize: number;
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
      if (ex) return { ...(await this.get(ex.id)), resumed: true };
    }
    const r: Resolved = this.vfs.mustResolve(path);
    const driver = r.mount.driver;
    if (driver.capabilities.readOnly) throw badRequest('Storage is read-only');
    const partSize = choosePartSize(input.size, input.partSize);
    const totalParts = Math.max(1, Math.ceil(input.size / partSize));
    const mode = driver.multipart ? 'native' : 'emulated';
    const upstreamId = driver.multipart ? await driver.multipart.create(r.rel, { contentType: input.contentType }) : null;
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

  /** Upload a part through the worker. */
  async uploadPart(id: string, n: number, body: WriteBody, size: number): Promise<PartRow> {
    const { session } = await this.get(id);
    this.assertActive(session);
    const expected = expectedPartSize(session, n);
    if (expected < 0) throw badRequest(`Invalid part number ${n}`);
    if (size !== expected) throw badRequest(`Part ${n} must be ${expected} bytes, got ${size}`);
    const { driver } = this.storageOf(session);
    let etag: string;
    if (session.mode === 'native') {
      etag = (await driver.multipart!.uploadPart(session.object_key, session.upstream_upload_id!, n, body, size)).etag;
    } else {
      await driver.write(tmpPartPath(session.id, n), body, { size, contentType: 'application/octet-stream' });
      etag = `emulated-${n}`;
    }
    return this.recordPart(session, n, etag, size);
  }

  /** Record a part uploaded directly to S3 via presigned URL. */
  async ackPart(id: string, n: number, etag: string | null, size: number): Promise<PartRow> {
    const { session } = await this.get(id);
    this.assertActive(session);
    const expected = expectedPartSize(session, n);
    if (expected < 0) throw badRequest(`Invalid part number ${n}`);
    if (size !== expected) throw badRequest(`Part ${n} must be ${expected} bytes`);
    return this.recordPart(session, n, etag, size);
  }

  private async recordPart(s: UploadSessionRow, n: number, etag: string | null, size: number): Promise<PartRow> {
    const now = Date.now();
    await this.env.DB.batch([
      this.env.DB.prepare(
        'INSERT INTO upload_parts (session_id, part_number, etag, size, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id, part_number) DO UPDATE SET etag = excluded.etag, size = excluded.size, created_at = excluded.created_at',
      ).bind(s.id, n, etag, size, now),
      this.env.DB.prepare('UPDATE upload_sessions SET updated_at = ? WHERE id = ?').bind(now, s.id),
    ]);
    return { part_number: n, etag, size };
  }

  async complete(id: string): Promise<UploadSessionRow> {
    const { session, parts } = await this.get(id);
    this.assertActive(session);
    const missing: number[] = [];
    const have = new Map(parts.map((p) => [p.part_number, p]));
    for (let i = 1; i <= session.total_parts; i++) if (!have.has(i)) missing.push(i);
    if (missing.length) throw badRequest(`Missing parts: ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? '…' : ''}`);
    const { driver } = this.storageOf(session);
    if (session.mode === 'native') {
      let list = parts.map((p) => ({ partNumber: p.part_number, etag: p.etag ?? '' }));
      if (list.some((p) => !p.etag) && driver.multipart?.listParts) {
        // ETag header not exposed to browser (bucket CORS) -> ask S3
        const upstream = await driver.multipart.listParts(session.object_key, session.upstream_upload_id!);
        const map = new Map(upstream.map((p) => [p.partNumber, p.etag]));
        list = list.map((p) => ({ partNumber: p.partNumber, etag: p.etag || map.get(p.partNumber) || '' }));
      }
      if (list.some((p) => !p.etag)) throw badRequest('Some parts have no ETag; expose the ETag header in bucket CORS');
      await driver.multipart!.complete(session.object_key, session.upstream_upload_id!, list);
    } else {
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
      await driver.write(session.object_key, stream, { size: session.size, contentType: session.content_type ?? undefined });
      await driver.delete(`/${TMP_DIR}/${session.id}`).catch(() => {});
    }
    const now = Date.now();
    await this.env.DB.batch([
      this.env.DB.prepare("UPDATE upload_sessions SET status = 'completed', updated_at = ? WHERE id = ?").bind(now, id),
      this.env.DB.prepare('DELETE FROM upload_parts WHERE session_id = ?').bind(id),
    ]);
    return { ...session, status: 'completed', updated_at: now };
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
}

