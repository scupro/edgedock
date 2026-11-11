/**
 * Upload reliability: the browser engine (web/src/lib/chunked.ts) driven against the real Hono app
 * with fault injection on both sides:
 *  - client side (mock transport): network drops, truncated bodies (stream break mid-part), 5xx,
 *    hung requests (per-part timeout), corrupted bytes (MD5 mismatch)
 *  - server side (flaky storage driver): upstream write fails mid-stream (retriable 503)
 * and proves retry + resume produce byte-identical files, for emulated multipart (local + WebDAV)
 * and native multipart on S3 (moto).
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CanceledError, UploadControl, uploadMultipart, type PutResult, type Transport } from '../../web/src/lib/chunked';
import { LocalDriver, localDefinition } from '../src/storage/local';
import { registerDriver } from '../src/storage/registry';
import { BaseDriver } from '../src/storage/base';
import { S3Driver } from '../src/storage/s3';
import { WebDAVDriver } from '../src/storage/webdav';
import { UploadService } from '../src/lib/uploads';
import { Vfs } from '../src/storage/mounts';
import type { ByteRange, DriverCapabilities, FileEntry, ReadResult, WriteBody, WriteOptions } from '../src/storage/types';
import { makeApp, makeEnv, setupWithLocal, tmpDir } from './helpers';
import { s3, startS3, stopS3 } from './moto';

const MiB = 1024 * 1024;

function data(size: number, seed = 1): Uint8Array {
  const d = new Uint8Array(size);
  let x = seed;
  for (let i = 0; i < size; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    d[i] = x >>> 16;
  }
  return d;
}
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

type Fault = 'drop' | 'truncate' | '502' | '503-retry-after' | 'hang' | 'corrupt' | 'cors';

/** Transport backed by app.request (relative URLs) or real fetch (absolute: S3 presigned), with injected faults. */
function makeTransport(t: { req: (p: string, init?: any) => Response | Promise<Response>; token: string }, faults: Map<number, Fault>, log: { puts: string[]; sleeps: number[] }) {
  let partPuts = 0;
  const transport: Transport = {
    apiUrl: (p) => p,
    authHeaders: () => ({ authorization: `Bearer ${t.token}` }),
    sleep: async (ms) => {
      log.sleeps.push(ms);
    },
    random: () => 0.5,
    async api(p, opts = {}) {
      const headers: Record<string, string> = { authorization: `Bearer ${t.token}` };
      let body: string | undefined;
      if (opts.body !== undefined) {
        body = JSON.stringify(opts.body);
        headers['content-type'] = 'application/json';
      }
      const res = await t.req(p, { method: opts.method ?? (body ? 'POST' : 'GET'), headers, body });
      const text = await res.text();
      const j = text ? JSON.parse(text) : null;
      if (!res.ok) throw Object.assign(new Error(j?.error ?? `HTTP ${res.status}`), { status: res.status, retriable: j?.retriable });
      return j;
    },
    async put(url, blob, headers, o): Promise<PutResult> {
      const isPart = /\/parts\/\d+$/.test(url) || /partNumber=/.test(url);
      const k = isPart ? ++partPuts : 0;
      const fault = isPart ? faults.get(k) : undefined;
      log.puts.push(`${k}:${url.replace(/\?.*$/, '').split('/').slice(-2).join('/')}${fault ? ':' + fault : ''}`);
      let bytes = new Uint8Array(await blob.arrayBuffer());
      const sendHeaders = { ...headers };
      if (fault === 'drop' || fault === 'cors') return { status: 0, etag: null, text: '' };
      if (fault === 'hang')
        return new Promise((resolve) => {
          const timer = setTimeout(() => resolve({ status: -2, etag: null, text: '' }), o.timeoutMs);
          o.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve({ status: -1, etag: null, text: '' });
          });
        });
      if (fault === '502') return { status: 502, etag: null, text: '<html>Bad gateway</html>' };
      if (fault === '503-retry-after') return { status: 503, etag: null, text: '{"error":"busy","retriable":true}', retryAfter: 7 };
      if (fault === 'corrupt') {
        bytes = bytes.slice();
        bytes[Math.floor(bytes.length / 2)] ^= 0xff;
      }
      let result: PutResult;
      if (fault === 'truncate') {
        // the connection breaks after half the body: the server receives a short body; the client sees a network error
        const half = bytes.slice(0, Math.floor(bytes.length / 2));
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(half);
            c.close();
          },
        });
        const r = await (/^https?:/.test(url) ? fetch(url, { method: 'PUT', headers: sendHeaders, body: half }) : t.req(url, { method: 'PUT', headers: { ...sendHeaders, 'content-length': String(bytes.length) }, body: stream, duplex: 'half' }));
        await r.text();
        return { status: 0, etag: null, text: '' };
      }
      const res = /^https?:/.test(url) ? await fetch(url, { method: 'PUT', headers: sendHeaders, body: bytes }) : await t.req(url, { method: 'PUT', headers: { ...sendHeaders, 'content-length': String(bytes.length) }, body: bytes });
      o.onProgress(bytes.length);
      result = { status: res.status, etag: res.headers.get('etag'), text: await res.text(), retryAfter: Number(res.headers.get('retry-after')) || null };
      return result;
    },
  };
  return transport;
}

