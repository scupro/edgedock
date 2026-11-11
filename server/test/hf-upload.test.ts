/**
 * HuggingFace Dataset large-file uploads (mocked Hub + S3): the browser engine (web/src/lib/chunked.ts)
 * against the real Hono app, with the HF driver talking to an in-memory Hub fake.
 * preupload → LFS batch (multipart) → direct part PUTs → completion → lfsFile commit,
 * plus: existing object skip, expired URL refresh, part retry, Worker proxy fallback, resume, small inline path.
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UploadControl, uploadMultipart, type PutResult, type Transport } from '../../web/src/lib/chunked';
import { sha256OfBlob } from '../../web/src/lib/sha256core';
import { registerDriver } from '../src/storage/registry';
import { huggingfaceDefinition } from '../src/storage/huggingface';
import { hfFake } from './fakes';
import { makeApp, makeEnv } from './helpers';

registerDriver(huggingfaceDefinition);

const KiB = 1024;
const CHUNK = 256 * KiB;

function data(size: number, seed = 7): Uint8Array {
  const d = new Uint8Array(size);
  let x = seed;
  for (let i = 0; i < size; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    d[i] = x >>> 16;
  }
  return d;
}
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const md5 = (b: Uint8Array) => createHash('md5').update(b).digest('hex');
const fileOf = (b: Uint8Array, name = 'big.bin') => Object.assign(new Blob([b as BlobPart]), { name, lastModified: 1700000000000 });

type F = ReturnType<typeof hfFake>;

async function setup(chunkSize = CHUNK) {
  const f = hfFake('me/data', 'datasets', { chunkSize });
  vi.stubGlobal('fetch', f.fetch);
  const env = makeEnv();
  const t = makeApp(env);
  const token = (await t.json('/api/auth/setup', { method: 'POST', body: { username: 'admin', password: 'password123' } })).body.token as string;
  const st = await t.json('/api/storages', { method: 'POST', token, body: { name: 'HF', type: 'huggingface', mountPath: '/hf', config: { repoId: 'me/data', token: 'HFTOKEN' } } });
  if (st.status !== 201) throw new Error(JSON.stringify(st.body));
  return { f, env, ...t, token, storageId: st.body.id as string };
}

/** Browser transport: relative URLs → the Worker app; absolute URLs → the provider (mocked fetch). */
function transport(t: Awaited<ReturnType<typeof setup>>, o: { directBlocked?: boolean } = {}) {
  const log = { direct: 0, proxied: 0, sleeps: [] as number[] };
  const T: Transport = {
    apiUrl: (p) => p,
    authHeaders: () => ({ authorization: `Bearer ${t.token}` }),
    sleep: async (ms) => {
      log.sleeps.push(ms);
    },
    random: () => 0.5,
    async api(p, opts = {}) {
      const headers: Record<string, string> = { authorization: `Bearer ${t.token}`, origin: 'https://edge.example.com' };
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
        if (o.directBlocked) return { status: 0, etag: null, text: '' }; // CORS-style failure
        expect(headers.authorization).toBeUndefined(); // never leak the EdgeDock / HF token to S3
        const res = await t.f.fetch(url, { method: 'PUT', headers, body: bytes });
        op.onProgress(bytes.length);
        return { status: res.status, etag: res.headers.get('etag'), text: await res.text() };
      }
      log.proxied++;
      const res = await t.req(url, { method: 'PUT', headers: { ...headers, 'content-length': String(bytes.length) }, body: bytes });
      op.onProgress(bytes.length);
      return { status: res.status, etag: res.headers.get('etag'), text: await res.text() };
    },
  };
  return { T, log };
}

async function readBack(t: Awaited<ReturnType<typeof setup>>, path: string) {
  const res = await t.req(`/api/fs/download?path=${encodeURIComponent(path)}`, { token: t.token });
  return new Uint8Array(await res.arrayBuffer());
}

function lastCommitOp(f: F) {
  return f.commits[f.commits.length - 1].ops[0];
}

