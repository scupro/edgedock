/**
 * Local filesystem driver — Node / Docker runtime ONLY.
 * Never import this file from the Workers entry.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { basename, joinPath, normalizePath } from '../lib/path';
import { mimeFromPath } from '../lib/mime';
import { BaseDriver, bodyToBytesOrStream, isHidden } from './base';
import type { ByteRange, DriverDefinition, FileEntry, ReadResult, WriteBody } from './types';

export class LocalDriver extends BaseDriver {
  readonly type = 'local';
  readonly capabilities = { presign: false, multipart: false, rangeRead: true };
  private root: string;

  constructor(cfg: { root: string }) {
    super();
    if (!cfg.root) throw new Error('local root is required');
    this.root = nodePath.resolve(cfg.root);
  }

  /** storage-relative path -> absolute fs path (traversal-safe) */
  fsPath(path: string): string {
    const abs = nodePath.resolve(this.root, '.' + normalizePath(path));
    if (abs !== this.root && !abs.startsWith(this.root + nodePath.sep)) throw new Error('Path escapes storage root');
    return abs;
  }

  private toEntry(path: string, st: import('node:fs').Stats): FileEntry {
    const name = basename(path);
    return {
      name,
      path: normalizePath(path),
      isDir: st.isDirectory(),
      size: st.isDirectory() ? 0 : st.size,
      modified: st.mtimeMs,
      etag: `${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}`,
      contentType: st.isDirectory() ? undefined : mimeFromPath(name),
    };
  }

  async list(path: string): Promise<FileEntry[]> {
    const dir = this.fsPath(path);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (e: any) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
    const out: FileEntry[] = [];
    for (const n of names) {
      if (isHidden(n)) continue;
      try {
        out.push(this.toEntry(joinPath(path, n), await fs.stat(nodePath.join(dir, n))));
      } catch {
        /* broken symlink etc. */
      }
    }
    return out;
  }

  async stat(path: string): Promise<FileEntry | null> {
    try {
      return this.toEntry(path, await fs.stat(this.fsPath(path)));
    } catch (e: any) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }

  async read(path: string, opts: { range?: ByteRange } = {}): Promise<ReadResult> {
    const p = this.fsPath(path);
    const st = await fs.stat(p);
    let range: ReadResult['range'];
    let stream;
    if (opts.range) {
      const end = Math.min(opts.range.end ?? st.size - 1, st.size - 1);
      range = { start: opts.range.start, end };
      stream = createReadStream(p, { start: opts.range.start, end });
    } else {
      stream = createReadStream(p);
    }
    return {
      body: Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>,
      size: st.size,
      range,
      contentType: mimeFromPath(path),
      modified: st.mtimeMs,
      etag: `${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}`,
    };
  }

  async write(path: string, body: WriteBody): Promise<void> {
    const p = this.fsPath(path);
    await fs.mkdir(nodePath.dirname(p), { recursive: true });
    const b = bodyToBytesOrStream(body);
    if (b instanceof Uint8Array) {
      await fs.writeFile(p, b);
      return;
    }
    await pipeline(Readable.fromWeb(b as any), createWriteStream(p));
  }

  async delete(path: string): Promise<void> {
    if (normalizePath(path) === '/') throw new Error('Refusing to delete storage root');
    await fs.rm(this.fsPath(path), { recursive: true, force: true });
  }

  async mkdir(path: string): Promise<void> {
    await fs.mkdir(this.fsPath(path), { recursive: true });
  }

  async rename(from: string, to: string): Promise<void> {
    const dst = this.fsPath(to);
    await fs.mkdir(nodePath.dirname(dst), { recursive: true });
    await fs.rename(this.fsPath(from), dst);
  }

  async copy(from: string, to: string): Promise<void> {
    const dst = this.fsPath(to);
    await fs.mkdir(nodePath.dirname(dst), { recursive: true });
    await fs.cp(this.fsPath(from), dst, { recursive: true });
  }

  async test(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    await fs.access(this.root);
  }
}

export const localDefinition: DriverDefinition = {
  type: 'local',
  label: '本機檔案系統（僅 Docker / Node）',
  runtimes: ['node'],
  fields: [{ key: 'root', label: 'Root directory', type: 'text', required: true, default: '/data/files' }],
  create: (config) => new LocalDriver(config as { root: string }),
};