/** Storage driver that fails upstream writes of temp parts mid-stream N times (server-side fault injection). */
class FlakyDriver extends BaseDriver {
  readonly type = 'flaky';
  readonly capabilities: DriverCapabilities;
  static failures = 0;
  static mode: 'status' | 'network' = 'status';
  constructor(private inner: LocalDriver) {
    super();
    this.capabilities = inner.capabilities;
  }
  list(p: string): Promise<FileEntry[]> {
    return this.inner.list(p);
  }
  stat(p: string) {
    return this.inner.stat(p);
  }
  read(p: string, o?: { range?: ByteRange }): Promise<ReadResult> {
    return this.inner.read(p, o);
  }
  async write(p: string, body: WriteBody, o?: WriteOptions): Promise<void> {
    if (p.includes('.edgedock-uploads') && FlakyDriver.failures > 0) {
      FlakyDriver.failures--;
      // consume part of the stream, then die like a broken upstream connection
      if (body instanceof ReadableStream) {
        const r = body.getReader();
        await r.read();
        await r.cancel().catch(() => {});
      }
      if (FlakyDriver.mode === 'network') throw new TypeError('fetch failed: ECONNRESET');
      throw Object.assign(new Error('upstream 503 Slow Down'), { status: 503 });
    }
    return (void o, this.inner.write(p, body));
  }
  delete(p: string) {
    return this.inner.delete(p);
  }
  mkdir(p: string) {
    return this.inner.mkdir(p);
  }
}
registerDriver({ type: 'flaky', label: 'Flaky (test)', runtimes: ['node'], fields: localDefinition.fields, create: (cfg, ctx) => new FlakyDriver(localDefinition.create(cfg, ctx) as LocalDriver) });

async function setupFlaky() {
  const env = makeEnv();
  const t = makeApp(env);
  const token = (await t.json('/api/auth/setup', { method: 'POST', body: { username: 'admin', password: 'password123' } })).body.token as string;
  const root = tmpDir();
  await t.json('/api/storages', { method: 'POST', token, body: { name: 'Flaky', type: 'flaky', mountPath: '/flaky', config: { root } } });
  await t.json('/api/admin/settings', { method: 'PUT', token, body: { uploadPartSizeMB: 1 } });
  return { env, ...t, token, root };
}

function fileOf(bytes: Uint8Array, name = 'f.bin') {
  return Object.assign(new Blob([bytes as BlobPart]), { name, lastModified: 1700000000000 });
}

