/// <reference lib="webworker" />
import { sha256OfBlob } from './sha256core';

self.onmessage = async (e: MessageEvent<{ file: Blob }>) => {
  try {
    let last = 0;
    const hex = await sha256OfBlob(e.data.file, (done, total) => {
      const now = Date.now();
      if (now - last > 200 || done === total) {
        last = now;
        (self as unknown as Worker).postMessage({ type: 'progress', done, total });
      }
    });
    (self as unknown as Worker).postMessage({ type: 'done', hex });
  } catch (err) {
    (self as unknown as Worker).postMessage({ type: 'error', message: (err as Error).message || String(err) });
  }
};
