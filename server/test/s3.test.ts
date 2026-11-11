/**
 * S3 driver tests.
 *  1. SigV4 against the official AWS presigned-URL test vector (pure).
 *  2. URL building (path-style vs virtual-hosted).
 *  3. Integration against a real S3-protocol server: by default a local
 *     `moto` server (python -m moto.server) if available, or any endpoint
 *     given via S3_TEST_ENDPOINT / S3_TEST_KEY / S3_TEST_SECRET / S3_TEST_BUCKET
 *     (e.g. MinIO or R2). Skipped when neither is reachable.
 *     NOTE: moto does not strictly validate signatures, so (1) is what proves signing.
 */
import { AwsV4Signer } from 'aws4fetch';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { S3Driver } from '../src/storage/s3';
import { UploadService } from '../src/lib/uploads';
import { Vfs } from '../src/storage/mounts';
import { makeApp, makeEnv } from './helpers';
import { startS3, stopS3 } from './moto';

describe('SigV4 signing', () => {
  it('matches the AWS documentation presigned URL example', async () => {
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
    const signer = new AwsV4Signer({
      url: 'https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Expires=86400',
      method: 'GET',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      service: 's3',
      region: 'us-east-1',
      signQuery: true,
      datetime: '20130524T000000Z',
    });
    const signed = await signer.sign();
    expect(signed.url.searchParams.get('X-Amz-Signature')).toBe('aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
  });

  it('builds path-style and virtual-hosted URLs with encoded keys', async () => {
    const vh = new S3Driver({ endpoint: 'https://s3.us-east-1.amazonaws.com', bucket: 'b', accessKeyId: 'a', secretAccessKey: 's', region: 'us-east-1' });
    expect(vh.objectUrl('dir/a b+c.txt')).toBe('https://b.s3.us-east-1.amazonaws.com/dir/a%20b%2Bc.txt');
    const ps = new S3Driver({ endpoint: 'http://localhost:9000/', bucket: 'b', accessKeyId: 'a', secretAccessKey: 's', pathStyle: true, root: '/pre' });
    expect(ps.objectUrl(ps.key('/x/中文.md'))).toBe('http://localhost:9000/b/pre/x/%E4%B8%AD%E6%96%87.md');
    const url = (await ps.presignPut('/x/y.bin', { expiresIn: 600 })).url;
    expect(url).toContain('X-Amz-Expires=600');
    expect(url).toContain('X-Amz-Signature=');
    expect(url.startsWith('http://localhost:9000/b/pre/x/y.bin?')).toBe(true);
  });
});

// ---------------------------------------------------------------- integration
let endpoint = '';
let accessKeyId = '';
let secretAccessKey = '';
let bucket = '';
let available = false;

beforeAll(async () => {
  const r = await startS3();
  ({ endpoint, accessKeyId, secretAccessKey, bucket, available } = r);
}, 30000);

afterAll(() => stopS3());

describe('S3 driver against a live S3-protocol server', () => {
  const drv = () => new S3Driver({ endpoint, bucket, accessKeyId, secretAccessKey, region: 'us-east-1', pathStyle: true, root: '/edgedock' });

  it('CRUD, listing, range reads, copy/rename/delete', async (ctx) => {
    if (!available) return ctx.skip();
    const d = drv();
    await d.test();
    await d.mkdir('/docs');
    await d.write('/docs/hello world.txt', 'hello world', { size: 11, contentType: 'text/plain' });
    await d.write('/docs/sub/deep.txt', new TextEncoder().encode('deep'), { size: 4 });
    const stream = new Blob(['streamed body']).stream();
    await d.write('/docs/stream.txt', stream, { size: 13 });

    const ls = await d.list('/docs');
    expect(ls.map((e) => `${e.isDir ? 'd' : 'f'}:${e.name}`).sort()).toEqual(['d:sub', 'f:hello world.txt', 'f:stream.txt']);
    expect((await d.stat('/docs/hello world.txt'))?.size).toBe(11);
    expect((await d.stat('/docs/sub'))?.isDir).toBe(true);
    expect(await d.stat('/docs/missing')).toBeNull();

    const r = await d.read('/docs/hello world.txt', { range: { start: 6, end: 10 } });
    expect(r.range).toEqual({ start: 6, end: 10 });
    expect(r.size).toBe(11);
    expect(await new Response(r.body).text()).toBe('world');
    expect(await new Response((await d.read('/docs/stream.txt')).body).text()).toBe('streamed body');

    await d.copy('/docs', '/copy');
    expect((await d.list('/copy/sub')).map((e) => e.name)).toEqual(['deep.txt']);
    await d.rename('/copy/hello world.txt', '/copy/renamed.txt');
    expect(await d.stat('/copy/hello world.txt')).toBeNull();
    expect((await d.stat('/copy/renamed.txt'))?.size).toBe(11);
    await d.delete('/copy');
    expect(await d.stat('/copy')).toBeNull();
    expect((await d.stat('/docs/sub/deep.txt'))?.size).toBe(4);
  });

  it('presigned PUT from a "browser"', async (ctx) => {
    if (!available) return ctx.skip();
    const d = drv();
    const p = await d.presignPut('/presigned.txt', { contentType: 'text/plain' });
    const res = await fetch(p.url, { method: 'PUT', body: 'direct!', headers: p.headers });
    expect(res.ok).toBe(true);
    expect(await new Response((await d.read('/presigned.txt')).body).text()).toBe('direct!');
  });

  it('native multipart session: presigned part + proxied part, ETag recovered via ListParts', async (ctx) => {
    if (!available) return ctx.skip();
    const env = makeEnv();
    const { json } = makeApp(env);
    const setup = await json('/api/auth/setup', { method: 'POST', body: { username: 'admin', password: 'password123' } });
    const st = await json('/api/storages', {
      method: 'POST',
      token: setup.body.token,
      body: { name: 'S3', type: 's3', mountPath: '/s3', config: { endpoint, bucket, accessKeyId, secretAccessKey, region: 'us-east-1', pathStyle: true, root: '/mp' } },
    });
    expect(st.status).toBe(201);
    // secrets are encrypted at rest and not returned
    const row = await env.DB.prepare('SELECT config, secret FROM storages').first<{ config: string; secret: string }>();
    expect(row!.config).not.toContain(secretAccessKey === 'testing' ? 'secretAccessKey' : secretAccessKey);
    expect(row!.secret.startsWith('v1.')).toBe(true);

    const svc = new UploadService(env, await Vfs.create(env));
    const MiB = 1024 * 1024;
    const size = 5 * MiB + 1000;
    const data = new Uint8Array(size).map((_, i) => i % 256);
    const { session } = await svc.init({ path: '/s3/big.bin', size, partSize: 5 * MiB, createdBy: 'admin:1', ttlHours: 1 });
    expect(session.mode).toBe('native');
    expect(session.total_parts).toBe(2);
    // part 1 directly to S3 with a presigned URL; ETag "not exposed" -> ack without etag
    const { urls } = await svc.signParts(session.id, [1]);
    const put = await fetch(urls[1].url, { method: 'PUT', body: data.slice(0, 5 * MiB) });
    expect(put.ok).toBe(true);
    await svc.ackPart(session.id, 1, null, 5 * MiB);
    // part 2 through the worker
    await svc.uploadPart(session.id, 2, data.slice(5 * MiB), 1000);
    await svc.complete(session.id);
    const d = new S3Driver({ endpoint, bucket, accessKeyId, secretAccessKey, region: 'us-east-1', pathStyle: true, root: '/mp' });
    const back = new Uint8Array(await new Response((await d.read('/big.bin')).body).arrayBuffer());
    expect(back.byteLength).toBe(size);
    expect(Buffer.compare(Buffer.from(back), Buffer.from(data))).toBe(0);
  }, 60000);

  it('abort multipart', async (ctx) => {
    if (!available) return ctx.skip();
    const d = drv();
    const id = (await d.multipart.create('/aborted.bin', {})) as string;
    await d.multipart.abort('/aborted.bin', id);
    expect(await d.stat('/aborted.bin')).toBeNull();
  });
});