describe('upload engine against the Worker (emulated multipart, local storage)', () => {
  it('survives drops, truncation, 5xx, Retry-After, timeouts and corruption: byte-identical result', async () => {
    const t = await setupWithLocal();
    await t.json('/api/admin/settings', { method: 'PUT', token: t.token, body: { uploadPartSizeMB: 1 } });
    const bytes = data(6 * MiB + 12345);
    const faults = new Map<number, Fault>([
      [1, 'drop'],
      [3, 'truncate'],
      [4, '502'],
      [6, 'hang'],
      [8, 'corrupt'],
      [9, '503-retry-after'],
    ]);
    const log = { puts: [] as string[], sleeps: [] as number[] };
    const retries: number[] = [];
    const res = await uploadMultipart(fileOf(bytes), '/local/rel/a.bin', {
      transport: makeTransport(t, faults, log),
      concurrency: 2,
      timeoutMs: 50,
      onRetry: (i) => retries.push(i.attempt),
    });
    expect(res.ok).toBe(true);
    expect(res.session.totalParts).toBe(7);
    const disk = readFileSync(path.join(t.root, 'rel/a.bin'));
    expect(sha(disk)).toBe(sha(bytes));
    expect(res.checksum).toBe(createHash('md5').update(bytes).digest('hex'));
    // 6 injected failures -> 6 retries, with backoff; Retry-After (7 s) honoured
    expect(retries.length).toBe(6);
    expect(log.sleeps).toContain(7000);
    // no temp parts left behind
    expect(readdirSync(path.join(t.root, '.edgedock-uploads'))).toEqual([]);
  });

  it('fails a part after the retry budget, with a clear error', async () => {
    const t = await setupWithLocal();
    await t.json('/api/admin/settings', { method: 'PUT', token: t.token, body: { uploadPartSizeMB: 1 } });
    const faults = new Map<number, Fault>([1, 2, 3].map((n) => [n, '502' as Fault]));
    const log = { puts: [] as string[], sleeps: [] as number[] };
    await expect(uploadMultipart(fileOf(data(MiB / 2)), '/local/x.bin', { transport: makeTransport(t, faults, log), retries: 3 })).rejects.toThrow(/重試 3 次仍失敗/);
    // exponential backoff with jitter (random() = 0.5 -> 75 % of 500·2^n)
    expect(log.sleeps).toEqual([375, 750]);
  });

  it('resumes after an interruption (and a "page refresh"), skipping verified parts', async () => {
    const t = await setupWithLocal();
    await t.json('/api/admin/settings', { method: 'PUT', token: t.token, body: { uploadPartSizeMB: 1 } });
    const bytes = data(5 * MiB + 77, 7);
    const ctl = new UploadControl();
    let partsDone = 0;
    const log1 = { puts: [] as string[], sleeps: [] as number[] };
    await expect(
      uploadMultipart(fileOf(bytes), '/local/resume.bin', {
        transport: makeTransport(t, new Map(), log1),
        control: ctl,
        concurrency: 1,
        fingerprint: 'fp-resume',
        onPartDone: () => {
          if (++partsDone === 3) ctl.cancel();
        },
      }),
    ).rejects.toBeInstanceOf(CanceledError);
    // simulate a temp part lost on the storage: the server must notice and ask for it again
    const tmp = path.join(t.root, '.edgedock-uploads');
    const sess = readdirSync(tmp)[0];
    rmSync(path.join(tmp, sess, '00002'));

    const log2 = { puts: [] as string[], sleeps: [] as number[] };
    let resumed: { resumed: boolean; uploadedParts: number[] } | null = null;
    const res = await uploadMultipart(fileOf(bytes), '/local/resume.bin', {
      transport: makeTransport(t, new Map([[1, 'drop']]), log2),
      fingerprint: 'fp-resume',
      onSession: (s) => (resumed = s),
    });
    expect(resumed!.resumed).toBe(true);
    expect(resumed!.uploadedParts).toEqual([1, 3]);
    // parts 2,4,5,6 uploaded (+1 retry of the dropped one); 1 and 3 skipped
    const uploaded = log2.puts.map((p) => p.split(':')[1]).filter((x) => x.startsWith('parts/'));
    expect(new Set(uploaded)).toEqual(new Set(['parts/2', 'parts/4', 'parts/5', 'parts/6']));
    expect(sha(readFileSync(path.join(t.root, 'resume.bin')))).toBe(sha(bytes));
    expect(res.session.id).toBe(sess);
  });

  it('pause / resume does not consume retries', async () => {
    const t = await setupWithLocal();
    await t.json('/api/admin/settings', { method: 'PUT', token: t.token, body: { uploadPartSizeMB: 1 } });
    const bytes = data(3 * MiB, 3);
    const ctl = new UploadControl();
    let n = 0;
    const retries: number[] = [];
    const p = uploadMultipart(fileOf(bytes), '/local/p.bin', {
      transport: makeTransport(t, new Map(), { puts: [], sleeps: [] }),
      control: ctl,
      concurrency: 1,
      retries: 1,
      onRetry: (i) => retries.push(i.attempt),
      onPartDone: () => {
        if (++n === 1) {
          ctl.pause();
          setTimeout(() => ctl.resume(), 20);
        }
      },
    });
    const res = await p;
    expect(res.ok).toBe(true);
    expect(retries).toEqual([]);
    expect(sha(readFileSync(path.join(t.root, 'p.bin')))).toBe(sha(bytes));
  });
});

