/**
 * Phase 2 drivers against mocked provider APIs (test/fakes.ts):
 * list, read with Range, write / split / reassemble, token refresh, rate-limit backoff, readonly.
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decryptString } from '../src/lib/crypto';
import { UploadService } from '../src/lib/uploads';
import { DiscordDriver, discordUrlExpiry } from '../src/storage/discord';
import { GDriveDriver } from '../src/storage/gdrive';
import { GitHubDriver } from '../src/storage/github';
import { HuggingFaceDriver } from '../src/storage/huggingface';
import { clearTokenCache, signServiceAccountJwt } from '../src/storage/oauth';
import { OneDriveDriver } from '../src/storage/onedrive';
import { TelegramDriver } from '../src/storage/telegram';
import type { Vfs } from '../src/storage/mounts';
import type { StorageDriver } from '../src/storage/types';
import { discordFake, gdriveFake, githubFake, hfFake, oneDriveFake, telegramFake } from './fakes';
import { makeApp, makeEnv } from './helpers';

const MiB = 1024 * 1024;
const bytes = (n: number, seed = 1) => new Uint8Array(n).map((_, i) => (i * 31 + seed) % 251);
const text = async (s: ReadableStream<Uint8Array> | null) => new Uint8Array(await new Response(s).arrayBuffer());
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

beforeEach(() => clearTokenCache());

/** UploadService over a single-mount fake VFS */
function serviceFor(env: ReturnType<typeof makeEnv>, driver: StorageDriver, id = 'st1') {
  const mount = { row: { id }, mountPath: '/m', driver };
  const vfs = { mounts: [mount], mustResolve: (p: string) => ({ mount, rel: p.slice(2) || '/', vpath: p }) } as unknown as Vfs;
  return new UploadService(env, vfs);
}

async function multipartUpload(svc: UploadService, path: string, data: Uint8Array, partSize: number, stopAfter?: number) {
  const { session } = await svc.init({ path, size: data.length, partSize, createdBy: 'admin:1', ttlHours: 1 });
  for (let n = 1; n <= session.total_parts; n++) {
    if (stopAfter && n > stopAfter) return session;
    const part = data.slice((n - 1) * session.part_size, n * session.part_size);
    await svc.uploadPart(session.id, n, part, part.length);
  }
  await svc.complete(session.id);
  return session;
}

