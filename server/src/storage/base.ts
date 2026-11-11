import { basename, joinPath, normalizePath } from '../lib/path';
import type { ByteRange, DriverCapabilities, FileEntry, ReadResult, StorageDriver, WriteBody, WriteOptions } from './types';

/** Hidden folder used by emulated multipart uploads; never listed. */
export const TMP_DIR = '.edgedock-uploads';

export function isHidden(name: string): boolean {
  return name === TMP_DIR;
}

const enc = new TextEncoder();

export function bodyToBytesOrStream(body: WriteBody): Uint8Array | ReadableStream<Uint8Array> {
  if (typeof body === 'string') return enc.encode(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return body;
}

export function bodyLength(body: WriteBody): number | undefined {
  if (typeof body === 'string') return enc.encode(body).byteLength;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (body instanceof Uint8Array) return body.byteLength;
  return undefined;
}

/**
 * Turn a body into something `fetch` can send with a known length.
 * - Workers: wrap streams in FixedLengthStream so Content-Length is sent (S3 rejects chunked uploads).
 * - Node (undici): streams need `duplex: 'half'`; we also set Content-Length explicitly.
 */
export function fetchBody(body: WriteBody, size?: number): { body: BodyInit; headers: Record<string, string>; init: Record<string, unknown> } {
  const b = bodyToBytesOrStream(body);
  if (b instanceof Uint8Array) {
    return { body: b as unknown as BodyInit, headers: { 'content-length': String(b.byteLength) }, init: {} };
  }
  const g = globalThis as unknown as { FixedLengthStream?: new (n: number) => TransformStream };
  if (size !== undefined && g.FixedLengthStream) {
    const fls = new g.FixedLengthStream(size);
    b.pipeTo(fls.writable).catch(() => {});
    return { body: fls.readable as unknown as BodyInit, headers: {}, init: {} };
  }
  const headers: Record<string, string> = {};
  if (size !== undefined) headers['content-length'] = String(size);
  return { body: b as unknown as BodyInit, headers, init: { duplex: 'half' } };
}

export async function readAllBytes(body: WriteBody): Promise<Uint8Array> {
  const b = bodyToBytesOrStream(body);
  if (b instanceof Uint8Array) return b;
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = b.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/** Parse an HTTP Range header (single range only). Returns null if absent/invalid. */
export function parseRange(header: string | null | undefined, size: number): ByteRange | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  if (m[1] === '' && m[2] === '') return null;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix <= 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start > end || start >= size) return null;
  return { start, end };
}

export function rangeHeader(r: ByteRange): string {
  return `bytes=${r.start}-${r.end ?? ''}`;
}

/** Defaults for move/copy/rename built on the primitive operations. */
export abstract class BaseDriver implements StorageDriver {
  abstract readonly type: string;
  abstract readonly capabilities: DriverCapabilities;
  abstract list(path: string): Promise<FileEntry[]>;
  abstract stat(path: string): Promise<FileEntry | null>;
  abstract read(path: string, opts?: { range?: ByteRange }): Promise<ReadResult>;
  abstract write(path: string, body: WriteBody, opts?: WriteOptions): Promise<void>;
  abstract delete(path: string): Promise<void>;
  abstract mkdir(path: string): Promise<void>;

  async copy(from: string, to: string): Promise<void> {
    const st = await this.stat(from);
    if (!st) throw new Error(`Not found: ${from}`);
    if (st.isDir) {
      await this.mkdir(to);
      for (const child of await this.list(from)) {
        await this.copy(child.path, joinPath(to, child.name));
      }
      return;
    }
    const r = await this.read(from);
    await this.write(to, r.body ?? new Uint8Array(), { size: r.size, contentType: r.contentType });
  }

  async rename(from: string, to: string): Promise<void> {
    await this.copy(from, to);
    await this.delete(from);
  }

  move(from: string, to: string): Promise<void> {
    return this.rename(from, to);
  }

  /** Walk all files under `path` (depth-first). */
  async *walk(path = '/'): AsyncGenerator<FileEntry> {
    for (const e of await this.list(normalizePath(path))) {
      yield e;
      if (e.isDir) yield* this.walk(e.path);
    }
  }
}

export function entryName(path: string): string {
  return basename(path);
}
