/** Tiny IndexedDB key-value store for resumable upload state (falls back to memory when unavailable). */
const DB_NAME = 'edgedock';
const STORE = 'uploads';

export interface PersistedUpload {
  fingerprint: string;
  sessionId: string;
  storageId?: string;
  name: string;
  path: string;
  size: number;
  lastModified: number;
  partSize: number;
  totalParts: number;
  uploadedParts: number[];
  updatedAt: number;
  /** SHA-256 of the whole file (HuggingFace LFS), so a resume does not hash again */
  sha256?: string;
}

let dbp: Promise<IDBDatabase | null> | null = null;
const mem = new Map<string, PersistedUpload>();

function open(): Promise<IDBDatabase | null> {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'fingerprint' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbp;
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  return open().then(
    (db) =>
      new Promise((resolve) => {
        if (!db) return resolve(undefined);
        try {
          const req = fn(db.transaction(STORE, mode).objectStore(STORE));
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(undefined);
        } catch {
          resolve(undefined);
        }
      }),
  );
}

export async function putUpload(u: PersistedUpload): Promise<void> {
  mem.set(u.fingerprint, u);
  await tx('readwrite', (s) => s.put(u));
}

export async function deleteUpload(fingerprint: string): Promise<void> {
  mem.delete(fingerprint);
  await tx('readwrite', (s) => s.delete(fingerprint));
}

export async function listUploads(): Promise<PersistedUpload[]> {
  const all = (await tx<PersistedUpload[]>('readonly', (s) => s.getAll() as IDBRequest<PersistedUpload[]>)) ?? [...mem.values()];
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}