// ---------------------------------------------------------------- OneDrive
describe('OneDrive driver', () => {
  it('refreshes + rotates tokens (encrypted in D1), retries 401 and 429, lists with paging, reads ranges', async () => {
    const env = makeEnv();
    const f = oneDriveFake();
    const d = new OneDriveDriver({ clientId: 'cid', clientSecret: 'sec', refreshToken: 'rt0' }, { fetch: f.fetch, env, storageId: 'st1' });
    await d.mkdir('/docs/sub');
    f.state.fail429 = 1;
    await d.write('/docs/a.txt', 'hello onedrive', { size: 14 });
    await d.write('/docs/b.txt', 'b', { size: 1 });
    await d.write('/docs/c.txt', 'c', { size: 1 });
    const ls = await d.list('/docs');
    expect(ls.map((e) => `${e.isDir ? 'd' : 'f'}:${e.name}`).sort()).toEqual(['d:sub', 'f:a.txt', 'f:b.txt', 'f:c.txt']); // 2 pages
    const r = await d.read('/docs/a.txt', { range: { start: 6, end: 13 } });
    expect(new TextDecoder().decode(await text(r.body))).toBe('onedrive');
    expect(r.range).toEqual({ start: 6, end: 13 });
    // the first refresh used the configured token; the rotated one is stored encrypted
    expect(f.state.refreshSeen).toEqual(['rt0']);
    const row = await env.DB.prepare('SELECT refresh_token, access_token FROM oauth_tokens WHERE storage_id = ?').bind('st1').first<{ refresh_token: string; access_token: string }>();
    expect(row!.refresh_token.startsWith('v1.')).toBe(true);
    expect(await decryptString(row!.refresh_token, env.ENCRYPTION_KEY)).toBe('rt1');
    // access token revoked server-side → 401 → refresh with the rotated token, request replayed
    f.state.revokeAccess = true;
    expect((await d.stat('/docs/a.txt'))?.size).toBe(14);
    expect(f.state.refreshSeen).toEqual(['rt0', 'rt1']);
    // a second driver instance (new isolate) reuses the D1 access token without refreshing
    clearTokenCache();
    const d2 = new OneDriveDriver({ clientId: 'cid', refreshToken: 'rt0' }, { fetch: f.fetch, env, storageId: 'st1' });
    await d2.stat('/docs');
    expect(f.state.refreshSeen.length).toBe(2);
  });

  it('large writes and multipart sessions use in-order upload sessions (320 KiB aligned) and resume via nextExpectedRanges', async () => {
    const env = makeEnv();
    const f = oneDriveFake();
    const d = new OneDriveDriver({ clientId: 'cid', refreshToken: 'rt0', chunkSizeMB: 1 }, { fetch: f.fetch, env, storageId: 'st1' });
    const big = bytes(5 * MiB + 123);
    await d.write('/big.bin', new Blob([big]).stream(), { size: big.length });
    expect(sha(await text((await d.read('/big.bin')).body))).toBe(sha(big));
    expect(f.calls.filter((c) => c.startsWith('PUT upload.fake')).length).toBe(Math.ceil(big.length / (1 * MiB - (MiB % (320 * 1024)))));

    const svc = serviceFor(env, d);
    const data = bytes(3 * MiB + 7, 3);
    const s1 = await multipartUpload(svc, '/m/mp.bin', data, 1 * MiB, 2);
    expect(s1.part_size % (320 * 1024)).toBe(0);
    // resume: reconcile from the provider's nextExpectedRanges (2 parts done)
    const again = await svc.init({ path: '/m/mp.bin', size: data.length, partSize: MiB, createdBy: 'admin:1', ttlHours: 1, fingerprint: undefined });
    void again;
    const st = await svc.get(s1.id);
    const reconciled = await svc.reconcile(st.session, st.parts);
    expect(reconciled.map((p) => p.part_number)).toEqual([1, 2]);
    for (let n = 3; n <= s1.total_parts; n++) {
      const part = data.slice((n - 1) * s1.part_size, n * s1.part_size);
      await svc.uploadPart(s1.id, n, part, part.length);
    }
    await svc.complete(s1.id);
    expect(sha(await text((await d.read('/mp.bin')).body))).toBe(sha(data));
    // out-of-order parts are refused by the provider (sessions are sequential)
    expect(d.capabilities.sequentialParts).toBe(true);
  });

  it('rename / delete', async () => {
    const env = makeEnv();
    const f = oneDriveFake();
    const d = new OneDriveDriver({ clientId: 'cid', refreshToken: 'rt0' }, { fetch: f.fetch, env, storageId: 'st1' });
    await d.write('/x/a.txt', 'A', { size: 1 });
    await d.rename('/x/a.txt', '/y/b.txt');
    expect(await d.stat('/x/a.txt')).toBeNull();
    expect((await d.stat('/y/b.txt'))?.size).toBe(1);
    await d.delete('/y');
    expect(await d.stat('/y/b.txt')).toBeNull();
  });
});

