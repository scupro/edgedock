/**
 * Upload manager (Vue-reactive) on top of the framework-free engine in ./chunked.ts.
 *
 *  1. presigned direct PUT to S3 (fastest; needs bucket CORS) → on a CORS-style failure falls back
 *     to 2 and remembers it for that storage (localStorage), so later uploads skip the failing try
 *  2. single streaming PUT through the Worker (small files only: always below the Worker body limit)
 *  3. chunked multipart for anything larger: resumable (D1 session + IndexedDB), per-part retry with
 *     backoff, adaptive concurrency, pause/resume, auto-pause while offline
 */
import { reactive } from 'vue';
import { api, apiUrl, authHeaders } from './api';
import { CanceledError, fingerprintFile, putWithRetry, UploadControl, UploadError, uploadMultipart, type PutResult, type Transport } from './chunked';
import { joinPath } from './format';
import { t } from './i18n';
import { deleteUpload, listUploads, putUpload, type PersistedUpload } from './idb';

export type UploadStatus = 'queued' | 'uploading' | 'paused' | 'offline' | 'retrying' | 'done' | 'error' | 'canceled';

export interface UploadTask {
  id: string;
  name: string;
  path: string;
  size: number;
  loaded: number;
  status: UploadStatus;
  strategy?: string;
  error?: string;
  startedAt?: number;
  speed?: number;
  eta?: number;
  retries: number;
  resumed?: boolean;
  file: File;
  fingerprint?: string;
}

/** controls live outside the reactive store (AbortController etc. must not be proxied) */
const controls = new Map<string, UploadControl>();
const ctlOf = (t: UploadTask) => controls.get(t.id);

export const uploads = reactive({
  tasks: [] as UploadTask[],
  /** files uploaded at the same time */
  concurrency: 2,
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
});

let listeners: ((t: UploadTask) => void)[] = [];
export function onUploadDone(fn: (t: UploadTask) => void): () => void {
  listeners.push(fn);
  return () => (listeners = listeners.filter((l) => l !== fn));
}

// ------------------------------------------------------------------ CORS memory per storage
const CORS_KEY = 'edgedock.directBroken';
function corsBroken(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(CORS_KEY) || '{}');
  } catch {
    return {};
  }
}
/** Remember for 7 days that direct-to-bucket uploads fail for this storage. */
export function markDirectBroken(storageId: string) {
  const m = corsBroken();
  m[storageId] = Date.now();
  localStorage.setItem(CORS_KEY, JSON.stringify(m));
}
export function clearDirectBroken(storageId?: string) {
  if (!storageId) return localStorage.removeItem(CORS_KEY);
  const m = corsBroken();
  delete m[storageId];
  localStorage.setItem(CORS_KEY, JSON.stringify(m));
}
function isDirectBroken(storageId?: string): boolean {
  if (!storageId) return false;
  const t = corsBroken()[storageId];
  return !!t && Date.now() - t < 7 * 86400_000;
}
// the plan needs the storage id before we know it; cache path-prefix → storage id
const storageByPrefix = new Map<string, string>();
function guessStorage(path: string): string | undefined {
  let best: string | undefined;
  let len = -1;
  for (const [p, id] of storageByPrefix) if ((path === p || path.startsWith(p.endsWith('/') ? p : p + '/')) && p.length > len) [best, len] = [id, p.length];
  return best;
}

// ------------------------------------------------------------------ online / offline
const onlineWaiters: (() => void)[] = [];
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    uploads.online = true;
    onlineWaiters.splice(0).forEach((w) => w());
  });
  window.addEventListener('offline', () => {
    uploads.online = false;
  });
}

// ------------------------------------------------------------------ XHR transport
function xhrPut(url: string, body: Blob, headers: Record<string, string>, o: { onProgress: (n: number) => void; signal: AbortSignal; timeoutMs: number }): Promise<PutResult> {
  return new Promise((resolve) => {
    if (o.signal.aborted) return resolve({ status: -1, etag: null, text: '' });
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.timeout = o.timeoutMs;
    // a stalled connection (no progress for the whole timeout) is treated as a timeout, too
    let last = Date.now();
    let timedOut = false;
    const stall = setInterval(() => {
      if (Date.now() - last > o.timeoutMs) {
        timedOut = true;
        xhr.abort();
      }
    }, 5000);
    xhr.upload.onprogress = (e) => {
      last = Date.now();
      o.onProgress(e.loaded);
    };
    const done = (r: PutResult) => {
      clearInterval(stall);
      o.signal.removeEventListener('abort', onAbort);
      resolve(r);
    };
    xhr.onload = () =>
      done({ status: xhr.status, etag: xhr.getResponseHeader('etag'), text: xhr.responseText, retryAfter: Number(xhr.getResponseHeader('retry-after')) || null });
    xhr.onerror = () => done({ status: 0, etag: null, text: '' });
    xhr.ontimeout = () => done({ status: -2, etag: null, text: '' });
    xhr.onabort = () => done({ status: timedOut ? -2 : -1, etag: null, text: '' });
    const onAbort = () => xhr.abort();
    o.signal.addEventListener('abort', onAbort);
    xhr.send(body);
  });
}

