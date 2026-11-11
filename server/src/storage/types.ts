/**
 * Storage driver contract.
 *
 * Paths passed to a driver are *storage-relative*: normalized, absolute
 * ("/" = storage root), '/'-separated, no trailing slash. The mount layer
 * (see ./mounts.ts) translates virtual paths to storage-relative paths.
 *
 * To add a new backend (Phase 2: OneDrive, Google Drive, Telegram, ...):
 *   1. implement `StorageDriver` (extend `BaseDriver` for sane defaults),
 *   2. describe its config with `DriverDefinition.fields`,
 *   3. call `registerDriver()` (see ./registry.ts).
 * Read-only backends simply throw `notImplemented` from write methods and set
 * `capabilities.readOnly = true`.
 */

export interface FileEntry {
  name: string;
  /** storage-relative path */
  path: string;
  isDir: boolean;
  size: number;
  /** epoch ms */
  modified?: number;
  etag?: string;
  contentType?: string;
}

export interface ByteRange {
  start: number;
  /** inclusive; undefined = until end */
  end?: number;
}

export interface ReadResult {
  body: ReadableStream<Uint8Array> | null;
  /** total size of the object */
  size: number;
  contentType?: string;
  etag?: string;
  modified?: number;
  /** present when a range was served */
  range?: { start: number; end: number };
}

export type WriteBody = ReadableStream<Uint8Array> | Uint8Array | ArrayBuffer | string;

export interface WriteOptions {
  size?: number;
  contentType?: string;
}

export interface PresignedRequest {
  url: string;
  method: 'PUT' | 'GET';
  headers: Record<string, string>;
  expiresIn: number;
}

export interface UploadedPart {
  partNumber: number;
  etag: string;
}

export interface MultipartSupport {
  create(path: string, opts: { contentType?: string }): Promise<string>;
  presignPart?(path: string, uploadId: string, partNumber: number, expiresIn: number): Promise<PresignedRequest>;
  uploadPart(path: string, uploadId: string, partNumber: number, body: WriteBody, size: number): Promise<{ etag: string }>;
  complete(path: string, uploadId: string, parts: UploadedPart[]): Promise<void>;
  abort(path: string, uploadId: string): Promise<void>;
  listParts?(path: string, uploadId: string): Promise<UploadedPart[]>;
}

export interface DriverCapabilities {
  presign: boolean;
  multipart: boolean;
  rangeRead: boolean;
  readOnly?: boolean;
}

export interface StorageDriver {
  readonly type: string;
  readonly capabilities: DriverCapabilities;
  list(path: string): Promise<FileEntry[]>;
  /** null if not found */
  stat(path: string): Promise<FileEntry | null>;
  read(path: string, opts?: { range?: ByteRange }): Promise<ReadResult>;
  write(path: string, body: WriteBody, opts?: WriteOptions): Promise<void>;
  /** recursive for directories */
  delete(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  move(from: string, to: string): Promise<void>;
  copy(from: string, to: string): Promise<void>;
  presignPut?(path: string, opts: { contentType?: string; expiresIn?: number }): Promise<PresignedRequest>;
  presignGet?(path: string, opts: { expiresIn?: number; filename?: string }): Promise<PresignedRequest>;
  multipart?: MultipartSupport;
  /** quick connectivity check for the admin UI */
  test?(): Promise<void>;
}

export interface DriverField {
  key: string;
  label: string;
  type: 'text' | 'password' | 'boolean' | 'number' | 'select';
  /** stored encrypted (AES-GCM) */
  secret?: boolean;
  required?: boolean;
  default?: string | number | boolean;
  placeholder?: string;
  help?: string;
  options?: { value: string; label: string }[];
}

export interface DriverContext {
  fetch: typeof fetch;
}

export interface DriverDefinition {
  type: string;
  label: string;
  /** runtimes that can host this driver */
  runtimes: ('workers' | 'node')[];
  fields: DriverField[];
  create(config: Record<string, unknown>, ctx: DriverContext): StorageDriver;
}