describe('server-side fault injection (storage write breaks mid-stream)', () => {
  for (const mode of ['status', 'network'] as const) {
    it(`classifies upstream ${mode} failures as retriable (503) and the client recovers`, async () => {
      const t = await setupFlaky();
      FlakyDriver.mode = mode;
      FlakyDriver.failures = 1;
      // raw API: the failing part answers 503 + X-EdgeDock-Retriable
      const init = await t.json('/api/upload/multipart/init', { method: 'POST', token: t.token, body: { path: '/flaky/raw.bin', size: 10 } });
      const r = await t.req(`/api/upload/multipart/${init.body.id}/parts/1`, { method: 'PUT', token: t.token, body: new Uint8Array(10), headers: { 'content-length': '10' } });
      expect(r.status).toBe(503);
      expect(r.headers.get('x-edgedock-retriable')).toBe('1');
      expect((await r.json()).retriable).toBe(true);

      FlakyDriver.failures = 3;
      const bytes = data(4 * MiB + 5, 9);
      const retries: number[] = [];
      const res = await uploadMultipart(fileOf(bytes), '/flaky/big.bin', { transport: makeTransport(t, new Map(), { puts: [], sleeps: [] }), onRetry: (i) => retries.push(i.attempt) });
      expect(res.ok).toBe(true);
      expect(retries.length).toBe(3);
      expect(sha(readFileSync(path.join(t.root, 'big.bin')))).toBe(sha(bytes));
    });
  }

  it('rejects a wrong Content-MD5 without keeping the part (422, retriable)', async () => {
    const t = await setupWithLocal();
    const init = await t.json('/api/upload/multipart/init', { method: 'POST', token: t.token, body: { path: '/local/m.bin', size: 4 } });
    const r = await t.req(`/api/upload/multipart/${init.body.id}/parts/1`, {
      method: 'PUT',
      token: t.token,
      body: new Uint8Array([1, 2, 3, 4]),
      headers: { 'content-length': '4', 'content-md5': createHash('md5').update('nope').digest('base64') },
    });
    expect(r.status).toBe(422);
    expect((await t.json(`/api/upload/multipart/${init.body.id}?verify=1`, { token: t.token })).body.uploadedParts).toEqual([]);
  });

  it('refuses proxy bodies over the Worker limit', async () => {
    const t = await setupWithLocal();
    await t.json('/api/admin/settings', { method: 'PUT', token: t.token, body: { proxyMaxChunkMB: 1 } });
    const r = await t.req('/api/upload/proxy?path=/local/huge.bin', { method: 'PUT', token: t.token, body: new Uint8Array(2 * MiB), headers: { 'content-length': String(2 * MiB) } });
    expect(r.status).toBe(413);
    const plan = await t.json('/api/upload/plan', { method: 'POST', token: t.token, body: { path: '/local/huge.bin', size: 2 * MiB } });
    expect(plan.body.strategy).toBe('multipart');
    expect(plan.body.limits.proxyMaxBytes).toBe(MiB);
  });
});