const transport: Transport = {
  api: (path, opts) => api(path, opts as any),
  put: xhrPut,
  apiUrl,
  authHeaders,
  isOnline: () => navigator.onLine,
  waitOnline: (signal) =>
    new Promise<void>((resolve) => {
      if (navigator.onLine) return resolve();
      onlineWaiters.push(resolve);
      signal.addEventListener('abort', () => resolve());
    }),
};

// ------------------------------------------------------------------ queue
export function enqueue(files: FileList | File[], dir: string): void {
  for (const file of Array.from(files)) {
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    addTask(file, joinPath(dir, rel));
  }
  pump();
}

function addTask(file: File, path: string): UploadTask {
  const t: UploadTask = reactive({ id: crypto.randomUUID(), name: file.name, path, size: file.size, loaded: 0, status: 'queued', retries: 0, file }) as UploadTask;
  uploads.tasks.unshift(t);
  return t;
}

export function cancel(task: UploadTask) {
  ctlOf(task)?.cancel();
  task.status = 'canceled';
  pump();
}

export function pause(task: UploadTask) {
  if (task.status !== 'uploading' && task.status !== 'retrying') return;
  ctlOf(task)?.pause();
  task.status = 'paused';
}

export function resume(task: UploadTask) {
  if (task.status !== 'paused') return;
  task.status = 'uploading';
  task.startedAt = Date.now();
  ctlOf(task)?.resume();
}

export function retry(task: UploadTask) {
  task.status = 'queued';
  task.error = undefined;
  task.retries = 0;
  pump();
}

export function clearFinished() {
  uploads.tasks = uploads.tasks.filter((t) => !['done', 'error', 'canceled'].includes(t.status));
}

function pump() {
  const busy = uploads.tasks.filter((t) => ['uploading', 'paused', 'offline', 'retrying'].includes(t.status)).length;
  const next = uploads.tasks.filter((t) => t.status === 'queued').reverse();
  for (const t of next.slice(0, Math.max(0, uploads.concurrency - busy))) void run(t);
}

/** progress with a smoothed speed (EMA) and ETA */
function progress(task: UploadTask, loaded: number) {
  const now = Date.now();
  const prev = (task as UploadTask & { _p?: { t: number; l: number } })._p;
  if (prev && now - prev.t >= 500) {
    const inst = Math.max(0, loaded - prev.l) / ((now - prev.t) / 1000);
    task.speed = task.speed ? task.speed * 0.7 + inst * 0.3 : inst;
    (task as any)._p = { t: now, l: loaded };
  } else if (!prev) (task as any)._p = { t: now, l: loaded };
  task.loaded = loaded;
  task.eta = task.speed && task.speed > 0 ? Math.round((task.size - loaded) / task.speed) : undefined;
}

/** Turn engine / API errors into a localized (default 正體中文) message. */
export function describeError(e: unknown): string {
  const st = (e as { status?: number }).status;
  if (e instanceof UploadError) {
    if (e.kind === 'timeout') return t('upload.err.timeout');
    if (e.kind === 'network') return t('upload.err.network');
    if (e.kind === 'checksum') return t('upload.err.checksum');
  }
  if (st === 413) return t('upload.err.tooLarge');
  if (st === 410) return t('upload.err.expired');
  if (st === 403) return t('upload.err.forbidden');
  if (st === 405) return t('upload.err.readonly');
  return (e as Error)?.message ?? String(e);
}