describe('HuggingFace Dataset large uploads (LFS multipart)', () => {
  afterEach(() => vi.unstubAllGlobals());
  let t: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    t = await setup();
  });

  it('plan: big files → multipart with direct parts + sha256; small files → Worker proxy', async () => {
    const big = await t.json('/api/upload/plan', { method: 'POST', token: t.token, body: { path: '/hf/x.bin', size: 3 * 1024 ** 3 } });
    expect(big.body).toMatchObject({ strategy: 'multipart', direct: true, sha256: true });
    const broken = await t.json('/api/upload/plan', { method: 'POST', token: t.token, body: { path: '/hf/x.bin', size: 3 * 1024 ** 3, noDirect: true } });
    expect(broken.body).toMatchObject({ strategy: 'multipart', direct: false });
    const small = await t.json('/api/upload/plan', { method: 'POST', token: t.token, body: { path: '/hf/x.txt', size: 1000 } });
    expect(small.body.strategy).toBe('proxy');
    const tooBig = await t.json('/api/upload/plan', { method: 'POST', token: t.token, body: { path: '/hf/x.bin', size: 60 * 1024 ** 4 } });
    expect(tooBig.status).toBe(413);
  });

  it('browser SHA-256 (hash-wasm, streamed) matches node crypto', async () => {
    const b = data(9 * 1024 * 1024 + 123);
    const seen: number[] = [];
    expect(await sha256OfBlob(fileOf(b), (d) => seen.push(d))).toBe(sha(b));
    expect(seen.at(-1)).toBe(b.length);
    expect(seen.length).toBeGreaterThan(1);
  });

  it('preupload → batch multipart → direct parts → completion → lfsFile commit (bytes + etags exact)', async () => {
    const b = data(5 * CHUNK + 1234);
    const oid = sha(b);
    const { T, log } = transport(t);
    const res = await uploadMultipart(fileOf(b), '/hf/data/big.bin', { transport: T, direct: true, sha256: oid, concurrency: 3 });
    expect(res.ok).toBe(true);
    expect(res.checksum).toBe(`sha256:${oid}`);
    expect(res.session.totalParts).toBe(6);
    expect(res.session.partSize).toBe(CHUNK);
    expect(log.direct).toBe(6);
    expect(log.proxied).toBe(0);
    // one batch for create + one for signing all parts (not one per part)
    expect(t.f.mp.batches).toBe(2);
    const done = t.f.mp.completions[0];
    expect(done.oid).toBe(oid);
    expect(done.parts.map((p) => p.partNumber)).toEqual([1, 2, 3, 4, 5, 6]);
    for (const p of done.parts) expect(p.etag.replace(/"/g, '')).toBe(md5(b.subarray((p.partNumber - 1) * CHUNK, p.partNumber * CHUNK)));
    expect(lastCommitOp(t.f)).toEqual({ key: 'lfsFile', value: { path: 'data/big.bin', algo: 'sha256', oid, size: b.length } });
    expect(Buffer.compare(Buffer.from(await readBack(t, '/hf/data/big.bin')), Buffer.from(b))).toBe(0);
    // preupload was asked with the 512-byte sample
    expect(t.f.calls.filter((c) => c.includes('/preupload/')).length).toBe(1);
  });

  it('object already on the Hub: no part upload, commit only', async () => {
    const b = data(3 * CHUNK + 5, 9);
    const oid = sha(b);
    const { T } = transport(t);
    await uploadMultipart(fileOf(b), '/hf/a.bin', { transport: T, direct: true, sha256: oid });
    const putsBefore = t.f.mp.partPuts.length;
    const { T: T2, log } = transport(t);
    const res = await uploadMultipart(fileOf(b, 'copy.bin'), '/hf/b.bin', { transport: T2, direct: true, sha256: oid });
    expect(res.ok).toBe(true);
    expect(log.direct + log.proxied).toBe(0);
    expect(t.f.mp.partPuts.length).toBe(putsBefore);
    expect(lastCommitOp(t.f)).toMatchObject({ key: 'lfsFile', value: { path: 'b.bin', oid } });
  });

  it('expired presigned URLs: re-runs the batch for fresh URLs and continues with the remaining parts', async () => {
    const b = data(6 * CHUNK, 3);
    const oid = sha(b);
    const { T, log } = transport(t);
    let expiredOnce = false;
    const res = await uploadMultipart(fileOf(b), '/hf/exp.bin', {
      transport: T,
      direct: true,
      sha256: oid,
      concurrency: 1,
      onPartDone: (n) => {
        if (n === 2 && !expiredOnce) {
          expiredOnce = true;
          t.f.mp.gen++; // every URL handed out so far now answers 403 "Request has expired"
        }
      },
    });
    expect(res.ok).toBe(true);
    // part 3 hit an expired URL once, then everything was re-signed with one more batch
    expect(log.direct).toBe(7);
    expect(t.f.mp.batches).toBe(3);
    // the same S3 multipart upload kept every part (1..6 once each)
    expect(new Set(t.f.mp.partPuts).size).toBe(6);
    expect(Buffer.compare(Buffer.from(await readBack(t, '/hf/exp.bin')), Buffer.from(b))).toBe(0);
  });

  it('part retry with backoff on a 500 from S3', async () => {
    const b = data(3 * CHUNK + 77, 4);
    t.f.mp.partFailures.set(2, 2);
    const { T, log } = transport(t);
    const retries: number[] = [];
    const res = await uploadMultipart(fileOf(b), '/hf/retry.bin', { transport: T, direct: true, sha256: sha(b), onRetry: (i) => retries.push(i.part ?? 0) });
    expect(res.ok).toBe(true);
    expect(retries).toEqual([2, 2]);
    expect(log.sleeps.length).toBeGreaterThanOrEqual(2);
    expect(Buffer.compare(Buffer.from(await readBack(t, '/hf/retry.bin')), Buffer.from(b))).toBe(0);
  });

  it('direct PUT blocked (CORS): parts are streamed through the Worker instead, storage remembered', async () => {
    const b = data(4 * CHUNK + 1, 5);
    const { T, log } = transport(t, { directBlocked: true });
    let remembered = 0;
    const res = await uploadMultipart(fileOf(b), '/hf/proxy.bin', { transport: T, direct: true, sha256: sha(b), onDirectFailed: () => remembered++ });
    expect(res.ok).toBe(true);
    expect(remembered).toBe(1);
    // concurrent first attempts may all hit the blocked URL; every part ends up proxied exactly once
    expect(log.direct).toBeGreaterThanOrEqual(1);
    expect(log.direct).toBeLessThanOrEqual(3);
    expect(log.proxied).toBe(5);
    expect(t.f.mp.completions.at(-1)!.parts.every((p) => /^[0-9a-f]{32}$/.test(p.etag.replace(/"/g, '')))).toBe(true);
    expect(Buffer.compare(Buffer.from(await readBack(t, '/hf/proxy.bin')), Buffer.from(b))).toBe(0);
  });

  it('resume after a refresh: same fingerprint + sha256 → remaining parts only, fresh batch URLs', async () => {
    const b = data(6 * CHUNK + 10, 6);
    const oid = sha(b);
    const file = fileOf(b);
    const ctl = new UploadControl();
    const { T } = transport(t);
    await expect(
      uploadMultipart(file, '/hf/resume.bin', {
        transport: T,
        direct: true,
        sha256: oid,
        concurrency: 1,
        control: ctl,
        onPartDone: (n) => {
          if (n === 3) ctl.cancel();
        },
      }),
    ).rejects.toThrow();
    expect(t.f.mp.partPuts.length).toBe(3);
    // D1 kept the session: parts + etags + chunk size + oid
    const row = await t.env.DB.prepare("SELECT * FROM upload_sessions WHERE status = 'active'").first<{ id: string; part_size: number; checksum: string; upstream_upload_id: string }>();
    expect(row!.part_size).toBe(CHUNK);
    expect(row!.checksum).toBe(`sha256:${oid}`);
    expect(JSON.parse(row!.upstream_upload_id)).toMatchObject({ oid, t: 'multipart', cs: CHUNK });
    const parts = await t.env.DB.prepare('SELECT part_number, etag FROM upload_parts WHERE session_id = ? ORDER BY part_number').bind(row!.id).all<{ part_number: number; etag: string }>();
    expect(parts.results.map((p) => p.part_number)).toEqual([1, 2, 3]);
    t.f.mp.gen++; // a day later: the old URLs are expired
    const { T: T2, log } = transport(t);
    const res = await uploadMultipart(file, '/hf/resume.bin', { transport: T2, direct: true, sha256: oid });
    expect(res.session.resumed).toBe(true);
    expect(log.direct).toBe(4); // parts 4..7 only
    expect(Buffer.compare(Buffer.from(await readBack(t, '/hf/resume.bin')), Buffer.from(b))).toBe(0);
  });

  it('a different sha256 never resumes an old session', async () => {
    const b = data(3 * CHUNK, 8);
    const file = fileOf(b);
    const ctl = new UploadControl();
    const { T } = transport(t);
    await expect(uploadMultipart(file, '/hf/x.bin', { transport: T, direct: true, sha256: sha(b), concurrency: 1, control: ctl, onPartDone: () => ctl.cancel() })).rejects.toThrow();
    const wrong = 'f'.repeat(64);
    const init = await t.json('/api/upload/multipart/init', { method: 'POST', token: t.token, body: { path: '/hf/x.bin', size: b.length, fingerprint: 'v2|big.bin|' + b.length, sha256: wrong } });
    expect(init.body.resumed).toBe(false);
  });

  it('the Hub restarted the multipart upload: recorded parts are dropped and uploaded again', async () => {
    const b = data(4 * CHUNK, 10);
    const oid = sha(b);
    const file = fileOf(b);
    const ctl = new UploadControl();
    const { T } = transport(t);
    await expect(uploadMultipart(file, '/hf/rs.bin', { transport: T, direct: true, sha256: oid, concurrency: 1, control: ctl, onPartDone: (n) => n === 2 && ctl.cancel() })).rejects.toThrow();
    t.f.mp.uploadSeq++; // next batch hands out a new S3 upload id
    const { T: T2, log } = transport(t);
    const res = await uploadMultipart(file, '/hf/rs.bin', { transport: T2, direct: true, sha256: oid });
    expect(res.ok).toBe(true);
    expect(log.direct).toBe(4);
    expect(Buffer.compare(Buffer.from(await readBack(t, '/hf/rs.bin')), Buffer.from(b))).toBe(0);
  });

  it('init without sha256 is refused for HuggingFace', async () => {
    const r = await t.json('/api/upload/multipart/init', { method: 'POST', token: t.token, body: { path: '/hf/x.bin', size: 10 * CHUNK } });
    expect(r.status).toBe(400);
  });

  it('small files keep the single-request path: regular files inline, LFS via basic transfer', async () => {
    const txt = new TextEncoder().encode('hello dataset');
    const r1 = await t.req('/api/upload/proxy?path=/hf/notes.txt', { method: 'PUT', token: t.token, headers: { 'content-length': String(txt.length) }, body: txt as BodyInit });
    expect(r1.status).toBe(200);
    expect(lastCommitOp(t.f)).toMatchObject({ key: 'file', value: { path: 'notes.txt', encoding: 'base64' } });
    const bin = data(100 * KiB, 11); // below chunk size → basic transfer
    const r2 = await t.req('/api/upload/proxy?path=/hf/small.bin', { method: 'PUT', token: t.token, headers: { 'content-length': String(bin.length) }, body: bin as BodyInit });
    expect(r2.status).toBe(200);
    expect(lastCommitOp(t.f)).toMatchObject({ key: 'lfsFile', value: { path: 'small.bin', oid: sha(bin), size: bin.length } });
    expect(Buffer.compare(Buffer.from(await readBack(t, '/hf/small.bin')), Buffer.from(bin))).toBe(0);
  });
});
