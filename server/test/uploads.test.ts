import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { choosePartSize, expectedPartSize, MIN_PART_SIZE, UploadService } from '../src/lib/uploads';
import { Vfs } from '../src/storage/mounts';
import { setupWithLocal } from './helpers';

const MiB = 1024 * 1024;

describe('multipart helpers', () => {
  it('chooses valid part sizes', () => {
    expect(choosePartSize(10 * MiB, 1 * MiB)).toBe(MIN_PART_SIZE);
    expect(choosePartSize(10 * MiB, 8 * MiB)).toBe(8 * MiB);
    const huge = 200 * 1024 * MiB; // 200 GiB
    const ps = choosePartSize(huge, 8 * MiB);
    expect(Math.ceil(huge / ps)).toBeLessThanOrEqual(10_000);
  });
  it('computes expected part sizes', () => {
    const s = { size: 12, part_size: 5, total_parts: 3 };
    expect(expectedPartSize(s, 1)).toBe(5);
    expect(expectedPartSize(s, 3)).toBe(2);
    expect(expectedPartSize(s, 4)).toBe(-1);
  });
});

describe('emulated multipart sessions (local driver)', () => {
  it('uploads in parts, resumes by fingerprint, completes and concatenates', async () => {
    const t = await setupWithLocal();
    const size = MIN_PART_SIZE * 2 + 123;
    const data = new Uint8Array(size);
    for (let i = 0; i < size; i++) data[i] = (i * 7) % 251;

    await t.json('/api/admin/settings', { method: 'PUT', token: t.token, body: { uploadPartSizeMB: 5 } });
    const init = await t.json('/api/upload/multipart/init', { method: 'POST', token: t.token, body: { path: '/local/big/file.bin', size, fingerprint: 'fp-1' } });
    expect(init.status).toBe(200);
    expect(init.body).toMatchObject({ mode: 'emulated', totalParts: 3, partSize: MIN_PART_SIZE, uploadedParts: [] });
    const id = init.body.id;

    const part = (n: number) => data.slice((n - 1) * MIN_PART_SIZE, Math.min(n * MIN_PART_SIZE, size));
    const p2 = await t.req(`/api/upload/multipart/${id}/parts/2`, { method: 'PUT', token: t.token, body: part(2), headers: { 'content-length': String(part(2).byteLength) } });
    expect(p2.status).toBe(200);

    // wrong size rejected
    const bad = await t.req(`/api/upload/multipart/${id}/parts/1`, { method: 'PUT', token: t.token, body: new Uint8Array(10) });
    expect(bad.status).toBe(400);

    // "page refresh": init again with same fingerprint -> resumed with part 2 done
    const again = await t.json('/api/upload/multipart/init', { method: 'POST', token: t.token, body: { path: '/local/big/file.bin', size, fingerprint: 'fp-1' } });
    expect(again.body).toMatchObject({ id, resumed: true, uploadedParts: [2] });

    // completing early fails
    const early = await t.json(`/api/upload/multipart/${id}/complete`, { method: 'POST', token: t.token });
    expect(early.status).toBe(400);
    expect(early.body.error).toContain('Missing parts: 1, 3');

    for (const n of [1, 3]) {
      const r = await t.req(`/api/upload/multipart/${id}/parts/${n}`, { method: 'PUT', token: t.token, body: part(n), headers: { 'content-length': String(part(n).byteLength) } });
      expect(r.status).toBe(200);
    }
    // temp parts are hidden from listings
    const ls = await t.json('/api/fs/list?path=/local', { token: t.token });
    expect(ls.body.items.map((i: any) => i.name)).not.toContain('.edgedock-uploads');

    const done = await t.json(`/api/upload/multipart/${id}/complete`, { method: 'POST', token: t.token });
    expect(done.status).toBe(200);
    const onDisk = readFileSync(path.join(t.root, 'big/file.bin'));
    expect(onDisk.byteLength).toBe(size);
    expect(Buffer.compare(onDisk, Buffer.from(data))).toBe(0);

    // completed session can't take more parts
    const late = await t.req(`/api/upload/multipart/${id}/parts/1`, { method: 'PUT', token: t.token, body: part(1) });
    expect(late.status).toBe(410);
    // new init with same fingerprint starts a fresh session
    const fresh = await t.json('/api/upload/multipart/init', { method: 'POST', token: t.token, body: { path: '/local/big/file.bin', size, fingerprint: 'fp-1' } });
    expect(fresh.body.id).not.toBe(id);
  });

  it('aborts and cleans up expired sessions', async () => {
    const t = await setupWithLocal();
    const vfs = await Vfs.create(t.env);
    const svc = new UploadService(t.env, vfs);
    const { session } = await svc.init({ path: '/local/x.bin', size: 10, partSize: MIN_PART_SIZE, createdBy: 'admin:1', ttlHours: 1 });
    await svc.uploadPart(session.id, 1, new Uint8Array(10), 10);
    await t.env.DB.prepare('UPDATE upload_sessions SET expires_at = ? WHERE id = ?').bind(Date.now() - 1, session.id).run();
    expect(await svc.cleanupExpired()).toBe(1);
    const { session: s2, parts } = await svc.get(session.id);
    expect(s2.status).toBe('aborted');
    expect(parts).toHaveLength(0);
  });

  it('other principals cannot touch a session', async () => {
    const t = await setupWithLocal();
    const k = (await t.json('/api/admin/keys', { method: 'POST', token: t.token, body: { name: 'rw', permission: 'readwrite' } })).body.key;
    const init = await t.json('/api/upload/multipart/init', { method: 'POST', token: t.token, body: { path: '/local/y.bin', size: 10 } });
    expect((await t.json(`/api/upload/multipart/${init.body.id}`, { token: k })).status).toBe(403);
  });
});

