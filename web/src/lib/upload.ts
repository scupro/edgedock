/**
 * Smart upload manager:
 *  1. presigned direct PUT to S3 (fastest; needs bucket CORS) → falls back to 2 on failure
 *  2. streaming PUT through the Worker
 *  3. multipart, chunked & resumable (session stored in D1; re-selecting the same
 *     file after a refresh resumes from the uploaded parts)
 */
import { reactive } from 'vue';
import { api, apiUrl, authHeaders } from './api';
import { joinPath } from './format';

export type UploadStatus = 'queued' | 'uploading' | 'done' | 'error' | 'canceled';

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
  resumed?: boolean;
  file: File;
  abort?: () => void;
}

export interface PendingUpload {
  sessionId: string;
  name: string;
  path: string;
  size: number;
  updatedAt: number;
}

const PENDING_KEY = 'edgedock.pendingUploads';

export const uploads = reactive({
  tasks: [] as UploadTask[],
  concurrency: 2,
});

let listeners: ((t: UploadTask) => void)[] = [];
export function onUploadDone(fn: (t: UploadTask) => void): () => void {
  listeners.push(fn);
  return () => (listeners = listeners.filter((l) => l !== fn));
}

export function pendingUploads(): PendingUpload[] {
  try {
    return JSON.parse(localStorage.getItem(PENDING_KEY) || '[]');
  } catch {
    return [];
  }
}
function savePending(list: PendingUpload[]) {
  localStorage.setItem(PENDING_KEY, JSON.stringify(list.slice(-50)));
}
function addPending(p: PendingUpload) {
  savePending([...pendingUploads().filter((x) => x.sessionId !== p.sessionId), p]);
}
export function removePending(sessionId: string) {
  savePending(pendingUploads().filter((x) => x.sessionId !== sessionId));
}

export function enqueue(files: FileList | File[], dir: string): void {
  for (const file of Array.from(files)) {
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    uploads.tasks.unshift({
      id: crypto.randomUUID(),
      name: file.name,
      path: joinPath(dir, rel),
      size: file.size,
      loaded: 0,
      status: 'queued',
      file,
    });
  }
  pump();
}

export function cancel(task: UploadTask) {
  task.abort?.();
  task.status = 'canceled';
}

export function retry(task: UploadTask) {
  task.status = 'queued';
  task.error = undefined;
  task.loaded = 0;
  pump();
}

export function clearFinished() {
  uploads.tasks = uploads.tasks.filter((t) => t.status === 'queued' || t.status === 'uploading');
}

function pump() {
  const active = uploads.tasks.filter((t) => t.status === 'uploading').length;
  const next = uploads.tasks.filter((t) => t.status === 'queued').reverse();
  for (const t of next.slice(0, Math.max(0, uploads.concurrency - active))) void run(t);
}

async function run(task: UploadTask) {
  task.status = 'uploading';
  task.startedAt = Date.now();
  try {
    const plan = await api<any>('/api/upload/plan', { body: { path: task.path, size: task.size, contentType: task.file.type || undefined } });
    if (plan.strategy === 'multipart') await multipart(task, !!plan.direct);
    else if (plan.strategy === 'presigned') {
      task.strategy = 'presigned';
      try {
        await xhrPut(plan.url, task.file, plan.headers ?? {}, (n) => progress(task, n), task);
        await api('/api/upload/finalize', { body: { path: task.path } });
      } catch (e) {
        if ((task.status as UploadStatus) === 'canceled') throw e;
        // most likely bucket CORS is not configured → go through the Worker
        task.strategy = 'proxy (fallback)';
        await proxy(task);
      }
    } else {
      task.strategy = 'proxy';
      await proxy(task);
    }
    task.loaded = task.size;
    task.status = 'done';
    listeners.forEach((l) => l(task));
  } catch (e) {
    if ((task.status as UploadStatus) !== 'canceled') {
      task.status = 'error';
      task.error = (e as Error).message;
    }
  } finally {
    pump();
  }
}