// ---------------------------------------------------------------- Google Drive
describe('Google Drive driver', () => {
  it('OAuth refresh token: path resolution, multipart + resumable uploads, ranges, move/copy/delete', async () => {
    const env = makeEnv();
    const f = gdriveFake();
    const d = new GDriveDriver({ clientId: 'cid', clientSecret: 's', refreshToken: 'rt', chunkSizeMB: 1 }, { fetch: f.fetch, env, storageId: 'g1' });
    await d.write("/docs/it's.txt", 'hello drive', { size: 11 });
    const big = bytes(6 * MiB + 99);
    await d.write('/docs/big.bin', big, { size: big.length });
    expect(f.calls.filter((c) => c.startsWith('PUT www.googleapis.com/upload')).length).toBe(7);
    expect((await d.list('/docs')).map((e) => e.name).sort()).toEqual(['big.bin', "it's.txt"]);
    const r = await d.read('/docs/big.bin', { range: { start: MiB, end: MiB + 9 } });
    expect([...(await text(r.body))]).toEqual([...big.slice(MiB, MiB + 10)]);
    await d.rename('/docs/big.bin', '/archive/big2.bin');
    expect(await d.stat('/docs/big.bin')).toBeNull();
    expect((await d.stat('/archive/big2.bin'))?.size).toBe(big.length);
    await d.copy("/docs/it's.txt", '/archive/copy.txt');
    expect(new TextDecoder().decode(await text((await d.read('/archive/copy.txt')).body))).toBe('hello drive');
    await d.delete('/docs');
    expect(await d.stat("/docs/it's.txt")).toBeNull();
    expect(f.state.tokens).toBe(1);
  });

  it('service account JWT (RS256 verified by the fake) + native multipart session with status-based resume', async () => {
    const kp = (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
    const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(pkcs8).toString('base64')}\n-----END PRIVATE KEY-----\n`;
    const key = { client_email: 'sa@p.iam.gserviceaccount.com', private_key: pem };
    const jwt = await signServiceAccountJwt(key, 'scope', 1000);
    expect(JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString())).toMatchObject({ iss: key.client_email, aud: 'https://oauth2.googleapis.com/token', iat: 1000, exp: 4600 });

    const env = makeEnv();
    const f = gdriveFake({ publicKey: kp.publicKey });
    const d = new GDriveDriver({ authType: 'service_account', serviceAccountJson: JSON.stringify(key) }, { fetch: f.fetch, env, storageId: 'g2' });
    const svc = serviceFor(env, d);
    const data = bytes(MiB + 512 * 1024 + 3, 9);
    const s = await multipartUpload(svc, '/m/sa.bin', data, 512 * 1024, 1);
    const st = await svc.get(s.id);
    expect((await svc.reconcile(st.session, st.parts)).map((p) => p.part_number)).toEqual([1]);
    for (let n = 2; n <= s.total_parts; n++) {
      const part = data.slice((n - 1) * s.part_size, n * s.part_size);
      await svc.uploadPart(s.id, n, part, part.length);
    }
    await svc.complete(s.id);
    expect(sha(await text((await d.read('/sa.bin')).body))).toBe(sha(data));
    expect(f.state.jwtOk).toBe(1);
  });
});

// ---------------------------------------------------------------- Telegram
describe('Telegram driver', () => {
  it('splits files into ≤ 20 MB parts, reassembles with Range, retries 429, deletes messages', async () => {
    const env = makeEnv();
    const f = telegramFake();
    // even if a bigger part is configured, the public Bot API is capped at the 20 MB getFile limit
    const d = new TelegramDriver({ botToken: 'TOKEN', chatId: '-100', partSizeMB: 100 }, { fetch: f.fetch, env, storageId: 't1' });
    expect(d.partLimit).toBe(20 * 1000 * 1000);
    const small = new TelegramDriver({ botToken: 'TOKEN', chatId: '-100', partSizeMB: 1 }, { fetch: f.fetch, env, storageId: 't1' });
    const data = bytes(2 * MiB + 1000, 5);
    await small.write('/v/movie.bin', new Blob([data]).stream(), { size: data.length });
    expect(f.msgs.size).toBe(3);
    expect((await small.list('/v')).map((e) => [e.name, e.size])).toEqual([['movie.bin', data.length]]);
    expect(sha(await text((await small.read('/v/movie.bin')).body))).toBe(sha(data));
    // a range that spans the part boundary
    const r = await small.read('/v/movie.bin', { range: { start: MiB - 5, end: MiB + 4 } });
    expect([...(await text(r.body))]).toEqual([...data.slice(MiB - 5, MiB + 5)]);
    expect(r.range).toEqual({ start: MiB - 5, end: MiB + 4 });
    // metadata-only rename, then delete removes the messages
    await small.rename('/v', '/films');
    expect((await small.stat('/films/movie.bin'))?.size).toBe(data.length);
    await small.delete('/films');
    expect(f.state.deleted.length).toBe(3);
    expect(await small.stat('/films/movie.bin')).toBeNull();
    await small.test();
  });

  it('native multipart sessions: each part is one document, nothing re-uploaded on complete', async () => {
    const env = makeEnv();
    const f = telegramFake();
    f.state.fail429 = 0;
    const d = new TelegramDriver({ botToken: 'TOKEN', chatId: '-100', partSizeMB: 2 }, { fetch: f.fetch, env, storageId: 't2' });
    const svc = serviceFor(env, d, 't2');
    const data = bytes(5 * MiB + 1, 8);
    const s = await multipartUpload(svc, '/m/up.bin', data, 8 * MiB);
    expect(s.mode).toBe('native');
    expect(s.part_size).toBe(2 * MiB); // capped by the provider part limit
    expect(f.msgs.size).toBe(3);
    expect(sha(await text((await d.read('/up.bin')).body))).toBe(sha(data));
    // re-uploading a part replaces (and deletes) the previous document
    const s2 = await multipartUpload(svc, '/m/up2.bin', data, 2 * MiB, 1);
    await svc.uploadPart(s2.id, 1, data.slice(0, 2 * MiB), 2 * MiB);
    expect(f.state.deleted.length).toBe(1);
    await svc.abort(s2.id);
    expect(f.state.deleted.length).toBe(2);
  });
});

// ---------------------------------------------------------------- Discord
describe('Discord driver', () => {
  it('splits into attachments, refreshes expired CDN URLs, handles 429 retry_after, Range across parts', async () => {
    const env = makeEnv();
    const f = discordFake();
    const d = new DiscordDriver({ botToken: 'DTOKEN', channelId: 'C1', partSizeMB: 1 }, { fetch: f.fetch, env, storageId: 'd1' });
    const data = bytes(2 * MiB + 77, 2);
    await d.write('/a/file.bin', data, { size: data.length });
    expect(f.msgs.size).toBe(3);
    // stored URLs were already expired → refreshed via GET message
    expect(sha(await text((await d.read('/a/file.bin')).body))).toBe(sha(data));
    expect(f.state.refreshes).toBe(3);
    const r = await d.read('/a/file.bin', { range: { start: 2 * MiB - 1, end: 2 * MiB + 76 } });
    expect([...(await text(r.body))]).toEqual([...data.slice(2 * MiB - 1)]);
    expect(f.state.refreshes).toBe(3); // cached fresh URLs reused
    expect(discordUrlExpiry('https://cdn.discordapp.com/x?ex=65f00000')).toBe(0x65f00000 * 1000);
    await d.delete('/a/file.bin');
    expect(f.msgs.size).toBe(0);
    await d.test();
  });
});

// ---------------------------------------------------------------- HuggingFace
describe('HuggingFace driver', () => {
  it('lists with pagination, reads with Range through the CDN redirect, commits regular + LFS files, moves LFS by oid', async () => {
    const f = hfFake();
    const d = new HuggingFaceDriver({ repoId: 'me/data', token: 'HFTOKEN' }, { fetch: f.fetch });
    await d.write('/README.md', '# data', { size: 6 });
    const bin = bytes(300_000, 4);
    await d.write('/data/train.bin', bin, { size: bin.length });
    await d.write('/data/a.txt', 'a', { size: 1 });
    await d.write('/data/b.txt', 'b', { size: 1 });
    await d.write('/data/c.txt', 'c', { size: 1 });
    expect(f.commits.map((c) => c.ops[0].key)).toEqual(['file', 'lfsFile', 'file', 'file', 'file']);
    expect(f.lfsStore.size).toBe(1);
    const ls = await d.list('/data');
    expect(ls.map((e) => e.name)).toEqual(['a.txt', 'b.txt', 'c.txt', 'train.bin']); // two pages
    expect(ls.find((e) => e.name === 'train.bin')?.size).toBe(bin.length); // LFS size, not pointer size
    const r = await d.read('/data/train.bin', { range: { start: 1000, end: 1009 } });
    expect([...(await text(r.body))]).toEqual([...bin.slice(1000, 1010)]);
    await d.rename('/data/train.bin', '/data/v2/train.bin');
    const mv = f.commits.at(-1)!;
    expect(mv.ops.map((o) => o.key)).toEqual(['lfsFile', 'deletedFile']); // no re-upload
    expect(await d.stat('/data/train.bin')).toBeNull();
    expect((await d.stat('/data/v2/train.bin'))?.size).toBe(bin.length);
    await d.delete('/data');
    expect(await d.stat('/data/a.txt')).toBeNull();
    expect(d.capabilities.maxUploadSize).toBe(50 * MiB);
    await expect(d.write('/huge.bin', new Uint8Array(1), { size: 51 * MiB })).rejects.toMatchObject({ status: 413 });
  });

  it('writes need a token', async () => {
    const f = hfFake();
    const d = new HuggingFaceDriver({ repoId: 'me/data' }, { fetch: f.fetch });
    await expect(d.write('/x.txt', 'x', { size: 1 })).rejects.toMatchObject({ status: 401 });
  });
});

// ---------------------------------------------------------------- GitHub (read-only)
describe('GitHub driver (read-only)', () => {
  it('contents + releases tree, Range on raw files and assets, waits out a short rate limit', async () => {
    const f = githubFake();
    const d = new GitHubDriver({ owner: 'o', repo: 'r', mode: 'both' }, { fetch: f.fetch });
    expect((await d.list('/')).map((e) => e.name)).toEqual(['code', 'releases']);
    expect((await d.list('/code')).map((e) => `${e.isDir ? 'd' : 'f'}:${e.path}`).sort()).toEqual(['d:/code/src', 'f:/code/README.md']);
    expect((await d.list('/code/src')).map((e) => e.path)).toEqual(['/code/src/a.ts']);
    const r = await d.read('/code/README.md', { range: { start: 2, end: 6 } });
    expect(new TextDecoder().decode(await text(r.body))).toBe('hello');
    expect((await d.list('/releases')).map((e) => e.name)).toEqual(['v1.0']);
    expect(f.state.limited).toBe(0);
    const a = await d.read('/releases/v1.0/app.zip', { range: { start: 100, end: 199 } });
    expect([...(await text(a.body))]).toEqual([...f.asset.slice(100, 200)]);
    expect((await d.stat('/releases/v1.0/app.zip'))?.size).toBe(3000);
    for (const op of [() => d.write(), () => d.delete(), () => d.mkdir(), () => d.rename(), () => d.copy()]) await expect(op()).rejects.toMatchObject({ status: 405 });
  });

  it('is enforced as read-only through the HTTP API, upload plans and WebDAV', async () => {
    const f = githubFake();
    vi.stubGlobal('fetch', f.fetch);
    try {
      const env = makeEnv();
      const t = makeApp(env);
      const token = (await t.json('/api/auth/setup', { method: 'POST', body: { username: 'admin', password: 'password123' } })).body.token;
      const st = await t.json('/api/storages', { method: 'POST', token, body: { name: 'GH', type: 'github', mountPath: '/gh', config: { owner: 'o', repo: 'r' } } });
      expect(st.body.readOnly).toBe(true);
      const ls = await t.json('/api/fs/list?path=/gh', { token });
      expect(ls.status).toBe(200);
      expect((await t.json('/api/fs/mkdir', { method: 'POST', token, body: { path: '/gh/new' } })).status).toBe(405);
      expect((await t.json('/api/fs/delete', { method: 'POST', token, body: { paths: ['/gh/README.md'] } })).status).toBe(405);
      expect((await t.req('/api/upload/proxy?path=/gh/x.txt', { method: 'PUT', token, body: 'x' })).status).toBe(405);
      expect((await t.json('/api/upload/plan', { method: 'POST', token, body: { path: '/gh/x.txt', size: 1 } })).status).toBe(405);
      expect((await t.json('/api/upload/multipart/init', { method: 'POST', token, body: { path: '/gh/x.bin', size: 100 } })).status).toBe(405);
      const dav = await t.req('/dav/gh/README.md', { method: 'GET', token, headers: { range: 'bytes=0-6' } });
      expect(dav.status).toBe(206);
      expect(await dav.text()).toBe('# hello');
      expect((await t.req('/dav/gh/new.txt', { method: 'PUT', token, body: 'x' })).status).toBe(405);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ---------------------------------------------------------------- OAuth helper flow
describe('OAuth helper flow (/api/oauth/onedrive)', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('start → callback stores the refresh token encrypted in the storage secret', async () => {
    const f = oneDriveFake();
    vi.stubGlobal('fetch', f.fetch);
    const env = makeEnv({ PUBLIC_URL: 'https://edge.example.com' });
    const t = makeApp(env);
    const token = (await t.json('/api/auth/setup', { method: 'POST', body: { username: 'admin', password: 'password123' } })).body.token;
    const st = await t.json('/api/storages', { method: 'POST', token, body: { name: 'OD', type: 'onedrive', mountPath: '/od', config: { clientId: 'cid', clientSecret: 'sec' } } });
    expect(st.status).toBe(201);
    const start = await t.json('/api/oauth/onedrive/start', { method: 'POST', token, body: { storageId: st.body.id } });
    const u = new URL(start.body.url);
    expect(u.origin + u.pathname).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
    expect(u.searchParams.get('redirect_uri')).toBe('https://edge.example.com/api/oauth/onedrive/callback');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('scope')).toContain('offline_access');
    // anonymous callback
    const cb = await t.req(`/api/oauth/onedrive/callback?code=CODE&state=${u.searchParams.get('state')}`);
    expect(cb.status).toBe(200);
    expect(await cb.text()).toContain('edgedock-oauth');
    const row = await env.DB.prepare('SELECT secret FROM storages WHERE id = ?').bind(st.body.id).first<{ secret: string }>();
    expect(JSON.parse(await decryptString(row!.secret, env.ENCRYPTION_KEY))).toMatchObject({ clientSecret: 'sec', refreshToken: 'rt1' });
    // state is single-use
    expect((await t.req(`/api/oauth/onedrive/callback?code=CODE&state=${u.searchParams.get('state')}`)).status).toBe(400);
    // the mounted storage now works with the stored tokens
    expect((await t.json('/api/fs/list?path=/od', { token })).status).toBe(200);
  });
});
