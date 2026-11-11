/**
 * Base for "message" storages (Telegram, Discord): files are split into parts of at most
 * `partLimit` bytes, each part stored as one document/attachment; the directory tree and the
 * part list live in D1 (`blob_entries`). Reads reassemble the parts on the fly with Range support.
 *
 * EdgeDock multipart sessions are native here: every session part becomes one provider part,
 * the file entry is written on complete — nothing is uploaded twice.
 */
import { uuid } from '../lib/crypto';
import { basename, dirname, normalizePath } from '../lib/path';
import { mimeFromPath } from '../lib/mime';
import type { DB, Env } from '../lib/types';
import { BaseDriver } from './base';
import { chunksOf, ProviderError, readUpTo, sliceStream } from './http';
import type { ByteRange, DriverContext, FileEntry, MultipartSupport, PendingUpstreamUpload, ReadResult, UploadedPart, WriteBody, WriteOptions } from './types';

export interface PartRef {
  size: number;
  [k: string]: unknown;
}

interface EntryRow {
  path: string;
  parent: string;
  name: string;
  is_dir: number;
  size: number;
  content_type: string | null;
  parts: string | null;
  modified: number;
}

export abstract class PartStoreDriver extends BaseDriver {
  abstract readonly type: string;
  readonly multipart: MultipartSupport;
  protected env?: Env;
  protected storageId?: string;

  constructor(
    ctx: DriverContext,
    /** max bytes per stored part */
    readonly partLimit: number,
  ) {
    super();
    this.env = ctx.env;
    this.storageId = ctx.storageId;
    this.multipart = {
      create: (p, o) => this.mpCreate(p, o.contentType),
      uploadPart: (_p, id, n, body, size) => this.mpPart(id, n, body, size),
      complete: (_p, id) => this.mpComplete(id),
      abort: (_p, id) => this.mpAbort(id),
      listParts: (_p, id) => this.mpList(id),
      listUploads: () => this.mpUploads(),
    };
  }

  get capabilities() {
    return { presign: false, multipart: true, rangeRead: true, maxPartSize: this.partLimit, minPartSize: Math.min(1024 * 1024, this.partLimit) };
  }

  /** upload one part; returns a reference stored in D1 */
  protected abstract putPart(bytes: Uint8Array, name: string): Promise<PartRef>;
  /** download (a byte range of) one part; `ranged` = the server honoured the Range header */
  protected abstract openPart(ref: PartRef, range?: { start: number; end: number }): Promise<{ body: ReadableStream<Uint8Array>; ranged: boolean }>;
  protected abstract deletePart(ref: PartRef): Promise<void>;

  private get db(): DB {
    if (!this.env?.DB || !this.storageId) throw new ProviderError(500, `${this.type}: metadata store unavailable (save the storage first)`);
    return this.env.DB;
  }

  private async row(path: string): Promise<EntryRow | null> {
    return this.db.prepare('SELECT * FROM blob_entries WHERE storage_id = ? AND path = ?').bind(this.storageId, path).first<EntryRow>();
  }

  private toEntry(r: EntryRow): FileEntry {
    return {
      name: r.name,
      path: r.path,
      isDir: !!r.is_dir,
      size: r.size,
      modified: r.modified,
      contentType: r.is_dir ? undefined : r.content_type ?? mimeFromPath(r.name),
      etag: r.is_dir ? undefined : `${r.size}-${r.modified}`,
    };
  }

  async list(path: string): Promise<FileEntry[]> {
    const p = normalizePath(path);
    if (p !== '/') {
      const r = await this.row(p);
      if (!r || !r.is_dir) throw new ProviderError(404, `Not found: ${p}`);
    }
    const { results } = await this.db.prepare('SELECT * FROM blob_entries WHERE storage_id = ? AND parent = ? ORDER BY is_dir DESC, name').bind(this.storageId, p).all<EntryRow>();
    return results.map((r) => this.toEntry(r));
  }

  async stat(path: string): Promise<FileEntry | null> {
    const p = normalizePath(path);
    if (p === '/') return { name: '', path: '/', isDir: true, size: 0 };
    const r = await this.row(p);
    return r ? this.toEntry(r) : null;
  }

  async mkdir(path: string): Promise<void> {
    const p = normalizePath(path);
    if (p === '/') return;
    const ex = await this.row(p);
    if (ex) {
      if (!ex.is_dir) throw new ProviderError(409, `${p} is a file`);
      return;
    }
    await this.mkdir(dirname(p));
    await this.db
      .prepare('INSERT OR IGNORE INTO blob_entries (storage_id, path, parent, name, is_dir, size, modified) VALUES (?, ?, ?, ?, 1, 0, ?)')
      .bind(this.storageId, p, dirname(p), basename(p), Date.now())
      .run();
  }