describe('emulated multipart on a WebDAV storage', () => {
  it('uploads through the Worker into a WebDAV backend (our own /dav) with faults', async () => {
    const t = await setupWithLocal();
    await t.json('/api/admin/settings', { method: 'PUT', token: t.token, body: { uploadPartSizeMB: 1 } });
    // WebDAV storage pointing at /dav/local of the same app (fetch shim -> app.request)
    const key = (await t.json('/api/admin/keys', { method: 'POST', token: t.token, body: { name: 'dav', permission: 'readwrite' } })).body.key;
    const shim = ((input: any, init?: any) => {
      const u = new URL(typeof input === 'string' ? input : input.url);
      return t.app.request(u.pathname + u.search, init, t.env);
    }) as typeof fetch;
    const dav = new WebDAVDriver({ url: 'http://edgedock.test/dav/local/', username: 'x', password: key }, { fetch: shim });
    // a minimal VFS with just this WebDAV mount (the app's own mount cache must stay untouched)
    const mount = { row: { id: 'dav-storage' }, mountPath: '/wd', driver: dav };
    const vfs = { mounts: [mount], mustResolve: (p: string) => ({ mount, rel: p.slice(3) || '/', vpath: p }) } as unknown as Vfs;
    const svc = new UploadService(t.env, vfs);
    const bytes = data(3 * MiB + 999, 5);
    const { session } = await svc.init({ path: '/wd/dav/w.bin', size: bytes.length, partSize: MiB, createdBy: 'admin:1', ttlHours: 1 });
    expect(session.mode).toBe('emulated');
    // part 2 is sent corrupted first (wrong md5) -> rejected, then good
    for (let n = 1; n <= session.total_parts; n++) {
      const part = bytes.slice((n - 1) * MiB, n * MiB);
      const md5 = createHash('md5').update(part).digest('base64');
      if (n === 2) {
        const bad = part.slice();
        bad[0] ^= 1;
        await expect(svc.uploadPart(session.id, n, bad, bad.length, md5)).rejects.toMatchObject({ status: 422 });
      }
      await svc.uploadPart(session.id, n, part, part.length, md5);
    }
    const done = await svc.complete(session.id);
    expect(done.checksum).toBe(createHash('md5').update(bytes).digest('hex'));
    expect(sha(readFileSync(path.join(t.root, 'dav/w.bin')))).toBe(sha(bytes));
  });
});

