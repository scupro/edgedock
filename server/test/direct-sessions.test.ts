/**
 * OneDrive / Google Drive browser-direct uploads (mocked Graph / Drive APIs): the engine
 * (web/src/lib/chunked.ts) against the real Hono app. The server only creates the provider session;
 * the browser PUTs the chunks to the session URL itself (Content-Range, in order), with the Worker
 * as a fallback when the direct PUT fails like a CORS error.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UploadControl, uploadMultipart, type PutResult, type Transport } from '../../web/src/lib/chunked';
import { registerDriver } from '../src/storage/registry';
import { onedriveDefinition } from '../src/storage/onedrive';
import { gdriveDefinition } from '../src/storage/gdrive';
import { gdriveFake, oneDriveFake } from './fakes';
import { makeApp, makeEnv } from './helpers';

registerDriver(onedriveDefinition);
registerDriver(gdriveDefinition);

const MiB = 1024 * 1024;
const ORIGIN = 'https://edge.example.com';

function data(size: number, seed = 3): Uint8Array {
  const d = new Uint8Array(size);
  let x = seed;
  for (let i = 0; i < size; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    d[i] = x >>> 16;
  }
  return d;
}
const fileOf = (b: Uint8Array, name = 'big.bin') => Object.assign(new Blob([b as BlobPart]), { name, lastModified: 1700000000000 });
const same = (a: Uint8Array | undefined, b: Uint8Array) => !!a && a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

async function setup(kind: 'onedrive' | 'gdrive') {
  const f = kind === 'onedrive' ? oneDriveFake() : gdriveFake();
  vi.stubGlobal('fetch', f.fetch);
  const env = makeEnv({ PUBLIC_URL: ORIGIN });
  const t = makeApp(env);
  const token = (await t.json('/api/auth/setup', { method: 'POST', body: { username: 'admin', password: 'password123' } })).body.token as string;
  const config = kind === 'onedrive' ? { clientId: 'cid', clientSecret: 'sec', refreshToken: 'rt0' } : { clientId: 'cid', clientSecret: 's', refreshToken: 'rt' };
  const st = await t.json('/api/storages', { method: 'POST', token, body: { name: kind, type: kind, mountPath: '/d', config } });
  if (st.status !== 201) throw new Error(JSON.stringify(st.body));
  await t.json('/api/admin/settings', { method: 'PUT', token, body: { uploadPartSizeMB: 1 } });
  return { f, env, ...t, token };
}

type Fault = 'drop-after-delivery' | 'cors';

/** Browser transport. Absolute URLs hit the provider fake directly, like XHR would (no Authorization, browser Origin). */
function transport(t: Awaited<ReturnType<typeof setup>>, o: { browserOrigin?: string; faults?: Map<number, Fault>; gdrive?: boolean } = {}) {
  const log = { direct: 0, proxied: 0, ranges: [] as string[] };
  let directN = 0;
  const T: Transport = {
    apiUrl: (p) => p,
    authHeaders: () => ({ authorization: `Bearer ${t.token}` }),
    sleep: async () => {},
    random: () => 0.5,
    async api(p, opts = {}) {
      const headers: Record<string, string> = { authorization: `Bearer ${t.token}`, origin: ORIGIN };
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
    async put(url, blob, headers, op): Promise<PutResult> {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (/^https?:/.test(url)) {
        log.direct++;
        const fault = o.faults?.get(++directN);
        expect(headers.authorization).toBeUndefined(); // pre-authenticated session URL: never send a token
        log.ranges.push(headers['content-range']);
        if (fault === 'cors') return { status: 0, etag: null, text: '' };
        if (o.gdrive) {
          // Google answers CORS only for the origin the session was initiated with
          const sid = new URL(url).searchParams.get('upload_id')!;
          const sess = (t.f as ReturnType<typeof gdriveFake>).sessions.get(sid);
          if (sess && sess.origin !== (o.browserOrigin ?? ORIGIN)) return { status: 0, etag: null, text: '' };
        }
        const res = await t.f.fetch(url, { method: 'PUT', headers: { ...headers, origin: o.browserOrigin ?? ORIGIN }, body: bytes });
        const text = await res.text();
        if (fault === 'drop-after-delivery') return { status: 0, etag: null, text: '' }; // provider got it, response lost
        op.onProgress(bytes.length);
        return { status: res.status, etag: null, text }; // ETag is not CORS-exposed by these providers
      }
      log.proxied++;
      const res = await t.req(url, { method: 'PUT', headers: { ...headers, 'content-length': String(bytes.length) }, body: bytes });
      op.onProgress(bytes.length);
      return { status: res.status, etag: res.headers.get('etag'), text: await res.text() };
    },
  };
  return { T, log };
}

describe('OneDrive: browser-direct upload sessions', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('plan → multipart direct; chunks go straight to the uploadUrl in order; index finalized', async () => {
    const t = await setup('onedrive');
    const plan = await t.json('/api/upload/plan', { method: 'POST', token: t.token, body: { path: '/d/v/big.bin', size: 5 * MiB } });
    expect(plan.body).toMatchObject({ strategy: 'multipart', direct: true });
    const small = await t.json('/api/upload/plan', { method: 'POST', token: t.token, body: { path: '/d/v/s.txt', size: 1000 } });
    expect(small.body.strategy).toBe('proxy');
    const b = data(5 * MiB + 4321);
    const { T, log } = transport(t);
    const res = await uploadMultipart(fileOf(b), '/d/v/big.bin', { transport: T, direct: true });
    expect(res.ok).toBe(true);
    expect(res.session.sequential).toBe(true);
    expect(res.session.partSize % (320 * 1024)).toBe(0);
    expect(log.proxied).toBe(0);
    expect(log.direct).toBe(res.session.totalParts);
    expect(log.ranges[0]).toBe(`bytes 0-${res.session.partSize - 1}/${b.length}`);
    const f = t.f as ReturnType<typeof oneDriveFake>;
    expect(same(f.items.get('/v/big.bin')?.data, b)).toBe(true);
    const ls = await t.json('/api/fs/list?path=/d/v', { token: t.token });
    expect(ls.body.items).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'big.bin', size: b.length })]));
    // the server indexed the file on completion (search index, no re-crawl)
    const found = await t.json('/api/fs/search?q=big', { token: t.token });
    expect(JSON.stringify(found.body)).toContain('/d/v/big.bin');
  });

  it('lost response after the provider got the chunk: next sign sees nextExpectedRanges and skips it', async () => {
    const t = await setup('onedrive');
    const b = data(4 * MiB + 99, 5);
    const { T, log } = transport(t, { faults: new Map([[2, 'drop-after-delivery']]) });
    const res = await uploadMultipart(fileOf(b), '/d/lost.bin', { transport: T, direct: true });
    expect(res.ok).toBe(true);
    expect(log.direct).toBe(res.session.totalParts); // chunk 2 was not sent twice (would be 416 out of order)
    expect(same((t.f as ReturnType<typeof oneDriveFake>).items.get('/lost.bin')?.data, b)).toBe(true);
  });

  it('resume after a refresh: the stored session URL continues from nextExpectedRanges', async () => {
    const t = await setup('onedrive');
    const b = data(5 * MiB, 6);
    const file = fileOf(b);
    const ctl = new UploadControl();
    const { T } = transport(t);
    await expect(uploadMultipart(file, '/d/r.bin', { transport: T, direct: true, control: ctl, onPartDone: (n) => n === 2 && ctl.cancel() })).rejects.toThrow();
    const row = await t.env.DB.prepare("SELECT upstream_upload_id FROM upload_sessions WHERE status = 'active'").first<{ upstream_upload_id: string }>();
    expect(JSON.parse(atob(row!.upstream_upload_id)).u).toMatch(/^https:\/\/upload\.fake\//);
    const { T: T2, log } = transport(t);
    const res = await uploadMultipart(file, '/d/r.bin', { transport: T2, direct: true });
    expect(res.session.resumed).toBe(true);
    expect(log.direct).toBe(res.session.totalParts - 2);
    expect(same((t.f as ReturnType<typeof oneDriveFake>).items.get('/r.bin')?.data, b)).toBe(true);
  });

  it('direct PUT blocked (CORS): falls back to the Worker for the rest of the parts', async () => {
    const t = await setup('onedrive');
    const b = data(5 * MiB, 7);
    const { T, log } = transport(t, { faults: new Map([[1, 'cors']]) });
    let remembered = 0;
    const res = await uploadMultipart(fileOf(b), '/d/c.bin', { transport: T, direct: true, onDirectFailed: () => remembered++ });
    expect(res.ok).toBe(true);
    expect(remembered).toBe(1);
    expect(log.direct).toBe(1);
    expect(log.proxied).toBe(res.session.totalParts);
    expect(same((t.f as ReturnType<typeof oneDriveFake>).items.get('/c.bin')?.data, b)).toBe(true);
    // once remembered, the plan no longer offers direct parts and the file goes through the Worker
    const plan = await t.json('/api/upload/plan', { method: 'POST', token: t.token, body: { path: '/d/x.bin', size: 5 * MiB, noDirect: true } });
    expect(plan.body.strategy).toBe('proxy');
  });
});