  /** Replace/insert a file entry; returns the parts of the version it replaced. */
  private async putEntry(path: string, size: number, contentType: string | undefined, parts: PartRef[]): Promise<PartRef[]> {
    const p = normalizePath(path);
    await this.mkdir(dirname(p));
    const old = await this.row(p);
    if (old?.is_dir) throw new ProviderError(409, `${p} is a directory`);
    await this.db
      .prepare(
        `INSERT INTO blob_entries (storage_id, path, parent, name, is_dir, size, content_type, parts, modified) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)
         ON CONFLICT(storage_id, path) DO UPDATE SET size = excluded.size, content_type = excluded.content_type, parts = excluded.parts, modified = excluded.modified`,
      )
      .bind(this.storageId, p, dirname(p), basename(p), size, contentType ?? mimeFromPath(p), JSON.stringify(parts), Date.now())
      .run();
    return old?.parts ? (JSON.parse(old.parts) as PartRef[]) : [];
  }

  private async dropParts(parts: PartRef[]) {
    for (const r of parts) await this.deletePart(r).catch((e) => console.warn(`[edgedock] ${this.type}: could not delete part`, (e as Error).message));
  }

  async write(path: string, body: WriteBody, opts: WriteOptions = {}): Promise<void> {
    const p = normalizePath(path);
    const src = typeof body === 'string' ? new TextEncoder().encode(body) : body instanceof ArrayBuffer ? new Uint8Array(body) : body;
    const parts: PartRef[] = [];
    let total = 0;
    let i = 0;
    try {
      for await (const piece of chunksOf(src, this.partLimit)) {
        if (!piece.byteLength && i > 0) break;
        if (!piece.byteLength) break; // empty file: no parts
        parts.push(await this.putPart(piece, `${basename(p)}.${String(++i).padStart(4, '0')}`));
        total += piece.byteLength;
      }
    } catch (e) {
      await this.dropParts(parts);
      throw e;
    }
    if (opts.size !== undefined && opts.size !== total) {
      await this.dropParts(parts);
      throw new ProviderError(400, `Body was ${total} bytes, expected ${opts.size}`);
    }
    await this.dropParts(await this.putEntry(p, total, opts.contentType, parts));
  }