// ------------------------------------------------------------------ native S3 (moto)
describe('native multipart on S3 (moto)', () => {
  beforeAll(async () => {
    await startS3();
  }, 30000);
  afterAll(() => stopS3());

  async function setupS3(root: string) {
    const env = makeEnv();
    const t = makeApp(env);
    const token = (await t.json('/api/auth/setup', { method: 'POST', body: { username: 'admin', password: 'password123' } })).body.token as string;
    const st = await t.json('/api/storages', {
      method: 'POST',
      token,
      body: { name: 'S3', type: 's3', mountPath: '/s3', config: { endpoint: s3.endpoint, bucket: s3.bucket, accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey, region: 'us-east-1', pathStyle: true, root } },
    });
    await t.json('/api/admin/settings', { method: 'PUT', token, body: { uploadPartSizeMB: 5 } });
    const drv = new S3Driver({ endpoint: s3.endpoint, bucket: s3.bucket, accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey, region: 'us-east-1', pathStyle: true, root });
    return { env, ...t, token, drv, storageId: st.body.id as string };
  }
  const readBack = async (d: S3Driver, p: string) => new Uint8Array(await new Response((await d.read(p)).body).arrayBuffer());

  it('proxy path with faults: Content-MD5 forwarded, final multipart ETag verified, byte-identical', async (ctx) => {
    if (!s3.available) return ctx.skip();
    const t = await setupS3('/rel-proxy');
    const bytes = data(11 * MiB + 3, 11);
    const res = await uploadMultipart(fileOf(bytes), '/s3/n.bin', {
      transport: makeTransport(t, new Map<number, Fault>([[1, 'drop'], [2, 'corrupt'], [4, 'truncate']]), { puts: [], sleeps: [] }),
    });
    expect(res.session.mode).toBe('native');
    expect(res.checksum).toMatch(/^[0-9a-f]{32}-3$/);
    const st = await t.drv.stat('/n.bin');
    expect(st?.etag).toBe(res.checksum);
    expect(sha(await readBack(t.drv, '/n.bin'))).toBe(sha(bytes));
  }, 60000);

  it('direct presigned parts, with automatic fallback to the proxy on a CORS failure', async (ctx) => {
    if (!s3.available) return ctx.skip();
    const t = await setupS3('/rel-direct');
    const bytes = data(10 * MiB + 1, 12);
    let fellBack = 0;
    const log = { puts: [] as string[], sleeps: [] as number[] };
    const res = await uploadMultipart(fileOf(bytes), '/s3/d.bin', {
      transport: makeTransport(t, new Map<number, Fault>([[1, 'cors']]), log),
      direct: true,
      concurrency: 1,
      onDirectFailed: () => fellBack++,
    });
    expect(fellBack).toBe(1);
    expect(log.puts.slice(1).every((p) => p.includes('parts/'))).toBe(true);
    expect(sha(await readBack(t.drv, '/d.bin'))).toBe(sha(bytes));

    // and without the CORS failure it stays direct (ETag checked against MD5, acked)
    const log2 = { puts: [] as string[], sleeps: [] as number[] };
    await uploadMultipart(fileOf(bytes, 'e.bin'), '/s3/e.bin', { transport: makeTransport(t, new Map(), log2), direct: true });
    expect(log2.puts.every((p) => !p.includes('parts/'))).toBe(true);
    expect(sha(await readBack(t.drv, '/e.bin'))).toBe(sha(bytes));
  }, 60000);

  it('resume reconciles with ListParts; cron aborts orphaned provider uploads', async (ctx) => {
    if (!s3.available) return ctx.skip();
    const t = await setupS3('/rel-orphan');
    const bytes = data(10 * MiB + 9, 13);
    const ctl = new UploadControl();
    await expect(
      uploadMultipart(fileOf(bytes), '/s3/r.bin', {
        transport: makeTransport(t, new Map(), { puts: [], sleeps: [] }),
        control: ctl,
        concurrency: 1,
        fingerprint: 'fp-s3',
        onPartDone: () => ctl.cancel(),
      }),
    ).rejects.toBeInstanceOf(CanceledError);
    let resumed: number[] = [];
    await uploadMultipart(fileOf(bytes), '/s3/r.bin', { transport: makeTransport(t, new Map(), { puts: [], sleeps: [] }), fingerprint: 'fp-s3', onSession: (s) => (resumed = s.uploadedParts) });
    expect(resumed).toEqual([1]);
    expect(sha(await readBack(t.drv, '/r.bin'))).toBe(sha(bytes));

    // an upload nobody tracks
    await t.drv.multipart.create('/orphan.bin', {});
    const svc = new UploadService(t.env, await Vfs.create(t.env));
    expect(await svc.cleanupOrphans(0)).toBeGreaterThanOrEqual(1);
    expect((await t.drv.multipart.listUploads!()).filter((u) => u.key === '/orphan.bin')).toEqual([]);
  }, 60000);
});
