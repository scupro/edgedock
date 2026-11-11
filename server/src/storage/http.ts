/**
 * Shared HTTP helpers for the API-based drivers (OneDrive, Google Drive, Telegram, Discord,
 * HuggingFace, GitHub): rate-limit aware retry with exponential backoff + jitter.
 */

export class ProviderError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: string,
  ) {
    super(message);
  }
}

export interface RetryOptions {
  /** attempts in total (default 5) */
  attempts?: number;
  /** base backoff ms (default 500) */
  baseMs?: number;
  /** cap for a single wait (default 30 s; Retry-After above this fails fast) */
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Seconds to wait from Retry-After / X-RateLimit-* / Discord's JSON retry_after; null when unknown. */
export async function retryAfterMs(res: Response): Promise<number | null> {
  const ra = res.headers.get('retry-after');
  if (ra) {
    const n = Number(ra);
    if (Number.isFinite(n)) return n * 1000;
    const d = Date.parse(ra);
    if (!Number.isNaN(d)) return Math.max(0, d - Date.now());
  }
  const reset = res.headers.get('x-ratelimit-reset-after'); // Discord (seconds, float)
  if (reset && Number.isFinite(Number(reset))) return Number(reset) * 1000;
  if (res.headers.get('x-ratelimit-remaining') === '0') {
    const r = Number(res.headers.get('x-ratelimit-reset')); // GitHub: epoch seconds
    if (Number.isFinite(r) && r > 1e9) return Math.max(0, r * 1000 - Date.now());
  }
  try {
    const j = (await res.clone().json()) as { retry_after?: number; parameters?: { retry_after?: number } };
    const v = j?.retry_after ?? j?.parameters?.retry_after; // Discord / Telegram
    if (typeof v === 'number') return v * 1000;
  } catch {
    /* not json */
  }
  return null;
}

function isRetriable(res: Response): boolean {
  if (res.status === 429 || res.status === 408 || res.status >= 500) return true;
  // GitHub secondary rate limit / primary exhausted
  if (res.status === 403 && (res.headers.get('x-ratelimit-remaining') === '0' || !!res.headers.get('retry-after'))) return true;
  return false;
}

/**
 * fetch with retry on 429 / 5xx / network errors. Only safe for replayable bodies: the `init`
 * factory is called again on each attempt (so streams / FormData can be rebuilt).
 */
export async function fetchRetry(fetchFn: typeof fetch, url: string, init: RequestInit | (() => RequestInit), opts: RetryOptions = {}): Promise<Response> {
  const attempts = opts.attempts ?? 5;
  const base = opts.baseMs ?? 500;
  const maxWait = opts.maxWaitMs ?? 30_000;
  const sleep = opts.sleep ?? defaultSleep;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    const req = typeof init === 'function' ? init() : init;
    let res: Response;
    try {
      res = await fetchFn(url, req);
    } catch (e) {
      lastErr = e;
      if (i + 1 >= attempts) throw e;
      await sleep(Math.round(Math.min(maxWait, base * 2 ** i) * (0.5 + Math.random() * 0.5)));
      continue;
    }
    if (!isRetriable(res) || i + 1 >= attempts) return res;
    const ra = await retryAfterMs(res);
    if (ra !== null && ra > maxWait) return res; // long ban: surface it instead of hanging the request
    await res.body?.cancel().catch(() => {});
    await sleep(ra !== null ? ra + 50 : Math.round(Math.min(maxWait, base * 2 ** i) * (0.5 + Math.random() * 0.5)));
  }
  throw lastErr ?? new Error('retries exhausted');
}

/** Throw a ProviderError (status preserved → classified retriable/non-retriable upstream) for non-2xx. */
export async function ensureOk(res: Response, what: string, ok: number[] = []): Promise<Response> {
  if (res.ok || ok.includes(res.status)) return res;
  const text = await res.text().catch(() => '');
  let msg = text.slice(0, 300);
  try {
    const j = JSON.parse(text);
    msg = j?.error?.message ?? j?.error_description ?? j?.description ?? j?.message ?? (typeof j?.error === 'string' ? j.error : msg);
  } catch {
    /* text */
  }
  throw new ProviderError(res.status, `${what}: HTTP ${res.status} ${msg}`, text);
}

/** Read a body fully (bounded by `max` bytes). */
export async function readUpTo(body: ReadableStream<Uint8Array> | Uint8Array | ArrayBuffer | string, max = Infinity): Promise<Uint8Array> {
  if (typeof body === 'string') return new TextEncoder().encode(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (body instanceof Uint8Array) return body;
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new ProviderError(413, `Body larger than ${max} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

/**
 * Re-chunk a stream into pieces of exactly `size` bytes (last one shorter) without buffering more than one piece.
 */
export async function* chunksOf(body: ReadableStream<Uint8Array> | Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  if (body instanceof Uint8Array) {
    for (let o = 0; o < body.byteLength; o += size) yield body.subarray(o, Math.min(body.byteLength, o + size));
    if (body.byteLength === 0) yield body;
    return;
  }
  const reader = body.getReader();
  let buf = new Uint8Array(size);
  let fill = 0;
  let any = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    let o = 0;
    while (o < value.byteLength) {
      const n = Math.min(size - fill, value.byteLength - o);
      buf.set(value.subarray(o, o + n), fill);
      fill += n;
      o += n;
      if (fill === size) {
        any = true;
        yield buf;
        buf = new Uint8Array(size);
        fill = 0;
      }
    }
  }
  if (fill > 0 || !any) yield buf.subarray(0, fill);
}

/** Slice a byte stream to [start, end] (inclusive) when the server ignored a Range request. */
export function sliceStream(stream: ReadableStream<Uint8Array>, start: number, end: number): ReadableStream<Uint8Array> {
  let pos = 0;
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctrl) {
        const a = Math.max(start, pos);
        const b = Math.min(end + 1, pos + chunk.byteLength);
        if (b > a) ctrl.enqueue(chunk.subarray(a - pos, b - pos));
        pos += chunk.byteLength;
        if (pos > end) ctrl.terminate();
      },
    }),
  );
}

export function b64url(bytes: Uint8Array | string): string {
  const b = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64(bytes: Uint8Array): string {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode(...bytes.subarray(i, i + CH));
  return btoa(s);
}