  async read(path: string, opts: { range?: ByteRange } = {}): Promise<ReadResult> {
    const p = normalizePath(path);
    const r = await this.row(p);
    if (!r || r.is_dir) throw new ProviderError(404, `Not found: ${p}`);
    const parts = (r.parts ? JSON.parse(r.parts) : []) as PartRef[];
    const size = r.size;
    const start = opts.range?.start ?? 0;
    const end = Math.min(opts.range?.end ?? size - 1, size - 1);
    // which parts overlap [start, end]
    const plan: { ref: PartRef; from: number; to: number }[] = [];
    let off = 0;
    for (const ref of parts) {
      const a = off;
      const b = off + ref.size - 1;
      if (b >= start && a <= end) plan.push({ ref, from: Math.max(start, a) - a, to: Math.min(end, b) - a });
      off += ref.size;
    }
    let idx = 0;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    const self = this;
    const body =
      size === 0
        ? new ReadableStream<Uint8Array>({ start: (c) => c.close() })
        : new ReadableStream<Uint8Array>({
            async pull(ctrl) {
              for (;;) {
                if (!reader) {
                  if (idx >= plan.length) return ctrl.close();
                  const step = plan[idx++];
                  const whole = step.from === 0 && step.to === step.ref.size - 1;
                  const o = await self.openPart(step.ref, whole ? undefined : { start: step.from, end: step.to });
                  reader = (o.ranged || whole ? o.body : sliceStream(o.body, step.from, step.to)).getReader();
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
            cancel() {
              return reader?.cancel();
            },
          });
    return {
      body,
      size,
      contentType: r.content_type ?? mimeFromPath(p),
      modified: r.modified,
      etag: `${r.size}-${r.modified}`,
      range: opts.range ? { start, end } : undefined,
    };
  }

  private async subtree(p: string): Promise<EntryRow[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM blob_entries WHERE storage_id = ? AND (path = ? OR substr(path, 1, ?) = ?)')
      .bind(this.storageId, p, p.length + 1, p + '/')
      .all<EntryRow>();
    return results;
  }

  async delete(path: string): Promise<void> {
    const p = normalizePath(path);
    if (p === '/') throw new ProviderError(400, 'Refusing to delete the storage root');
    const rows = await this.subtree(p);
    for (const r of rows) if (r.parts) await this.dropParts(JSON.parse(r.parts));
    await this.db.prepare('DELETE FROM blob_entries WHERE storage_id = ? AND (path = ? OR substr(path, 1, ?) = ?)').bind(this.storageId, p, p.length + 1, p + '/').run();
  }

  /** metadata-only move: parts stay where they are */
  async rename(from: string, to: string): Promise<void> {
    const a = normalizePath(from);
    const b = normalizePath(to);
    if (a === b) return;
    const rows = await this.subtree(a);
    if (!rows.length) throw new ProviderError(404, `Not found: ${a}`);
    const target = await this.row(b);
    if (target) await this.delete(b);
    await this.mkdir(dirname(b));
    const stmts = [this.db.prepare('DELETE FROM blob_entries WHERE storage_id = ? AND (path = ? OR substr(path, 1, ?) = ?)').bind(this.storageId, a, a.length + 1, a + '/')];
    for (const r of rows) {
      const np = b + r.path.slice(a.length);
      stmts.push(
        this.db
          .prepare('INSERT INTO blob_entries (storage_id, path, parent, name, is_dir, size, content_type, parts, modified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(this.storageId, np, dirname(np), basename(np), r.is_dir, r.size, r.content_type, r.parts, Date.now()),
      );
    }
    await this.db.batch(stmts);
  }

  // ------------------------------------------------------------ native multipart
  private async mpCreate(path: string, contentType?: string): Promise<string> {
    const id = uuid();
    await this.db.prepare('INSERT INTO blob_uploads (upload_id, storage_id, path, content_type, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, this.storageId, normalizePath(path), contentType ?? null, Date.now()).run();
    return id;
  }

  private async mpPart(id: string, n: number, body: WriteBody, size: number): Promise<{ etag: string }> {
    if (size > this.partLimit) throw new ProviderError(400, `Part larger than ${this.partLimit} bytes`);
    const bytes = await readUpTo(body as ReadableStream<Uint8Array>, this.partLimit);
    if (bytes.byteLength !== size) throw new ProviderError(400, `Part ${n}: got ${bytes.byteLength} of ${size} bytes`);
    const up = await this.db.prepare('SELECT path FROM blob_uploads WHERE upload_id = ?').bind(id).first<{ path: string }>();
    if (!up) throw new ProviderError(404, 'Unknown upload');
    const ref = await this.putPart(bytes, `${basename(up.path)}.${String(n).padStart(4, '0')}`);
    const prev = await this.db.prepare('SELECT refs FROM blob_upload_parts WHERE upload_id = ? AND part_number = ?').bind(id, n).first<{ refs: string }>();
    await this.db
      .prepare('INSERT INTO blob_upload_parts (upload_id, part_number, refs, size, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(upload_id, part_number) DO UPDATE SET refs = excluded.refs, size = excluded.size')
      .bind(id, n, JSON.stringify([ref]), size, Date.now())
      .run();
    if (prev) await this.dropParts(JSON.parse(prev.refs));
    return { etag: `${this.type}-${n}` };
  }

  private async mpList(id: string): Promise<UploadedPart[]> {
    const { results } = await this.db.prepare('SELECT part_number, size FROM blob_upload_parts WHERE upload_id = ? ORDER BY part_number').bind(id).all<{ part_number: number; size: number }>();
    return results.map((r) => ({ partNumber: r.part_number, etag: `${this.type}-${r.part_number}`, size: r.size }));
  }

  private async mpComplete(id: string): Promise<void> {
    const up = await this.db.prepare('SELECT path, content_type FROM blob_uploads WHERE upload_id = ?').bind(id).first<{ path: string; content_type: string | null }>();
    if (!up) throw new ProviderError(404, 'Unknown upload');
    const { results } = await this.db.prepare('SELECT refs, size FROM blob_upload_parts WHERE upload_id = ? ORDER BY part_number').bind(id).all<{ refs: string; size: number }>();
    const parts = results.flatMap((r) => JSON.parse(r.refs) as PartRef[]);
    const size = results.reduce((a, r) => a + r.size, 0);
    const old = await this.putEntry(up.path, size, up.content_type ?? undefined, parts);
    await this.db.batch([this.db.prepare('DELETE FROM blob_upload_parts WHERE upload_id = ?').bind(id), this.db.prepare('DELETE FROM blob_uploads WHERE upload_id = ?').bind(id)]);
    await this.dropParts(old);
  }

  private async mpAbort(id: string): Promise<void> {
    const { results } = await this.db.prepare('SELECT refs FROM blob_upload_parts WHERE upload_id = ?').bind(id).all<{ refs: string }>();
    for (const r of results) await this.dropParts(JSON.parse(r.refs));
    await this.db.batch([this.db.prepare('DELETE FROM blob_upload_parts WHERE upload_id = ?').bind(id), this.db.prepare('DELETE FROM blob_uploads WHERE upload_id = ?').bind(id)]);
  }

  private async mpUploads(): Promise<PendingUpstreamUpload[]> {
    const { results } = await this.db.prepare('SELECT upload_id, path, created_at FROM blob_uploads WHERE storage_id = ?').bind(this.storageId).all<{ upload_id: string; path: string; created_at: number }>();
    return results.map((r) => ({ key: r.path, uploadId: r.upload_id, initiated: r.created_at }));
  }
}

