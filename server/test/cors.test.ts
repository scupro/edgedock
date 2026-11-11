import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { corsInstructions, detectProvider, evaluateRules } from '../src/lib/bucketcors';
import { matchOrigin, parseCorsOrigins } from '../src/lib/cors';
import { S3Driver } from '../src/storage/s3';
import { makeApp, makeEnv, setupWithLocal } from './helpers';
import { s3, startS3, stopS3 } from './moto';

describe('CORS origin policy', () => {
  it('exact, wildcard sub-domain, wildcard port and *', () => {
    const p = parseCorsOrigins('https://app.example.com, https://*.preview.dev ,http://localhost:*');
    expect(matchOrigin(p, 'https://app.example.com')).toEqual({ allow: 'https://app.example.com', credentials: true });
    expect(matchOrigin(p, 'https://a.b.preview.dev')?.allow).toBe('https://a.b.preview.dev');
    expect(matchOrigin(p, 'https://preview.dev')).toBeNull();
    expect(matchOrigin(p, 'https://evil-preview.dev')).toBeNull();
    expect(matchOrigin(p, 'http://localhost:5173')?.allow).toBe('http://localhost:5173');
    expect(matchOrigin(p, 'http://localhost')?.allow).toBe('http://localhost');
    expect(matchOrigin(p, 'https://evil.com')).toBeNull();
    const any = parseCorsOrigins('*');
    expect(matchOrigin(any, 'https://x.com')).toEqual({ allow: '*', credentials: false });
    expect(matchOrigin(parseCorsOrigins('*', 'true'), 'https://x.com')).toEqual({ allow: 'https://x.com', credentials: true });
    expect(matchOrigin(parseCorsOrigins('https://a.com', 'false'), 'https://a.com')?.credentials).toBe(false);
  });
});

