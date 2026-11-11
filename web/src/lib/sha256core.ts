/** Streaming SHA-256 of a Blob with hash-wasm (WebCrypto cannot hash incrementally). Shared by the worker and the fallback. */
import { createSHA256 } from 'hash-wasm';

export const SHA_CHUNK = 8 * 1024 * 1024;

export async function sha256OfBlob(file: Blob, onProgress?: (done: number, total: number) => void, aborted?: () => boolean): Promise<string> {
  const h = await createSHA256();
  h.init();
  for (let o = 0; o < file.size; o += SHA_CHUNK) {
    if (aborted?.()) throw new DOMException('Aborted', 'AbortError');
    const end = Math.min(file.size, o + SHA_CHUNK);
    h.update(new Uint8Array(await file.slice(o, end).arrayBuffer()));
    onProgress?.(end, file.size);
  }
  onProgress?.(file.size, file.size);
  return h.digest('hex');
}
