/**
 * SHA-256 of a whole file for HuggingFace LFS (the oid), computed in a Web Worker so the page stays
 * responsive; falls back to the main thread when workers are unavailable. Streams in 8 MiB slices.
 */
import { sha256OfBlob } from './sha256core';

export async function sha256File(file: Blob, opts: { onProgress?: (done: number, total: number) => void; signal?: AbortSignal } = {}): Promise<string> {
  if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  let worker: Worker | null = null;
  try {
    worker = new Worker(new URL('./sha256.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    worker = null;
  }
  if (!worker) return sha256OfBlob(file, opts.onProgress, () => !!opts.signal?.aborted);
  const w = worker;
  return new Promise<string>((resolve, reject) => {
    const stop = () => {
      w.terminate();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    opts.signal?.addEventListener('abort', stop, { once: true });
    const finish = () => {
      opts.signal?.removeEventListener('abort', stop);
      w.terminate();
    };
    w.onmessage = (e: MessageEvent<{ type: string; done?: number; total?: number; hex?: string; message?: string }>) => {
      const m = e.data;
      if (m.type === 'progress') opts.onProgress?.(m.done!, m.total!);
      else if (m.type === 'done') {
        finish();
        resolve(m.hex!);
      } else if (m.type === 'error') {
        finish();
        reject(new Error(m.message));
      }
    };
    w.onerror = (ev) => {
      finish();
      // worker failed to load (CSP / old browser): hash on the main thread instead
      ev.preventDefault?.();
      sha256OfBlob(file, opts.onProgress, () => !!opts.signal?.aborted).then(resolve, reject);
    };
    w.postMessage({ file });
  });
}