function progress(task: UploadTask, loaded: number) {
  task.loaded = loaded;
  const secs = (Date.now() - (task.startedAt ?? Date.now())) / 1000;
  if (secs > 0.5) task.speed = loaded / secs;
}

async function proxy(task: UploadTask) {
  await xhrPut(
    apiUrl(`/api/upload/proxy?path=${encodeURIComponent(task.path)}`),
    task.file,
    { ...authHeaders(), 'content-type': task.file.type || 'application/octet-stream' },
    (n) => progress(task, n),
    task,
  );
}

async function multipart(task: UploadTask, direct: boolean) {
  const f = task.file;
  const fingerprint = `${task.path}|${f.size}|${f.lastModified}|${f.name}`;
  const s = await api<any>('/api/upload/multipart/init', { body: { path: task.path, size: f.size, contentType: f.type || undefined, fingerprint } });
  task.resumed = s.resumed;
  task.strategy = `multipart${direct ? ' (direct)' : ''}${s.resumed ? ' · resumed' : ''}`;
  addPending({ sessionId: s.id, name: f.name, path: task.path, size: f.size, updatedAt: Date.now() });
  const done = new Set<number>(s.uploadedParts);
  const partSize: number = s.partSize;
  const total: number = s.totalParts;
  const partLen = (n: number) => (n < total ? partSize : f.size - partSize * (total - 1));
  const inflight = new Map<number, number>();
  const report = () => {
    let sum = 0;
    for (const n of done) sum += partLen(n);
    for (const v of inflight.values()) sum += v;
    progress(task, sum);
  };
  report();
  const queue: number[] = [];
  for (let i = 1; i <= total; i++) if (!done.has(i)) queue.push(i);
  let useDirect = direct;
  let canceled = false;
  task.abort = () => (canceled = true);

  const worker = async () => {
    while (queue.length) {
      if (canceled) throw new Error('canceled');
      const n = queue.shift()!;
      const blob = f.slice((n - 1) * partSize, (n - 1) * partSize + partLen(n));
      let ok = false;
      for (let attempt = 0; attempt < 3 && !ok; attempt++) {
        try {
          if (useDirect) {
            try {
              const { urls } = await api<any>(`/api/upload/multipart/${s.id}/sign`, { body: { partNumbers: [n] } });
              const etag = await xhrPut(urls[n].url, blob, urls[n].headers ?? {}, (l) => {
                inflight.set(n, l);
                report();
              });
              await api(`/api/upload/multipart/${s.id}/parts/${n}/ack`, { body: { etag, size: blob.size } });
            } catch (e) {
              if (e instanceof XhrError && e.status === 0) {
                useDirect = false; // CORS / network: switch to proxy for the rest
                throw e;
              }
              throw e;
            }
          } else {
            await xhrPut(apiUrl(`/api/upload/multipart/${s.id}/parts/${n}`), blob, { ...authHeaders(), 'content-type': 'application/octet-stream' }, (l) => {
              inflight.set(n, l);
              report();
            });
          }
          ok = true;
        } catch (e) {
          inflight.delete(n);
          if (attempt === 2) throw e;
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        }
      }
      inflight.delete(n);
      done.add(n);
      report();
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  await api(`/api/upload/multipart/${s.id}/complete`, { method: 'POST' });
  removePending(s.id);
}

class XhrError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** PUT with upload progress; resolves with the ETag response header (if exposed). */
function xhrPut(url: string, body: Blob, headers: Record<string, string>, onProgress: (n: number) => void, task?: UploadTask): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.getResponseHeader('etag'));
      else {
        let msg = `HTTP ${xhr.status}`;
        try {
          msg = JSON.parse(xhr.responseText).error ?? msg;
        } catch {
          /* xml / text */
        }
        reject(new XhrError(xhr.status, msg));
      }
    };
    xhr.onerror = () => reject(new XhrError(0, 'Network / CORS error'));
    xhr.onabort = () => reject(new XhrError(-1, 'canceled'));
    if (task) task.abort = () => xhr.abort();
    xhr.send(body);
  });
}
