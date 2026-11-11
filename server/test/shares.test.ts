import { describe, expect, it } from 'vitest';
import { consumeExpiredShares } from '../src/jobs/cleanup';
import { shareState } from '../src/lib/shares';
import { setupWithLocal } from './helpers';

describe('share rules (pure)', () => {
  it('computes state', () => {
    const now = 1_000_000;
    expect(shareState({ expires_at: null, max_views: null, views: 99 }, now)).toBe('ok');
    expect(shareState({ expires_at: now - 1, max_views: null, views: 0 }, now)).toBe('expired');
    expect(shareState({ expires_at: now + 1, max_views: 3, views: 2 }, now)).toBe('ok');
    expect(shareState({ expires_at: null, max_views: 3, views: 3 }, now)).toBe('exhausted');
  });
});

describe('shares over HTTP', () => {
  it('markdown share with password, view limit and raw link', async () => {
    const t = await setupWithLocal();
    const created = await t.json('/api/shares', {
      method: 'POST',
      token: t.token,
      body: { type: 'markdown', title: '筆記', content: '# 你好\n\n世界', password: 'pw-1234', maxViews: 2, slug: 'hello-note' },
    });
    expect(created.status).toBe(201);
    expect(created.body.hasPassword).toBe(true);
    expect(JSON.stringify(created.body)).not.toContain('pw-1234');

    const dup = await t.json('/api/shares', { method: 'POST', token: t.token, body: { type: 'text', content: 'x', slug: 'hello-note' } });
    expect(dup.status).toBe(409);

    const meta = await t.json('/api/public/shares/hello-note');
    expect(meta.status).toBe(200);
    expect(meta.body).toMatchObject({ type: 'markdown', hasPassword: true, title: '筆記' });
    expect(meta.body.content).toBeUndefined();

    // locked
    expect((await t.json('/api/public/shares/hello-note/content')).status).toBe(401);
    expect((await t.req('/raw/hello-note')).status).toBe(401);
    expect((await t.json('/api/public/shares/hello-note/unlock', { method: 'POST', body: { password: 'bad' } })).status).toBe(401);
    const unlock = await t.json('/api/public/shares/hello-note/unlock', { method: 'POST', body: { password: 'pw-1234' } });
    expect(unlock.status).toBe(200);

    // view 1 via token
    const c1 = await t.json(`/api/public/shares/hello-note/content?token=${unlock.body.token}`);
    expect(c1.status).toBe(200);
    expect(c1.body.content).toBe('# 你好\n\n世界');
    // view 2 via raw + password
    const raw = await t.req('/raw/hello-note?password=pw-1234');
    expect(raw.status).toBe(200);
    expect(raw.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(raw.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await raw.text()).toBe('# 你好\n\n世界');
    // limit reached
    const r3 = await t.req('/raw/hello-note?password=pw-1234');
    expect(r3.status).toBe(410);
    expect((await t.json('/api/public/shares/hello-note')).status).toBe(410);

    // admin can list and reset
    const list = await t.json('/api/shares', { token: t.token });
    expect(list.body[0]).toMatchObject({ slug: 'hello-note', views: 2, state: 'exhausted' });
    await t.json(`/api/shares/${created.body.id}/reset-views`, { method: 'POST', token: t.token });
    expect((await t.req('/raw/hello-note', { headers: { 'x-share-password': 'pw-1234' } })).status).toBe(200);
  });

  it('expiry and cleanup', async () => {
    const t = await setupWithLocal();
    const s = await t.json('/api/shares', { method: 'POST', token: t.token, body: { type: 'text', content: 'bye', expiresAt: Date.now() - 1000 } });
    expect(s.status).toBe(201);
    expect((await t.req(`/raw/${s.body.slug}`)).status).toBe(410);
    expect(await consumeExpiredShares(t.env)).toBe(1);
    expect((await t.req(`/raw/${s.body.slug}`)).status).toBe(404);
  });

  it('html text shares are neutralized to text/plain', async () => {
    const t = await setupWithLocal();
    const s = await t.json('/api/shares', { method: 'POST', token: t.token, body: { type: 'text', content: '<script>alert(1)</script>', contentType: 'text/html' } });
    const r = await t.req(`/raw/${s.body.slug}`);
    expect(r.headers.get('content-type')).toBe('text/plain; charset=utf-8');
  });

  it('file share streams with range support', async () => {
    const t = await setupWithLocal();
    await t.req('/api/upload/proxy?path=/local/docs/data.json', { method: 'PUT', token: t.token, body: '{"a":1,"b":2}', headers: { 'content-type': 'application/json' } });
    const s = await t.json('/api/shares', { method: 'POST', token: t.token, body: { type: 'file', storagePath: '/local/docs/data.json' } });
    expect(s.status).toBe(201);
    const meta = await t.json(`/api/public/shares/${s.body.slug}`);
    expect(meta.body).toMatchObject({ type: 'file', fileName: 'data.json', size: 13 });
    const r = await t.req(`/raw/${s.body.slug}`);
    expect(r.headers.get('content-type')).toContain('application/json');
    expect(await r.text()).toBe('{"a":1,"b":2}');
    const part = await t.req(`/raw/${s.body.slug}`, { headers: { range: 'bytes=1-3' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 1-3/13');
    expect(await part.text()).toBe('"a"');
    // missing files can't be shared
    const bad = await t.json('/api/shares', { method: 'POST', token: t.token, body: { type: 'file', storagePath: '/local/nope.bin' } });
    expect(bad.status).toBe(400);
  });

  it('read-only keys cannot create shares', async () => {
    const t = await setupWithLocal();
    const ro = await t.json('/api/admin/keys', { method: 'POST', token: t.token, body: { name: 'ro', permission: 'read' } });
    const r = await t.json('/api/shares', { method: 'POST', token: ro.body.key, body: { type: 'text', content: 'x' } });
    expect(r.status).toBe(403);
  });
});
