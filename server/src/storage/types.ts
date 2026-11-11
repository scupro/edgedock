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
  /** extra non-2xx statuses that mean "accepted" (Google Drive resumable: 308 Resume Incomplete) */
  okStatus?: number[];
}

export interface UploadedPart {
  partNumber: number;
  etag: string;
  /** bytes, when the provider reports it (ListParts) */
  size?: number;
}

export interface PendingUpstreamUpload {
  key: string;
  uploadId: string;
  /** epoch ms */
  initiated?: number;
}

export interface MultipartCreateOptions {
  contentType?: string;
  size?: number;
  partSize?: number;
  /** SHA-256 (hex) of the whole file, computed by the browser (HuggingFace LFS oid) */
  sha256?: string;
  /** base64 of the first 512 bytes (HuggingFace preupload sample) */
  sample?: string;
  /** browser origin the session will be used from (Google Drive resumable sessions + CORS) */
  origin?: string;
}

/** Richer create() result for providers that dictate the part layout (HuggingFace LFS multipart). */
export interface MultipartCreated {
  uploadId: string;
  /** provider-chosen part size (overrides EdgeDock's choice) */
  partSize?: number;
  totalParts?: number;
  /** parts the provider already holds (e.g. the LFS object already exists) */
  uploadedParts?: UploadedPart[];
  /** stored with the session (e.g. "sha256:<oid>"); used to refuse resuming a different file */
  checksum?: string;
}

export interface PresignedParts {
  urls: Record<number, PresignedRequest>;
  /** updated upload id (fresh completion URL etc.); persisted by the upload service */
  uploadId?: string;
  /** the provider started a new upload: every recorded part must be uploaded again */
  restarted?: boolean;
  /** the provider already has the whole object: all parts count as uploaded */
  alreadyComplete?: boolean;
}

export interface MultipartSupport {
  /** size / partSize are known when the session is created (needed by OneDrive / Google Drive sessions) */
  create(path: string, opts: MultipartCreateOptions): Promise<string | MultipartCreated>;
  presignPart?(path: string, uploadId: string, partNumber: number, expiresIn: number): Promise<PresignedRequest>;
  /** sign many parts with one provider call (HuggingFace: one LFS batch request returns every part URL) */
  presignParts?(path: string, uploadId: string, partNumbers: number[], expiresIn: number): Promise<PresignedParts>;
  /** `md5` (base64) is forwarded as Content-MD5 where the provider verifies it. */
  uploadPart(path: string, uploadId: string, partNumber: number, body: WriteBody, size: number, opts?: { md5?: string }): Promise<{ etag: string }>;
  /** may return the final checksum to record (e.g. "sha256:<oid>") */
  complete(path: string, uploadId: string, parts: UploadedPart[]): Promise<void | { checksum?: string }>;
  abort(path: string, uploadId: string): Promise<void>;
  listParts?(path: string, uploadId: string): Promise<UploadedPart[]>;
  /** In-progress uploads under the driver root (orphan cleanup). Keys are storage-relative paths. */
  listUploads?(): Promise<PendingUpstreamUpload[]>;
}

export interface DriverCapabilities {
  presign: boolean;
  multipart: boolean;
  rangeRead: boolean;
  readOnly?: boolean;
  /** largest part the provider accepts in one request (bytes) */
  maxPartSize?: number;
  /** smallest non-final part (bytes); default 5 MiB (S3 rule) for native multipart, 1 MiB emulated */
  minPartSize?: number;
  /** parts must be a multiple of this (OneDrive 320 KiB, Google Drive 256 KiB) */
  partSizeMultiple?: number;
  /** parts must arrive strictly in order (upload sessions): the browser uploads one at a time */
  sequentialParts?: boolean;
  /** largest file that can be written at all through EdgeDock */
  maxUploadSize?: number;
  /** the browser can PUT parts straight to the provider (multipart.presignPart/presignParts) without `presign` */
  directParts?: boolean;
  /** multipart.create needs the SHA-256 of the whole file (HuggingFace LFS) */
  needsSha256?: boolean;
  /** single-request writes (driver.write: proxy PUT, WebDAV, copy) are buffered up to this many bytes */
  maxWriteSize?: number;
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
  /** 正體中文 label for the admin UI */
  labelZh?: string;
  type: 'text' | 'password' | 'boolean' | 'number' | 'select' | 'textarea';
  /** stored encrypted (AES-GCM) */
  secret?: boolean;
  required?: boolean;
  default?: string | number | boolean;
  placeholder?: string;
  help?: string;
  helpZh?: string;
  options?: { value: string; label: string }[];
}

export interface DriverContext {
  fetch: typeof fetch;
  /** storage row id (absent when testing an unsaved config) */
  storageId?: string;
  /** D1 + encryption, for drivers that keep metadata / tokens in the database */
  env?: import('../lib/types').Env;
}

export interface DriverDefinition {
  type: string;
  label: string;
  /** runtimes that can host this driver */
  runtimes: ('workers' | 'node')[];
  fields: DriverField[];
  /** every write answers 405 */
  readOnly?: boolean;
  /** OAuth helper flow supported by the admin UI (/api/oauth/<provider>/start) */
  oauth?: 'onedrive' | 'gdrive';
  /** one-line description / limits shown in the admin UI */
  notes?: string;
  notesZh?: string;
  create(config: Record<string, unknown>, ctx: DriverContext): StorageDriver;
}