describe('upload plan + proxy + search index', () => {
  it('plans proxy for local storage, uploads, indexes and searches', async () => {
    const t = await setupWithLocal();
    const plan = await t.json('/api/upload/plan', { method: 'POST', token: t.token, body: { path: '/local/a/讀我.md', size: 10 } });
    expect(plan.body.strategy).toBe('proxy');
    const big = await t.json('/api/upload/plan', { method: 'POST', token: t.token, body: { path: '/local/a/big.iso', size: 500 * MiB } });
    expect(big.body.strategy).toBe('multipart');
    await t.req('/api/upload/proxy?path=/local/a/讀我.md', { method: 'PUT', token: t.token, body: '# readme' });
    const s = await t.json('/api/fs/search?q=讀我', { token: t.token });
    expect(s.body.map((h: any) => h.path)).toContain('/local/a/讀我.md');
    // full rebuild via job
    await t.json('/api/admin/jobs/index', { method: 'POST', token: t.token });
    const s2 = await t.json('/api/fs/search?q=md', { token: t.token });
    expect(s2.body.map((h: any) => h.path)).toEqual(['/local/a/讀我.md']);
    const runs = await t.json('/api/admin/jobs/runs', { token: t.token });
    expect(runs.body[0]).toMatchObject({ kind: 'index', status: 'success' });
  });

  it('file ops: rename/move/copy/delete and signed links', async () => {
    const t = await setupWithLocal();
    await t.req('/api/upload/proxy?path=/local/one.txt', { method: 'PUT', token: t.token, body: '0123456789' });
    expect((await t.json('/api/fs/rename', { method: 'POST', token: t.token, body: { path: '/local/one.txt', name: 'two.txt' } })).status).toBe(200);
    await t.json('/api/fs/mkdir', { method: 'POST', token: t.token, body: { path: '/local/dir' } });
    await t.json('/api/fs/copy', { method: 'POST', token: t.token, body: { paths: ['/local/two.txt'], to: '/local/dir' } });
    await t.json('/api/fs/move', { method: 'POST', token: t.token, body: { paths: ['/local/two.txt'], to: '/local/dir/sub' } });
    const ls = await t.json('/api/fs/list?path=/local/dir', { token: t.token });
    expect(ls.body.items.map((i: any) => i.name)).toEqual(['sub', 'two.txt']);
    const signed = await t.json('/api/fs/sign', { method: 'POST', token: t.token, body: { path: '/local/dir/two.txt' } });
    const r = await t.req(signed.body.url, { headers: { range: 'bytes=0-3' } });
    expect(r.status).toBe(206);
    expect(await r.text()).toBe('0123');
    expect((await t.req(signed.body.url.replace(/\/api\/file\/[^/]+/, '/api/file/bad'))).status).toBe(401);
    await t.json('/api/fs/delete', { method: 'POST', token: t.token, body: { paths: ['/local/dir'] } });
    expect((await t.json('/api/fs/list?path=/local', { token: t.token })).body.items).toHaveLength(0);
  });
});
