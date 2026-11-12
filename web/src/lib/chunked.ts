/**
 * Framework-free, transport-injectable upload engine (used by the Vue upload manager and by
 * the server test-suite, which drives it against the real Hono app with fault injection).
 *
 *  - chunked / multipart upload for every storage (native S3 multipart, or emulated server-side)
 *  - per-part retry: exponential backoff + jitter (default 5 attempts), per-part timeout,
 *    honours Retry-After and the server's retriable flag
 *  - adaptive concurrency (default 3): halves on errors, grows back after successes
 *  - pause / resume / cancel; waits for `online` instead of burning retries while offline
 *  - resume: the server session (D1) is found again by fingerprint and verified against the
 *    provider (ListParts / temp parts) so already-uploaded parts are skipped
 *  - integrity: MD5 per part (Content-MD5; checked by S3 natively, by the Worker for emulated parts,
 *    against the part ETag for direct uploads); final size/ETag verified on complete
 *  - direct presigned uploads fall back to the Worker proxy when the bucket has no CORS
 *  - direct part URLs are signed in batches (HuggingFace: one LFS batch call returns every part URL),
 *    cached, and re-signed when the provider says they expired (403 / "expired")
 */
import { Md5, toBase64, toHex } from './md5';

export interface PutResult {
  status: number;
  etag: string | null;
  text: string;
  retryAfter?: number | null;
}

export interface PutOptions {
  onProgress: (loaded: number) => void;
  signal: AbortSignal;
  timeoutMs: number;
}

export interface Transport {
  api<T = any>(path: string, opts?: { method?: string; body?: unknown }): Promise<T>;
  /** PUT a blob. Must resolve with status 0 on network/CORS failure, throw/resolve -1 on abort, -2 on timeout. */
  put(url: string, body: Blob, headers: Record<string, string>, opts: PutOptions): Promise<PutResult>;
  apiUrl(path: string): string;
  authHeaders(): Record<string, string>;
  sleep?(ms: number, signal?: AbortSignal): Promise<void>;
  isOnline?(): boolean;
  waitOnline?(signal: AbortSignal): Promise<void>;
  random?(): number;
}

export type UploadErrorKind = 'network' | 'timeout' | 'http' | 'canceled' | 'checksum' | 'cors';

export class UploadError extends Error {
  constructor(
    message: string,
    public kind: UploadErrorKind,
    public status = 0,
    public retriable = false,
    public retryAfter?: number | null,
  ) {
    super(message);
  }
}

export class CanceledError extends UploadError {
  constructor() {
    super('canceled', 'canceled', -1, false);
  }
}

/** Pause/resume/cancel handle shared between the UI and the engine. */
export class UploadControl {
  paused = false;
  canceled = false;
  private ac = new AbortController();
  private waiters: (() => void)[] = [];

  /** signal for the current in-flight requests; replaced on every pause */
  get signal(): AbortSignal {
    return this.ac.signal;
  }
  pause() {
    if (this.paused || this.canceled) return;
    this.paused = true;
    this.ac.abort();
  }
  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.ac = new AbortController();
    this.waiters.splice(0).forEach((w) => w());
  }
  cancel() {
    this.canceled = true;
    this.ac.abort();
    this.waiters.splice(0).forEach((w) => w());
  }
  async waitResumed(): Promise<void> {
    while (this.paused && !this.canceled) await new Promise<void>((r) => this.waiters.push(r));
    if (this.canceled) throw new CanceledError();
  }
}

export interface RetryInfo {
  part?: number;
  attempt: number;
  delayMs: number;
  error: UploadError;
}

export interface EngineOptions {
  transport: Transport;
  control?: UploadControl;
  concurrency?: number;
  retries?: number;
  timeoutMs?: number;
  /** compute + send MD5 per part (default true) */
  checksum?: boolean;
  onProgress?: (loaded: number, total: number) => void;
  onRetry?: (info: RetryInfo) => void;
  onStatus?: (s: 'uploading' | 'paused' | 'offline' | 'retrying' | 'completing') => void;
  onSession?: (s: SessionInfo) => void;
  onPartDone?: (part: number, s: SessionInfo) => void;
  /** direct presigned PUT failed like a CORS error → caller remembers it for this storage */
  onDirectFailed?: () => void;
  /** max backoff (ms), default 30 s */
  maxBackoffMs?: number;
  baseBackoffMs?: number;
}

