import { AwsV4Signer } from 'aws4fetch';
import { XMLParser } from 'fast-xml-parser';
import { basename, joinPath, normalizePath } from '../lib/path';
import { mimeFromPath } from '../lib/mime';
import { BaseDriver, fetchBody, isHidden, rangeHeader } from './base';
import type {
  ByteRange,
  DriverContext,
  DriverDefinition,
  FileEntry,
  MultipartSupport,
  PresignedRequest,
  ReadResult,
  UploadedPart,
  WriteBody,
  WriteOptions,
} from './types';

export interface S3Config {
  endpoint: string;
  region?: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** key prefix inside the bucket */
  root?: string;
  /** path-style addressing (MinIO, some B2/R2 setups) */
  pathStyle?: boolean;
  /** seconds, default 3600 */
  presignExpires?: number;
  /** redirect downloads to presigned GET urls instead of proxying through the worker */
  directDownload?: boolean;
}

const xml = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  parseTagValue: false,
  isArray: (name) => ['Contents', 'CommonPrefixes', 'Part', 'Upload'].includes(name),
});

/** RFC 3986 encode a single path segment. */
export function encodeSegment(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

export function encodeKey(key: string): string {
  return key.split('/').map(encodeSegment).join('/');
}

export class S3Error extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export class S3Driver extends BaseDriver {
  readonly type = 's3';
  readonly capabilities = { presign: true, multipart: true, rangeRead: true };
  private cfg: Required<Pick<S3Config, 'region' | 'root' | 'presignExpires'>> & S3Config;
  private fetchFn: typeof fetch;
  readonly multipart: MultipartSupport;

  constructor(config: S3Config, ctx: DriverContext = { fetch: (...a) => fetch(...a) }) {
    super();
    if (!config.endpoint) throw new Error('S3 endpoint is required');
    if (!config.bucket) throw new Error('S3 bucket is required');
    this.cfg = {
      ...config,
      endpoint: config.endpoint.replace(/\/+$/, ''),
      region: config.region || 'auto',
      root: normalizePath(config.root || '/'),
      presignExpires: Number(config.presignExpires) || 3600,
    };
    if (!/^https?:\/\//.test(this.cfg.endpoint)) this.cfg.endpoint = 'https://' + this.cfg.endpoint;
    this.fetchFn = ctx.fetch;
    this.multipart = {
      create: (p, o) => this.mpCreate(p, o.contentType),
      presignPart: (p, id, n, exp) => this.mpPresignPart(p, id, n, exp),
      uploadPart: (p, id, n, body, size) => this.mpUploadPart(p, id, n, body, size),
      complete: (p, id, parts) => this.mpComplete(p, id, parts),
      abort: (p, id) => this.mpAbort(p, id),
      listParts: (p, id) => this.mpListParts(p, id),
    };
  }

  // ------------------------------------------------------------ addressing
  /** storage-relative path -> object key (no leading slash) */
  key(path: string): string {
    return joinPath(this.cfg.root, path).slice(1);
  }

  /** object key -> storage-relative path */
  private rel(key: string): string {
    const full = normalizePath('/' + key);
    if (this.cfg.root === '/') return full;
    return normalizePath(full.slice(this.cfg.root.length));
  }

  bucketUrl(): string {
    const u = new URL(this.cfg.endpoint);
    if (this.cfg.pathStyle) return `${u.protocol}//${u.host}${u.pathname.replace(/\/$/, '')}/${encodeSegment(this.cfg.bucket)}`;
    return `${u.protocol}//${this.cfg.bucket}.${u.host}${u.pathname.replace(/\/$/, '')}`;
  }

  objectUrl(key: string): string {
    return `${this.bucketUrl()}/${encodeKey(key)}`;
  }

  private signer(url: string, method: string, headers: Record<string, string> = {}, signQuery = false) {
    return new AwsV4Signer({
      url,
      method,
      headers,
      accessKeyId: this.cfg.accessKeyId,
      secretAccessKey: this.cfg.secretAccessKey,
      service: 's3',
      region: this.cfg.region,
      signQuery,
    });
  }

  private async request(
    method: string,
    url: string,
    opts: { headers?: Record<string, string>; body?: WriteBody; size?: number; okStatuses?: number[] } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    let body: BodyInit | undefined;
    let extraInit: Record<string, unknown> = {};
    if (opts.body !== undefined) {
      const fb = fetchBody(opts.body, opts.size);
      body = fb.body;
      extraInit = fb.init;
      Object.assign(headers, fb.headers);
    }
    // We never hash the payload (it may be a stream).
    headers['x-amz-content-sha256'] = 'UNSIGNED-PAYLOAD';
    const signed = await this.signer(url, method, headers).sign();
    const res = await this.fetchFn(signed.url.toString(), { method, headers: signed.headers, body, ...extraInit } as RequestInit);
    const ok = opts.okStatuses ?? [];
    if (!res.ok && !ok.includes(res.status)) {
      const text = await res.text().catch(() => '');
      let code = 'S3Error';
      let msg = text.slice(0, 300);
      try {
        const e = xml.parse(text)?.Error;
        if (e) {
          code = e.Code ?? code;
          msg = e.Message ?? msg;
        }
      } catch {
        /* ignore */
      }
      throw new S3Error(res.status, code, `S3 ${method} ${res.status} ${code}: ${msg}`);
    }
    return res;
  }

  // ------------------------------------------------------------ listing
  async listKeys(prefix: string, delimiter?: string, maxKeys?: number): Promise<{ files: any[]; prefixes: string[] }> {
    const files: any[] = [];
    const prefixes: string[] = [];
    let token: string | undefined;
    do {
      const u = new URL(this.bucketUrl() + '/');
      u.searchParams.set('list-type', '2');
      u.searchParams.set('prefix', prefix);
      if (delimiter) u.searchParams.set('delimiter', delimiter);
      if (maxKeys) u.searchParams.set('max-keys', String(maxKeys));
      if (token) u.searchParams.set('continuation-token', token);
      const res = await this.request('GET', u.toString());
      const doc = xml.parse(await res.text())?.ListBucketResult ?? {};
      for (const c of doc.Contents ?? []) files.push(c);
      for (const p of doc.CommonPrefixes ?? []) prefixes.push(p.Prefix);
      token = doc.IsTruncated === 'true' && !maxKeys ? doc.NextContinuationToken : undefined;
    } while (token);
    return { files, prefixes };
  }

  async list(path: string): Promise<FileEntry[]> {
    const dirKey = this.key(path);
    const prefix = dirKey ? dirKey + '/' : '';
    const { files, prefixes } = await this.listKeys(prefix, '/');
    const out: FileEntry[] = [];
    for (const p of prefixes) {
      const name = p.slice(prefix.length).replace(/\/$/, '');
      if (!name || isHidden(name)) continue;
      out.push({ name, path: this.rel(p), isDir: true, size: 0 });
    }
    for (const f of files) {
      const key: string = f.Key;
      if (key === prefix) continue; // directory marker
      const name = key.slice(prefix.length);
      if (!name || name.includes('/')) continue;
      out.push({
        name,
        path: this.rel(key),
        isDir: false,
        size: Number(f.Size ?? 0),
        modified: f.LastModified ? Date.parse(f.LastModified) : undefined,
        etag: f.ETag?.replace(/"/g, ''),
        contentType: mimeFromPath(name),
      });
    }
    return out;
  }

  async stat(path: string): Promise<FileEntry | null> {
    const p = normalizePath(path);
    if (p === '/') return { name: '', path: '/', isDir: true, size: 0 };
    const key = this.key(p);
    const res = await this.request('HEAD', this.objectUrl(key), { okStatuses: [404, 403] });
    if (res.ok) {
      return {
        name: basename(p),
        path: p,
        isDir: false,
        size: Number(res.headers.get('content-length') ?? 0),
        modified: res.headers.get('last-modified') ? Date.parse(res.headers.get('last-modified')!) : undefined,
        etag: res.headers.get('etag')?.replace(/"/g, ''),
        contentType: res.headers.get('content-type') ?? mimeFromPath(p),
      };
    }
    const { files, prefixes } = await this.listKeys(key + '/', '/', 1);
    if (files.length || prefixes.length) return { name: basename(p), path: p, isDir: true, size: 0 };
    return null;
  }

  async read(path: string, opts: { range?: ByteRange } = {}): Promise<ReadResult> {
    const headers: Record<string, string> = {};
    if (opts.range) headers['range'] = rangeHeader(opts.range);
    const res = await this.request('GET', this.objectUrl(this.key(path)), { headers });
    let size = Number(res.headers.get('content-length') ?? 0);
    let range: ReadResult['range'];
    const cr = res.headers.get('content-range');
    if (res.status === 206 && cr) {
      const m = /bytes (\d+)-(\d+)\/(\d+|\*)/.exec(cr);
      if (m) {
        range = { start: Number(m[1]), end: Number(m[2]) };
        if (m[3] !== '*') size = Number(m[3]);
      }
    }
    return {
      body: res.body,
      size,
      range,
      contentType: res.headers.get('content-type') ?? mimeFromPath(path),
      etag: res.headers.get('etag')?.replace(/"/g, ''),
      modified: res.headers.get('last-modified') ? Date.parse(res.headers.get('last-modified')!) : undefined,
    };
  }

  async write(path: string, body: WriteBody, opts: WriteOptions = {}): Promise<void> {
    await this.request('PUT', this.objectUrl(this.key(path)), {
      body,
      size: opts.size,
      headers: { 'content-type': opts.contentType || mimeFromPath(path) },
    });
  }

  async mkdir(path: string): Promise<void> {
    const key = this.key(path);
    if (!key) return;
    await this.request('PUT', this.objectUrl(key + '/'), { body: new Uint8Array(0), size: 0 });
  }

  async delete(path: string): Promise<void> {
    const key = this.key(path);
    // the object itself (if a file)
    await this.request('DELETE', this.objectUrl(key), { okStatuses: [404] });
    // everything under it (if a directory)
    const prefix = key ? key + '/' : '';
    if (!prefix) return; // refuse to wipe the whole root implicitly
    const { files } = await this.listKeys(prefix);
    const keys = files.map((f) => f.Key as string);
    keys.push(prefix);
    await pool(keys, 8, (k) => this.request('DELETE', this.objectUrl(k), { okStatuses: [404] }).then(() => undefined));
  }

  private async copyObject(fromKey: string, toKey: string): Promise<void> {
    const source = '/' + encodeSegment(this.cfg.bucket) + '/' + encodeKey(fromKey);
    await this.request('PUT', this.objectUrl(toKey), { headers: { 'x-amz-copy-source': source }, body: new Uint8Array(0), size: 0 });
  }

  async copy(from: string, to: string): Promise<void> {
    const st = await this.stat(from);
    if (!st) throw new S3Error(404, 'NoSuchKey', `Not found: ${from}`);
    if (!st.isDir) return this.copyObject(this.key(from), this.key(to));
    const fromPrefix = this.key(from) + '/';
    const toPrefix = this.key(to) + '/';
    const { files } = await this.listKeys(fromPrefix);
    await this.mkdir(to);
    await pool(files, 6, (f) => this.copyObject(f.Key, toPrefix + String(f.Key).slice(fromPrefix.length)));
  }

  async rename(from: string, to: string): Promise<void> {
    await this.copy(from, to);
    await this.delete(from);
  }

  // ------------------------------------------------------------ presign
  async presignPut(path: string, opts: { contentType?: string; expiresIn?: number } = {}): Promise<PresignedRequest> {
    const expiresIn = opts.expiresIn ?? this.cfg.presignExpires;
    const u = new URL(this.objectUrl(this.key(path)));
    u.searchParams.set('X-Amz-Expires', String(expiresIn));
    const signed = await this.signer(u.toString(), 'PUT', {}, true).sign();
    return { url: signed.url.toString(), method: 'PUT', headers: opts.contentType ? { 'content-type': opts.contentType } : {}, expiresIn };
  }

  async presignGet(path: string, opts: { expiresIn?: number; filename?: string } = {}): Promise<PresignedRequest> {
    const expiresIn = opts.expiresIn ?? this.cfg.presignExpires;
    const u = new URL(this.objectUrl(this.key(path)));
    u.searchParams.set('X-Amz-Expires', String(expiresIn));
    if (opts.filename) u.searchParams.set('response-content-disposition', `inline; filename*=UTF-8''${encodeSegment(opts.filename)}`);
    const signed = await this.signer(u.toString(), 'GET', {}, true).sign();
    return { url: signed.url.toString(), method: 'GET', headers: {}, expiresIn };
  }

  get directDownload(): boolean {
    return !!this.cfg.directDownload;
  }

  // ------------------------------------------------------------ multipart
  private async mpCreate(path: string, contentType?: string): Promise<string> {
    const res = await this.request('POST', this.objectUrl(this.key(path)) + '?uploads', {
      headers: { 'content-type': contentType || mimeFromPath(path) },
    });
    const doc = xml.parse(await res.text());
    const id = doc?.InitiateMultipartUploadResult?.UploadId;
    if (!id) throw new S3Error(500, 'NoUploadId', 'CreateMultipartUpload returned no UploadId');
    return String(id);
  }

  private partUrl(path: string, uploadId: string, partNumber: number): URL {
    const u = new URL(this.objectUrl(this.key(path)));
    u.searchParams.set('partNumber', String(partNumber));
    u.searchParams.set('uploadId', uploadId);
    return u;
  }

  private async mpPresignPart(path: string, uploadId: string, partNumber: number, expiresIn: number): Promise<PresignedRequest> {
    const u = this.partUrl(path, uploadId, partNumber);
    u.searchParams.set('X-Amz-Expires', String(expiresIn));
    const signed = await this.signer(u.toString(), 'PUT', {}, true).sign();
    return { url: signed.url.toString(), method: 'PUT', headers: {}, expiresIn };
  }

  private async mpUploadPart(path: string, uploadId: string, partNumber: number, body: WriteBody, size: number): Promise<{ etag: string }> {
    const res = await this.request('PUT', this.partUrl(path, uploadId, partNumber).toString(), { body, size });
    const etag = res.headers.get('etag');
    if (!etag) throw new S3Error(500, 'NoETag', 'UploadPart returned no ETag');
    return { etag };
  }

  private async mpComplete(path: string, uploadId: string, parts: UploadedPart[]): Promise<void> {
    const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    const body =
      '<CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
      sorted.map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${escapeXml(quoteEtag(p.etag))}</ETag></Part>`).join('') +
      '</CompleteMultipartUpload>';
    const u = new URL(this.objectUrl(this.key(path)));
    u.searchParams.set('uploadId', uploadId);
    const res = await this.request('POST', u.toString(), { body, headers: { 'content-type': 'application/xml' } });
    // S3 may return 200 with an <Error> body
    const text = await res.text();
    if (text.includes('<Error>')) {
      const e = xml.parse(text)?.Error ?? {};
      throw new S3Error(500, e.Code ?? 'CompleteFailed', e.Message ?? 'CompleteMultipartUpload failed');
    }
  }

  private async mpListParts(path: string, uploadId: string): Promise<UploadedPart[]> {
    const out: UploadedPart[] = [];
    let marker: string | undefined;
    do {
      const u = new URL(this.objectUrl(this.key(path)));
      u.searchParams.set('uploadId', uploadId);
      if (marker) u.searchParams.set('part-number-marker', marker);
      const res = await this.request('GET', u.toString());
      const parsed = xml.parse(await res.text());
      // AWS: ListPartsResult (moto answers ListPartsResponse)
      const doc = parsed?.ListPartsResult ?? parsed?.ListPartsResponse ?? {};
      for (const p of doc.Part ?? []) out.push({ partNumber: Number(p.PartNumber), etag: String(p.ETag) });
      marker = doc.IsTruncated === 'true' ? String(doc.NextPartNumberMarker) : undefined;
    } while (marker);
    return out;
  }

  private async mpAbort(path: string, uploadId: string): Promise<void> {
    const u = new URL(this.objectUrl(this.key(path)));
    u.searchParams.set('uploadId', uploadId);
    await this.request('DELETE', u.toString(), { okStatuses: [404] });
  }

  async test(): Promise<void> {
    await this.listKeys(this.key('/') ? this.key('/') + '/' : '', '/', 1);
  }
}

function quoteEtag(e: string): string {
  return e.startsWith('"') ? e : `"${e}"`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<unknown>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]);
    }
  });
  await Promise.all(workers);
}

export const s3Definition: DriverDefinition = {
  type: 's3',
  label: 'S3 相容儲存（R2 / B2 / AWS S3 / OSS / COS / MinIO）',
  runtimes: ['workers', 'node'],
  fields: [
    {
      key: 'provider',
      label: 'Provider preset',
      type: 'select',
      default: 'r2',
      options: [
        { value: 'r2', label: 'Cloudflare R2' },
        { value: 'b2', label: 'Backblaze B2' },
        { value: 'aws', label: 'AWS S3' },
        { value: 'oss', label: 'Aliyun OSS' },
        { value: 'cos', label: 'Tencent COS' },
        { value: 'minio', label: 'MinIO' },
        { value: 'other', label: 'Other S3-compatible' },
      ],
    },
    { key: 'endpoint', label: 'Endpoint', type: 'text', required: true, placeholder: 'https://<account_id>.r2.cloudflarestorage.com' },
    { key: 'region', label: 'Region', type: 'text', default: 'auto', placeholder: 'auto / us-east-1 / oss-cn-hangzhou' },
    { key: 'bucket', label: 'Bucket', type: 'text', required: true },
    { key: 'root', label: 'Root prefix', type: 'text', default: '/', help: 'Only expose objects under this prefix' },
    { key: 'pathStyle', label: 'Path-style addressing', type: 'boolean', default: false, help: 'Enable for MinIO / R2 / custom endpoints' },
    { key: 'accessKeyId', label: 'Access Key ID', type: 'text', required: true, secret: true },
    { key: 'secretAccessKey', label: 'Secret Access Key', type: 'password', required: true, secret: true },
    { key: 'presignExpires', label: 'Presign expiry (s)', type: 'number', default: 3600 },
    { key: 'directDownload', label: 'Direct download via presigned URL', type: 'boolean', default: false },
  ],
  create: (config, ctx) => new S3Driver(config as unknown as S3Config, ctx),
};