describe('CORS middleware', () => {
  it('answers preflight before auth on /api and /dav, with max-age and reflected headers', async () => {
    const env = makeEnv({ CORS_ORIGINS: 'https://ui.example.com', CORS_MAX_AGE: '600' });
    const { req } = makeApp(env);
    const r = await req('/api/fs/list?path=/', {
      method: 'OPTIONS',
      headers: { origin: 'https://ui.example.com', 'access-control-request-method': 'PUT', 'access-control-request-headers': 'authorization, content-md5' },
    });
    expect(r.status).toBe(204);
    expect(r.headers.get('access-control-allow-origin')).toBe('https://ui.example.com');
    expect(r.headers.get('access-control-allow-credentials')).toBe('true');
    expect(r.headers.get('access-control-allow-methods')).toContain('PUT');
    expect(r.headers.get('access-control-allow-headers')).toBe('authorization, content-md5');
    expect(r.headers.get('access-control-max-age')).toBe('600');
    expect(r.headers.get('vary')).toContain('Origin');

    const dav = await req('/dav/x', { method: 'OPTIONS', headers: { origin: 'https://ui.example.com', 'access-control-request-method': 'PROPFIND', 'access-control-request-headers': 'depth' } });
    expect(dav.status).toBe(204);
    expect(dav.headers.get('access-control-allow-methods')).toContain('PROPFIND');

    const bad = await req('/api/fs/list', { method: 'OPTIONS', headers: { origin: 'https://evil.com', 'access-control-request-method': 'GET' } });
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('plain WebDAV OPTIONS keeps DAV semantics and gets CORS headers', async () => {
    const env = makeEnv({ CORS_ORIGINS: '*' });
    const { req } = makeApp(env);
    const r = await req('/dav/', { method: 'OPTIONS', headers: { origin: 'https://x.com' } });
    expect(r.headers.get('dav')).toBe('1, 2');
    expect(r.headers.get('allow')).toContain('PROPFIND');
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    expect(r.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('exposes ETag / Content-Range / Accept-Ranges on actual responses, also on errors', async () => {
    const t = await setupWithLocal();
    t.env.CORS_ORIGINS = 'https://ui.example.com';
    await t.req('/api/upload/proxy?path=/local/a.txt', { method: 'PUT', token: t.token, body: '0123456789' });
    const r = await t.req('/api/fs/list?path=/local', { token: t.token, headers: { origin: 'https://ui.example.com' } });
    expect(r.headers.get('access-control-allow-origin')).toBe('https://ui.example.com');
    const expose = r.headers.get('access-control-expose-headers')!;
    for (const h of ['ETag', 'Content-Range', 'Content-Length', 'Accept-Ranges', 'Location', 'DAV']) expect(expose).toContain(h);
    const unauth = await t.req('/api/fs/list?path=/local', { headers: { origin: 'https://ui.example.com', authorization: 'Bearer nope' } });
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get('access-control-allow-origin')).toBe('https://ui.example.com');
  });
});

describe('bucket CORS helpers', () => {
  it('detects providers and evaluates rules', () => {
    expect(detectProvider('abc.r2.cloudflarestorage.com')).toBe('r2');
    expect(detectProvider('s3.us-west-004.backblazeb2.com')).toBe('b2');
    expect(detectProvider('oss-cn-hangzhou.aliyuncs.com')).toBe('oss');
    expect(detectProvider('cos.ap-guangzhou.myqcloud.com')).toBe('cos');
    expect(detectProvider('minio:9000', 'minio')).toBe('minio');
    const rules = [{ allowedOrigins: ['https://*.example.com'], allowedMethods: ['GET', 'PUT'], allowedHeaders: ['*'], exposeHeaders: ['ETag'] }];
    expect(evaluateRules(rules, 'https://ui.example.com')).toEqual({ allowsPut: true, allowsGet: true, exposesEtag: true });
    expect(evaluateRules(rules, 'https://evil.com').allowsPut).toBe(false);
    expect(corsInstructions('minio', 'https://ui.example.com', 'b').zh).toContain('MINIO_API_CORS_ALLOW_ORIGIN');
    expect(corsInstructions('r2', 'https://ui.example.com', 'b').zh).toContain('CORS 原則');
  });
});

describe('一鍵設定 CORS against S3 (moto)', () => {
  beforeAll(async () => {
    await startS3('edgedock-cors');
  }, 30000);
  afterAll(() => stopS3());

  it('PutBucketCors / GetBucketCors / check / probe', async (ctx) => {
    if (!s3.available) return ctx.skip();
    const env = makeEnv();
    const t = makeApp(env);
    const token = (await t.json('/api/auth/setup', { method: 'POST', body: { username: 'admin', password: 'password123' } })).body.token;
    const cfg = { endpoint: s3.endpoint, bucket: 'edgedock-cors', accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey, region: 'us-east-1', pathStyle: true, provider: 'minio' };
    const st = await t.json('/api/storages', { method: 'POST', token, body: { name: 'S3', type: 's3', mountPath: '/s3', config: cfg } });
    const origin = 'https://ui.example.com';

    const before = await t.json(`/api/storages/${st.body.id}/cors/check`, { method: 'POST', token, body: { origin } });
    expect(before.status).toBe(200);
    expect(before.body.origin).toBe(origin);
    expect(before.body.instructions.zh).toBeTruthy();

    const applied = await t.json(`/api/storages/${st.body.id}/cors/apply`, { method: 'POST', token, body: { origin } });
    expect(applied.status).toBe(200);
    expect(applied.body.applied).toBe(true);
    expect(applied.body.evaluation).toEqual({ allowsPut: true, allowsGet: true, exposesEtag: true });

    const d = new S3Driver(cfg);
    const rules = await d.getBucketCors();
    expect(rules[0].allowedOrigins).toEqual([origin]);
    expect(rules[0].exposeHeaders).toContain('ETag');
    // re-applying for another origin keeps the first rule
    await d.putBucketCors(['https://other.example.com']);
    expect((await d.getBucketCors()).flatMap((r) => r.allowedOrigins).sort()).toEqual(['https://other.example.com', origin]);

    const probe = await t.json(`/api/storages/${st.body.id}/cors/probe`, { method: 'POST', token });
    expect(probe.body.key).toMatch(/^\/\.edgedock-uploads\/cors-probe-/);
    const put = await fetch(probe.body.url, { method: 'PUT', body: 'probe', headers: probe.body.headers });
    expect(put.ok).toBe(true);
    const clean = await t.json(`/api/storages/${st.body.id}/cors/probe/cleanup`, { method: 'POST', token, body: { key: probe.body.key } });
    expect(clean.body.ok).toBe(true);
    expect(await d.stat(probe.body.key)).toBeNull();
    const evil = await t.json(`/api/storages/${st.body.id}/cors/probe/cleanup`, { method: 'POST', token, body: { key: '/important.txt' } });
    expect(evil.status).toBe(400);
  }, 60000);
});
