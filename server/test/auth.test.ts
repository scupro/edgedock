import { describe, expect, it } from 'vitest';
import { canRead, canTraverse, canWrite, createApiKey, verifyApiKey } from '../src/lib/auth';
import type { Principal } from '../src/lib/types';
import { makeApp, makeEnv, setupWithLocal } from './helpers';

describe('admin auth', () => {
  it('first-run setup creates the admin once, then login works', async () => {
    const env = makeEnv();
    const { json } = makeApp(env);
    let s = await json('/api/auth/status');
    expect(s.body.needsSetup).toBe(true);
    expect(s.body.settings.defaultLanguage).toBe('zh-TW');
    const r = await json('/api/auth/setup', { method: 'POST', body: { username: 'admin', password: 'password123' } });
    expect(r.status).toBe(200);
    expect(r.body.token).toBeTruthy();
    const again = await json('/api/auth/setup', { method: 'POST', body: { username: 'x', password: 'password123' } });
    expect(again.status).toBe(403);
    s = await json('/api/auth/status');
    expect(s.body.needsSetup).toBe(false);
    const bad = await json('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'nope-nope' } });
    expect(bad.status).toBe(401);
    const ok = await json('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'password123' } });
    expect(ok.status).toBe(200);
    const me = await json('/api/auth/me', { token: ok.body.token });
    expect(me.body).toMatchObject({ kind: 'admin', name: 'admin', permission: 'admin' });
  });

  it('bootstraps admin from ADMIN_USERNAME / ADMIN_PASSWORD', async () => {
    const env = makeEnv({ ADMIN_USERNAME: 'root', ADMIN_PASSWORD: 'supersecret' });
    const { json } = makeApp(env);
    expect((await json('/api/auth/status')).body.needsSetup).toBe(false);
    expect((await json('/api/auth/login', { method: 'POST', body: { username: 'root', password: 'supersecret' } })).status).toBe(200);
  });

  it('rejects forged / tampered tokens', async () => {
    const env = makeEnv();
    const { json } = makeApp(env);
    const r = await json('/api/auth/setup', { method: 'POST', body: { username: 'admin', password: 'password123' } });
    const t: string = r.body.token;
    const tampered = t.slice(0, -2) + (t.endsWith('A') ? 'BB' : 'AA');
    expect((await json('/api/auth/me', { token: tampered })).status).toBe(401);
    expect((await json('/api/storages', { token: 'nonsense' })).status).toBe(401);
  });

  it('requires ENCRYPTION_KEY', async () => {
    const env = makeEnv({ ENCRYPTION_KEY: '' });
    const { json } = makeApp(env);
    expect((await json('/api/auth/status')).status).toBe(500);
  });
});

describe('API keys', () => {
  it('verifies, expires, revokes and tracks last use', async () => {
    const env = makeEnv();
    const { key, row } = await createApiKey(env, { name: 'k', permission: 'read', pathPrefix: '/docs' });
    expect(key.startsWith('edk_')).toBe(true);
    const p = await verifyApiKey(env, key);
    expect(p).toMatchObject({ kind: 'apikey', permission: 'read', pathPrefix: '/docs' });
    const r = await env.DB.prepare('SELECT last_used_at FROM api_keys WHERE id = ?').bind(row.id).first<{ last_used_at: number }>();
    expect(r?.last_used_at).toBeGreaterThan(0);
    expect(await verifyApiKey(env, key + 'x')).toBeNull();
    expect(await verifyApiKey(env, 'not-a-key')).toBeNull();

    const exp = await createApiKey(env, { name: 'e', permission: 'readwrite', expiresAt: Date.now() - 1 });
    expect(await verifyApiKey(env, exp.key)).toBeNull();

    await env.DB.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ?').bind(Date.now(), row.id).run();
    expect(await verifyApiKey(env, key)).toBeNull();
  });

  it('enforces scopes (pure)', () => {
    const ro: Principal = { kind: 'apikey', id: '1', name: 'ro', permission: 'read', pathPrefix: '/docs' };
    const rw: Principal = { kind: 'apikey', id: '2', name: 'rw', permission: 'readwrite', pathPrefix: '/docs/team' };
    expect(canRead(ro, '/docs/a.md')).toBe(true);
    expect(canRead(ro, '/other')).toBe(false);
    expect(canRead(ro, '/docsx')).toBe(false);
    expect(canWrite(ro, '/docs/a.md')).toBe(false);
    expect(canWrite(rw, '/docs/team/a.md')).toBe(true);
    expect(canWrite(rw, '/docs/a.md')).toBe(false);
    expect(canTraverse(rw, '/')).toBe(true);
    expect(canTraverse(rw, '/docs')).toBe(true);
    expect(canTraverse(rw, '/elsewhere')).toBe(false);
  });

  it('enforces scopes over HTTP', async () => {
    const t = await setupWithLocal();
    await t.json('/api/fs/mkdir', { method: 'POST', token: t.token, body: { path: '/local/team' } });
    await t.json('/api/fs/mkdir', { method: 'POST', token: t.token, body: { path: '/local/private' } });

    const ro = await t.json('/api/admin/keys', { method: 'POST', token: t.token, body: { name: 'ro', permission: 'read', pathPrefix: '/local/team' } });
    const rw = await t.json('/api/admin/keys', { method: 'POST', token: t.token, body: { name: 'rw', permission: 'readwrite', pathPrefix: '/local/team' } });
    expect(ro.status).toBe(201);
    const roKey = ro.body.key as string;
    const rwKey = rw.body.key as string;

    // read-only key can list inside, cannot write
    expect((await t.json('/api/fs/list?path=/local/team', { token: roKey })).status).toBe(200);
    expect((await t.json('/api/fs/mkdir', { method: 'POST', token: roKey, body: { path: '/local/team/x' } })).status).toBe(403);
    // traversal of parents shows only the allowed branch
    const parent = await t.json('/api/fs/list?path=/local', { token: roKey });
    expect(parent.status).toBe(200);
    expect(parent.body.items.map((i: any) => i.name)).toEqual(['team']);
    // outside prefix
    expect((await t.json('/api/fs/list?path=/local/private', { token: roKey })).status).toBe(403);
    // read-write key
    expect((await t.json('/api/fs/mkdir', { method: 'POST', token: rwKey, body: { path: '/local/team/x' } })).status).toBe(200);
    expect((await t.json('/api/fs/mkdir', { method: 'POST', token: rwKey, body: { path: '/local/private/x' } })).status).toBe(403);
    // keys cannot reach admin APIs
    expect((await t.json('/api/storages', { token: rwKey })).status).toBe(403);
    // X-API-Key header also works
    expect((await t.json('/api/fs/list?path=/local/team', { headers: { 'x-api-key': roKey } })).status).toBe(200);
    // revoke
    await t.json(`/api/admin/keys/${ro.body.id}/revoke`, { method: 'POST', token: t.token });
    expect((await t.json('/api/fs/list?path=/local/team', { token: roKey })).status).toBe(401);
    const list = await t.json('/api/admin/keys', { token: t.token });
    expect(list.body.find((k: any) => k.id === ro.body.id).active).toBe(false);
    expect(list.body.find((k: any) => k.id === rw.body.id).lastUsedAt).toBeGreaterThan(0);
    expect(JSON.stringify(list.body)).not.toContain(rwKey);
  });
});