async function run(task: UploadTask) {
  const ctl = new UploadControl();
  controls.set(task.id, ctl);
  task.status = 'uploading';
  task.startedAt = Date.now();
  task.speed = undefined;
  const common = {
    transport,
    control: ctl,
    onProgress: (l: number) => progress(task, l),
    onRetry: () => {
      task.retries++;
    },
    onStatus: (s: string) => {
      if (ctl.paused || task.status === 'canceled') return;
      if (s === 'offline') task.status = 'offline';
      else if (s === 'retrying') task.status = 'retrying';
      else if (s === 'uploading' || s === 'completing') task.status = 'uploading';
    },
  };
  try {
    const guess = guessStorage(task.path);
    const plan = await api<any>('/api/upload/plan', { body: { path: task.path, size: task.size, contentType: task.file.type || undefined, noDirect: isDirectBroken(guess) } });
    const lim = plan.limits ?? {};
    if (plan.storageId) {
      const mount = task.path.split('/').slice(0, 2).join('/') || '/';
      storageByPrefix.set(mount, plan.storageId);
    }
    const directBroken = isDirectBroken(plan.storageId);
    const engineOpts = { ...common, concurrency: lim.concurrency, retries: lim.retries, timeoutMs: lim.chunkTimeoutMs };

    if (plan.strategy === 'multipart') {
      const fingerprint = await fingerprintFile(task.file);
      task.fingerprint = fingerprint;
      const res = await uploadMultipart(task.file, task.path, {
        ...engineOpts,
        fingerprint,
        direct: !!plan.direct && !directBroken,
        onDirectFailed: () => {
          markDirectBroken(plan.storageId);
          task.strategy = '分段 · 改走 Worker 代理（CORS）';
        },
        onSession: (s) => {
          task.resumed = s.resumed;
          task.strategy = `分段 ${s.totalParts} 段${plan.direct && !directBroken ? ' · 直傳' : ''}${s.resumed ? ` · 續傳（已完成 ${s.uploadedParts.length} 段）` : ''}`;
          void persist(task, s.id, s.partSize, s.totalParts, s.uploadedParts, plan.storageId);
        },
        onPartDone: (_n, s) => void persist(task, s.id, s.partSize, s.totalParts, s.uploadedParts, plan.storageId),
      });
      void res;
      await deleteUpload(fingerprint);
    } else if (plan.strategy === 'presigned' && !directBroken) {
      task.strategy = '直傳';
      try {
        await putWithRetry(plan.url, task.file, plan.headers ?? {}, { ...engineOpts, onCorsFailure: () => true });
        await api('/api/upload/finalize', { body: { path: task.path } });
      } catch (e) {
        if (e instanceof CanceledError || ctl.canceled) throw e;
        if (!(e instanceof UploadError) || e.kind !== 'cors') throw e;
        // bucket CORS not configured → go through the Worker, and remember
        markDirectBroken(plan.storageId);
        task.strategy = 'Worker 代理（CORS 備援）';
        await proxy(task, engineOpts);
      }
    } else {
      task.strategy = 'Worker 代理';
      await proxy(task, engineOpts);
    }
    task.loaded = task.size;
    task.status = 'done';
    task.eta = 0;
    listeners.forEach((l) => l(task));
  } catch (e) {
    if (!ctl.canceled && (task.status as UploadStatus) !== 'canceled') {
      task.status = 'error';
      task.error = describeError(e);
    }
  } finally {
    controls.delete(task.id);
    pump();
  }
}

async function proxy(task: UploadTask, o: Parameters<typeof putWithRetry>[3]) {
  await putWithRetry(apiUrl(`/api/upload/proxy?path=${encodeURIComponent(task.path)}`), task.file, { ...authHeaders(), 'content-type': task.file.type || 'application/octet-stream' }, o);
}

// ------------------------------------------------------------------ persisted (resumable after refresh)
const persistTimer: Record<string, number> = {};
async function persist(task: UploadTask, sessionId: string, partSize: number, totalParts: number, uploadedParts: number[], storageId?: string) {
  if (!task.fingerprint) return;
  const now = Date.now();
  if (persistTimer[task.fingerprint] && now - persistTimer[task.fingerprint] < 1000 && uploadedParts.length < totalParts) return;
  persistTimer[task.fingerprint] = now;
  await putUpload({
    fingerprint: task.fingerprint,
    sessionId,
    storageId,
    name: task.file.name,
    path: task.path,
    size: task.size,
    lastModified: task.file.lastModified,
    partSize,
    totalParts,
    uploadedParts,
    updatedAt: now,
  });
}

/** Unfinished uploads from earlier visits (not currently running). */
export async function pendingUploads(): Promise<PersistedUpload[]> {
  const running = new Set(uploads.tasks.filter((t) => !['done', 'error', 'canceled'].includes(t.status)).map((t) => t.fingerprint));
  // migrate / drop the legacy localStorage list
  localStorage.removeItem('edgedock.pendingUploads');
  return (await listUploads()).filter((p) => !running.has(p.fingerprint));
}

export async function forgetPending(p: PersistedUpload, abortServer = true) {
  await deleteUpload(p.fingerprint);
  if (abortServer) await api(`/api/upload/multipart/${p.sessionId}`, { method: 'DELETE' }).catch(() => {});
}

/**
 * After a page refresh the File object is gone: the user re-selects the file, we check it is the
 * same one (fingerprint incl. partial content hash) and continue where the server session left off.
 */
export async function resumePending(p: PersistedUpload, file: File): Promise<boolean> {
  const fp = await fingerprintFile(file);
  if (fp !== p.fingerprint) return false;
  const t = addTask(file, p.path);
  t.fingerprint = fp;
  pump();
  return true;
}

// ------------------------------------------------------------------ bucket CORS probe (admin)
/** Real browser test: PUT a tiny object with a presigned URL. Returns null when ok, else an error string. */
export async function probeBucketCors(storageId: string): Promise<{ ok: boolean; etagExposed: boolean; error?: string }> {
  const p = await api<{ key: string; url: string; headers: Record<string, string> }>(`/api/storages/${storageId}/cors/probe`, { method: 'POST' });
  try {
    const res = await fetch(p.url, { method: 'PUT', body: 'edgedock cors probe', headers: p.headers });
    if (!res.ok) return { ok: false, etagExposed: false, error: `HTTP ${res.status}` };
    const etagExposed = !!res.headers.get('etag');
    clearDirectBroken(storageId);
    return { ok: true, etagExposed };
  } catch (e) {
    return { ok: false, etagExposed: false, error: (e as Error).message || 'CORS / network error' };
  } finally {
    await api(`/api/storages/${storageId}/cors/probe/cleanup`, { body: { key: p.key } }).catch(() => {});
  }
}