export interface SessionInfo {
  id: string;
  path: string;
  size: number;
  partSize: number;
  totalParts: number;
  mode: 'native' | 'emulated';
  uploadedParts: number[];
  resumed: boolean;
  /** provider needs parts in order (OneDrive / Google Drive upload sessions) */
  sequential?: boolean;
  /** how many part URLs to request per sign call */
  signBatch?: number;
}

interface SignedPart {
  url: string;
  headers?: Record<string, string>;
  okStatus?: number[];
}

interface SignResponse {
  urls: Record<number, SignedPart>;
  /** parts the provider already holds */
  uploaded?: number[];
  /** the provider restarted the upload: recorded parts were dropped server-side */
  reset?: boolean;
}

/** A direct PUT failed because its presigned URL is no longer valid. */
function isExpired(r: PutResult): boolean {
  return r.status === 403 || ((r.status === 400 || r.status === 401) && /expired|ExpiredToken|AccessDenied/i.test(r.text));
}

/** base64 of a Blob's first bytes (HuggingFace preupload sample). */
export async function sampleOf(file: Blob, n = 512): Promise<string> {
  return toBase64(new Uint8Array(await file.slice(0, n).arrayBuffer()));
}

const RETRIABLE_STATUS = new Set([0, -2, 408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);

function sleepDefault(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

/** Turn a PUT/API result into an UploadError (or null when ok). */
export function classify(r: PutResult): UploadError | null {
  if (r.status >= 200 && r.status < 300) return null;
  if (r.status === -1) return new CanceledError();
  if (r.status === -2) return new UploadError('逾時（timeout）', 'timeout', -2, true);
  if (r.status === 0) return new UploadError('網路中斷或 CORS 錯誤（network / CORS error）', 'network', 0, true);
  let msg = `HTTP ${r.status}`;
  let retriable = RETRIABLE_STATUS.has(r.status);
  try {
    const j = JSON.parse(r.text);
    if (j?.error) msg = j.error;
    if (j?.retriable === true) retriable = true;
    if (j?.retriable === false) retriable = false;
  } catch {
    const m = /<Message>([^<]+)<\/Message>/.exec(r.text);
    if (m) msg = m[1];
    if (/BadDigest|InvalidDigest/.test(r.text)) retriable = true;
  }
  return new UploadError(msg, r.status === 422 ? 'checksum' : 'http', r.status, retriable, r.retryAfter);
}

/** Fingerprint = name + size + lastModified + SHA-256 of the first and last 64 KiB. */
export async function fingerprintFile(file: Blob & { name?: string; lastModified?: number }): Promise<string> {
  const W = 64 * 1024;
  const head = new Uint8Array(await file.slice(0, W).arrayBuffer());
  const tail = file.size > W ? new Uint8Array(await file.slice(Math.max(W, file.size - W)).arrayBuffer()) : new Uint8Array(0);
  const buf = new Uint8Array(head.length + tail.length);
  buf.set(head);
  buf.set(tail, head.length);
  const h = toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', buf)));
  return `v2|${file.name ?? ''}|${file.size}|${file.lastModified ?? 0}|${h.slice(0, 32)}`;
}

export async function md5OfBlob(b: Blob): Promise<{ hex: string; b64: string }> {
  const h = new Md5();
  // hash in slices to keep memory flat
  const STEP = 4 * 1024 * 1024;
  for (let o = 0; o < b.size; o += STEP) h.update(new Uint8Array(await b.slice(o, Math.min(b.size, o + STEP)).arrayBuffer()));
  const d = h.digest();
  return { hex: toHex(d), b64: toBase64(d) };
}

/**
 * Upload `file` to virtual `path` with a resumable multipart session.
 * Returns the server's completion payload.
 */
export async function uploadMultipart(
  file: Blob & { name?: string; lastModified?: number; type?: string },
  path: string,
  opts: EngineOptions & { fingerprint?: string; direct?: boolean; sha256?: string },
): Promise<{ ok: boolean; path: string; size: number; checksum?: string | null; session: SessionInfo }> {
  const T = opts.transport;
  const ctl = opts.control ?? new UploadControl();
  const sleep = T.sleep ?? sleepDefault;
  const rnd = T.random ?? Math.random;
  const maxConc = Math.max(1, opts.concurrency ?? 3);
  const retries = Math.max(1, opts.retries ?? 5);
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const wantSum = opts.checksum !== false;
  const baseBackoff = opts.baseBackoffMs ?? 500;
  const maxBackoff = opts.maxBackoffMs ?? 30_000;
  const fingerprint = opts.fingerprint ?? (await fingerprintFile(file));

  const backoff = (attempt: number, e: UploadError) => {
    if (e.retryAfter && e.retryAfter > 0) return Math.min(maxBackoff, e.retryAfter * 1000);
    const exp = Math.min(maxBackoff, baseBackoff * 2 ** attempt);
    return Math.round(exp * (0.5 + rnd() * 0.5)); // "equal jitter"
  };

  /** call JSON API with the same retry policy */
  const apiRetry = async <R>(fn: () => Promise<R>): Promise<R> => {
    for (let attempt = 0; ; attempt++) {
      await ctl.waitResumed();
      try {
        return await fn();
      } catch (err) {
        const st = (err as { status?: number }).status ?? 0;
        const retriable = RETRIABLE_STATUS.has(st) || (err as { retriable?: boolean }).retriable === true;
        if (!retriable || attempt + 1 >= retries) throw err;
        const ue = new UploadError((err as Error).message, st ? 'http' : 'network', st, true);
        if (T.isOnline && !T.isOnline()) {
          opts.onStatus?.('offline');
          await T.waitOnline?.(ctl.signal);
          attempt--;
          continue;
        }
        const d = backoff(attempt, ue);
        opts.onRetry?.({ attempt: attempt + 1, delayMs: d, error: ue });
        await sleep(d);
      }
    }
  };

  const lfs = opts.sha256 ? { sha256: opts.sha256, sample: await sampleOf(file) } : {};
  const s = await apiRetry(() =>
    T.api<SessionInfo & { limits?: { concurrency?: number } }>('/api/upload/multipart/init', {
      body: { path, size: file.size, contentType: file.type || undefined, fingerprint, ...lfs },
    }),
  );
  opts.onSession?.(s);
  const done = new Set<number>(s.uploadedParts);
  const signBatch = Math.max(1, s.signBatch ?? 1);
  const signed = new Map<number, SignedPart>();
  let signing: Promise<void> | null = null;
  /** set when a presigned URL expired: the next sign call asks the server for fresh URLs */
  let refreshUrls = false;
  /** fetch (batched) direct URLs until part n has one, or the server says it is already uploaded */
  const signFor = async (n: number): Promise<SignedPart | 'done'> => {
    for (let i = 0; i < 3; i++) {
      if (done.has(n)) return 'done';
      const hit = signed.get(n);
      if (hit) return hit;
      if (!signing) {
        const want = [n];
        for (let k = n + 1; k <= s.totalParts && want.length < signBatch; k++) if (!done.has(k) && !signed.has(k)) want.push(k);
        signing = (async () => {
          const refresh = refreshUrls;
          refreshUrls = false;
          const r = await T.api<SignResponse>(`/api/upload/multipart/${s.id}/sign`, { body: refresh ? { partNumbers: want, refresh } : { partNumbers: want } });
          if (r.reset) {
            // parts recorded so far belong to an upload the provider dropped; the completion check re-sends them
            done.clear();
            signed.clear();
          }
          for (const u of r.uploaded ?? []) done.add(u);
          for (const [k, v] of Object.entries(r.urls ?? {})) signed.set(Number(k), v);
          if (r.uploaded?.length) report();
        })().finally(() => {
          signing = null;
        });
      }
      await signing;
    }
    if (done.has(n)) return 'done';
    const hit = signed.get(n);
    if (hit) return hit;
    throw Object.assign(new Error(`No upload URL for part ${n}`), { status: 502 });
  };
  const partLen = (n: number) => (n < s.totalParts ? s.partSize : file.size - s.partSize * (s.totalParts - 1));
  const inflight = new Map<number, number>();
  const report = () => {
    let sum = 0;
    for (const n of done) sum += partLen(n);
    for (const v of inflight.values()) sum += v;
    opts.onProgress?.(Math.min(sum, file.size), file.size);
  };
  report();

  let useDirect = !!opts.direct;
  let directWorked = false;
  let limit = s.sequential ? 1 : maxConc;
  const ceiling = s.sequential ? 1 : maxConc;
  let active = 0;
  let streak = 0;
  const slotWaiters: (() => void)[] = [];
  const acquire = async () => {
    while (active >= limit) await new Promise<void>((r) => slotWaiters.push(r));
    active++;
  };
  const release = () => {
    active--;
    slotWaiters.splice(0).forEach((w) => w());
  };

  const putPart = async (n: number, blob: Blob, sum: { hex: string; b64: string } | null): Promise<UploadError | null> => {
    const onProgress = (l: number) => {
      inflight.set(n, l);
      report();
    };
    if (useDirect) {
      let target: SignedPart | 'done';
      try {
        target = await signFor(n);
      } catch (e) {
        const st = (e as { status?: number }).status ?? 0;
        return new UploadError((e as Error).message, 'http', st, RETRIABLE_STATUS.has(st));
      }
      if (target === 'done') return null;
      const r = await T.put(target.url, blob, target.headers ?? {}, { onProgress, signal: ctl.signal, timeoutMs });
      const accepted = target.okStatus?.includes(r.status) ?? false;
      const err = accepted ? null : classify(r);
      if (err) {
        // never reuse a URL that failed: the next attempt signs again (fresh URL / provider state re-checked)
        signed.delete(n);
        if (err.status === 0 && !directWorked && (!T.isOnline || T.isOnline())) {
          // first direct PUT failed at the network level while online → bucket CORS. Proxy from now on.
          if (useDirect) opts.onDirectFailed?.();
          useDirect = false;
          return new UploadError('Bucket CORS blocked direct upload; switching to Worker proxy', 'cors', 0, true);
        }
        if (isExpired(r)) {
          // presigned URLs expired (e.g. long pause / resume next day): drop them all and re-sign
          signed.clear();
          refreshUrls = true;
          return new UploadError(`Part ${n}: upload URL expired, re-signing`, 'http', r.status, true);
        }
        return err;
      }
      directWorked = true;
      const etag = r.etag?.replace(/"/g, '').toLowerCase() ?? null;
      if (sum && etag && /^[0-9a-f]{32}$/.test(etag) && etag !== sum.hex) {
        signed.delete(n);
        return new UploadError(`Part ${n} checksum mismatch`, 'checksum', 422, true);
      }
      // session-style providers (OneDrive / Google Drive) answer the final chunk with the created item
      let etagOrItem = r.etag;
      if (!etagOrItem && n === s.totalParts && (r.status === 200 || r.status === 201)) {
        try {
          const id = (JSON.parse(r.text) as { id?: string })?.id;
          if (id) etagOrItem = `item:${id}`;
        } catch {
          /* not JSON */
        }
      }
      try {
        await T.api(`/api/upload/multipart/${s.id}/parts/${n}/ack`, { body: { etag: etagOrItem, size: blob.size, md5: sum?.hex } });
      } catch (e) {
        const st = (e as { status?: number }).status ?? 0;
        return new UploadError((e as Error).message, 'http', st, RETRIABLE_STATUS.has(st) || st === 422);
      }
      return null;
    }
    const headers: Record<string, string> = { ...T.authHeaders(), 'content-type': 'application/octet-stream' };
    if (sum) headers['content-md5'] = sum.b64;
    const r = await T.put(T.apiUrl(`/api/upload/multipart/${s.id}/parts/${n}`), blob, headers, { onProgress, signal: ctl.signal, timeoutMs });
    return classify(r);
  };

  const uploadOne = async (n: number) => {
    if (done.has(n)) return;
    const start = (n - 1) * s.partSize;
    const blob = file.slice(start, start + partLen(n));
    const sum = wantSum ? await md5OfBlob(blob) : null;
    for (let attempt = 0; ; ) {
      await ctl.waitResumed();
      await acquire();
      let err: UploadError | null;
      try {
        err = await putPart(n, blob, sum);
      } finally {
        release();
      }
      inflight.delete(n);
      if (!err) {
        if (++streak >= 3 && limit < ceiling) {
          limit++;
          streak = 0;
        }
        done.add(n);
        report();
        opts.onPartDone?.(n, { ...s, uploadedParts: [...done] });
        return;
      }
      report();
      if (ctl.canceled) throw new CanceledError();
      if (ctl.paused) {
        // aborted by pause: not a failure, don't count it
        opts.onStatus?.('paused');
        await ctl.waitResumed();
        opts.onStatus?.('uploading');
        continue;
      }
      if (err.kind === 'cors') continue; // switched to proxy, retry immediately without counting
      if (!err.retriable) throw err;
      if (T.isOnline && !T.isOnline()) {
        opts.onStatus?.('offline');
        await T.waitOnline?.(ctl.signal);
        opts.onStatus?.('uploading');
        continue; // network is back, not counted
      }
      streak = 0;
      limit = Math.max(1, Math.floor(limit / 2));
      attempt++;
      if (attempt >= retries) throw new UploadError(`分段 ${n} 重試 ${retries} 次仍失敗：${err.message}`, err.kind, err.status, false);
      const d = backoff(attempt - 1, err);
      opts.onRetry?.({ part: n, attempt, delayMs: d, error: err });
      opts.onStatus?.('retrying');
      await sleep(d, undefined);
      opts.onStatus?.('uploading');
    }
  };

  const runParts = async (list: number[]) => {
    const queue = [...list];
    let failure: unknown = null;
    const worker = async () => {
      while (queue.length && !failure) {
        const n = queue.shift()!;
        try {
          await uploadOne(n);
        } catch (e) {
          failure ??= e;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(ceiling, list.length) }, worker));
    if (failure) throw failure;
  };

  const missing = () => {
    const out: number[] = [];
    for (let i = 1; i <= s.totalParts; i++) if (!done.has(i)) out.push(i);
    return out;
  };

  await runParts(missing());
  opts.onStatus?.('completing');
  for (let round = 0; ; round++) {
    try {
      const res = await apiRetry(() => T.api<{ ok: boolean; path: string; size: number; checksum?: string | null }>(`/api/upload/multipart/${s.id}/complete`, { method: 'POST' }));
      return { ...res, session: { ...s, uploadedParts: [...done] } };
    } catch (e) {
      const st = (e as { status?: number }).status;
      // server found parts missing / short on the provider: re-verify and upload them again (twice max)
      if ((st === 400 || st === 409) && round < 2) {
        const cur = await apiRetry(() => T.api<SessionInfo>(`/api/upload/multipart/${s.id}?verify=1`));
        done.clear();
        cur.uploadedParts.forEach((n) => done.add(n));
        const m = missing();
        if (!m.length) throw e;
        opts.onStatus?.('uploading');
        await runParts(m);
        opts.onStatus?.('completing');
        continue;
      }
      throw e;
    }
  }
}

/** Single-request PUT (presigned or proxy) with the same retry/backoff policy. */
export async function putWithRetry(
  url: string,
  file: Blob,
  headers: Record<string, string>,
  opts: EngineOptions & { onCorsFailure?: () => boolean },
): Promise<PutResult> {
  const T = opts.transport;
  const ctl = opts.control ?? new UploadControl();
  const sleep = T.sleep ?? sleepDefault;
  const rnd = T.random ?? Math.random;
  const retries = Math.max(1, opts.retries ?? 5);
  for (let attempt = 0; ; ) {
    await ctl.waitResumed();
    const r = await T.put(url, file, headers, { onProgress: (l) => opts.onProgress?.(l, file.size), signal: ctl.signal, timeoutMs: opts.timeoutMs ?? 120_000 });
    const err = classify(r);
    if (!err) return r;
    if (ctl.canceled) throw new CanceledError();
    if (ctl.paused) {
      await ctl.waitResumed();
      continue;
    }
    if (err.status === 0 && opts.onCorsFailure && attempt === 0 && (!T.isOnline || T.isOnline()) && opts.onCorsFailure()) {
      throw new UploadError('CORS', 'cors', 0, false);
    }
    if (!err.retriable) throw err;
    if (T.isOnline && !T.isOnline()) {
      await T.waitOnline?.(ctl.signal);
      continue;
    }
    attempt++;
    if (attempt >= retries) throw err;
    const d = err.retryAfter ? err.retryAfter * 1000 : Math.round(Math.min(opts.maxBackoffMs ?? 30_000, (opts.baseBackoffMs ?? 500) * 2 ** (attempt - 1)) * (0.5 + rnd() * 0.5));
    opts.onRetry?.({ attempt, delayMs: d, error: err });
    await sleep(d);
  }
}