describe('Google Drive: browser-direct resumable sessions', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('session initiated with the browser Origin; chunks PUT directly (308), final item verified', async () => {
    const t = await setup('gdrive');
    const b = data(5 * MiB + 17, 8);
    const { T, log } = transport(t, { gdrive: true });
    const res = await uploadMultipart(fileOf(b), '/d/g/big.bin', { transport: T, direct: true });
    expect(res.ok).toBe(true);
    expect(res.session.partSize % (256 * 1024)).toBe(0);
    expect(log.proxied).toBe(0);
    expect(log.direct).toBe(res.session.totalParts);
    const f = t.f as ReturnType<typeof gdriveFake>;
    expect([...f.sessions.values()][0].origin).toBe(ORIGIN);
    const file = [...f.files.values()].find((x) => x.name === 'big.bin');
    expect(same(file?.data, b)).toBe(true);
    const parts = await t.env.DB.prepare('SELECT etag FROM upload_parts').all<{ etag: string }>();
    expect(parts.results.length).toBe(0); // cleaned up after completion
  });

  it('session origin mismatch looks like CORS → Worker fallback still completes the same session', async () => {
    const t = await setup('gdrive');
    const b = data(5 * MiB, 9);
    const { T, log } = transport(t, { gdrive: true, browserOrigin: 'https://other.example.com' });
    let remembered = 0;
    const res = await uploadMultipart(fileOf(b), '/d/o.bin', { transport: T, direct: true, onDirectFailed: () => remembered++ });
    expect(res.ok).toBe(true);
    expect(remembered).toBe(1);
    expect(log.proxied).toBe(res.session.totalParts);
    expect(same([...(t.f as ReturnType<typeof gdriveFake>).files.values()].find((x) => x.name === 'o.bin')?.data, b)).toBe(true);
  });

  it('resume: Content-Range bytes */size tells which chunks Google already has', async () => {
    const t = await setup('gdrive');
    const b = data(5 * MiB + 1, 10);
    const file = fileOf(b);
    const ctl = new UploadControl();
    const { T } = transport(t, { gdrive: true });
    await expect(uploadMultipart(file, '/d/r.bin', { transport: T, direct: true, control: ctl, onPartDone: (n) => n === 3 && ctl.cancel() })).rejects.toThrow();
    const { T: T2, log } = transport(t, { gdrive: true });
    const res = await uploadMultipart(file, '/d/r.bin', { transport: T2, direct: true });
    expect(res.session.resumed).toBe(true);
    expect(log.direct).toBe(res.session.totalParts - 3);
    expect(same([...(t.f as ReturnType<typeof gdriveFake>).files.values()].find((x) => x.name === 'r.bin')?.data, b)).toBe(true);
  });
});
