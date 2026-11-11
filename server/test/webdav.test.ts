import { describe, expect, it } from 'vitest';
import { parseMultistatus, WebDAVDriver } from '../src/storage/webdav';
import { davHref, davPathFromUrl, propfindXml } from '../src/webdav/server';
import { setupWithLocal } from './helpers';

const basic = (u: string, p: string) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');

describe('PROPFIND XML', () => {
  it('generates valid multistatus that our parser reads back', () => {
    const xml = propfindXml([
      { name: '', path: '/', isDir: true, size: 0 },
      { name: '報告 & notes', path: '/報告 & notes', isDir: true, size: 0, modified: Date.UTC(2026, 0, 2) },
      { name: 'a<b>.txt', path: '/報告 & notes/a<b>.txt', isDir: false, size: 42, etag: 'abc', modified: Date.UTC(2026, 0, 3), contentType: 'text/plain; charset=utf-8' },
    ]);
    expect(xml).toContain('<d:multistatus xmlns:d="DAV:">');
    expect(xml).toContain('<d:collection/>');
    expect(xml).toContain('&amp;');
    expect(xml).not.toContain('a<b>');
    expect(xml).toContain('<d:getcontenttype>text/plain</d:getcontenttype>');
    const parsed = parseMultistatus(xml);
    expect(parsed).toHaveLength(3);
    expect(parsed[1]).toMatchObject({ isDir: true, href: davHref('/報告 & notes', true) });
    expect(parsed[2]).toMatchObject({ isDir: false, size: 42, etag: 'abc', modified: Date.UTC(2026, 0, 3) });
    expect(davPathFromUrl(parsed[2].href)).toBe('/報告 & notes/a<b>.txt');
  });

  it('parses third-party (nextcloud style) multistatus', () => {
    const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
      <d:response><d:href>/remote.php/dav/files/me/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
      <d:response><d:href>/remote.php/dav/files/me/My%20File.pdf</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>1234</d:getcontentlength><d:getlastmodified>Tue, 10 Nov 2026 10:00:00 GMT</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
      <d:propstat><d:prop><oc:size/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>
    </d:multistatus>`;
    const p = parseMultistatus(xml);
    expect(p[0].isDir).toBe(true);
    expect(p[1]).toMatchObject({ isDir: false, size: 1234 });
  });
});

describe('WebDAV server (/dav)', () => {
  it('requires auth and supports the core methods', async () => {
    const t = await setupWithLocal();
    const key = (await t.json('/api/admin/keys', { method: 'POST', token: t.token, body: { name: 'dav', permission: 'readwrite' } })).body.key;
    const auth = { authorization: basic('anyone', key) };

    const opt = await t.req('/dav/', { method: 'OPTIONS' });
    expect(opt.headers.get('dav')).toContain('2');

    const unauth = await t.req('/dav/', { method: 'PROPFIND', headers: { depth: '1' } });
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get('www-authenticate')).toContain('Basic');

    const root = await t.req('/dav/', { method: 'PROPFIND', headers: { ...auth, depth: '1' } });
    expect(root.status).toBe(207);
    const rootItems = parseMultistatus(await root.text());
    expect(rootItems.map((i) => i.href)).toContain('/dav/local/');

    expect((await t.req('/dav/local/新資料夾', { method: 'MKCOL', headers: auth })).status).toBe(201);
    expect((await t.req('/dav/local/新資料夾', { method: 'MKCOL', headers: auth })).status).toBe(405);
    const put = await t.req('/dav/local/新資料夾/hello.txt', { method: 'PUT', headers: { ...auth, 'content-length': '11' }, body: 'hello world' });
    expect(put.status).toBe(201);

    const get = await t.req('/dav/local/%E6%96%B0%E8%B3%87%E6%96%99%E5%A4%BE/hello.txt', { headers: { ...auth, range: 'bytes=6-' } });
    expect(get.status).toBe(206);
    expect(await get.text()).toBe('world');

    const head = await t.req('/dav/local/新資料夾/hello.txt', { method: 'HEAD', headers: auth });
    expect(head.headers.get('content-length')).toBe('11');

    const pf = await t.req('/dav/local/新資料夾', { method: 'PROPFIND', headers: { ...auth, depth: '1' } });
    const items = parseMultistatus(await pf.text());
    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({ isDir: false, size: 11 });

    const lock = await t.req('/dav/local/新資料夾/hello.txt', { method: 'LOCK', headers: auth, body: '<?xml version="1.0"?><d:lockinfo xmlns:d="DAV:"><d:owner>me</d:owner></d:lockinfo>' });
    expect(lock.status).toBe(200);
    expect(lock.headers.get('lock-token')).toMatch(/^<opaquelocktoken:/);
    expect((await t.req('/dav/local/新資料夾/hello.txt', { method: 'UNLOCK', headers: { ...auth, 'lock-token': lock.headers.get('lock-token')! } })).status).toBe(204);

    const copy = await t.req('/dav/local/新資料夾/hello.txt', { method: 'COPY', headers: { ...auth, destination: 'http://localhost/dav/local/copy.txt' } });
    expect(copy.status).toBe(201);
    const noOverwrite = await t.req('/dav/local/新資料夾/hello.txt', { method: 'COPY', headers: { ...auth, destination: '/dav/local/copy.txt', overwrite: 'F' } });
    expect(noOverwrite.status).toBe(412);
    const move = await t.req('/dav/local/copy.txt', { method: 'MOVE', headers: { ...auth, destination: '/dav/local/moved.txt' } });
    expect(move.status).toBe(201);
    expect((await t.req('/dav/local/copy.txt', { headers: auth })).status).toBe(404);
    expect(await (await t.req('/dav/local/moved.txt', { headers: auth })).text()).toBe('hello world');
    expect((await t.req('/dav/local/moved.txt', { method: 'DELETE', headers: auth })).status).toBe(204);
    expect((await t.req('/dav/local/moved.txt', { method: 'DELETE', headers: auth })).status).toBe(404);
  });

  it('read-only keys cannot write; admin password works', async () => {
    const t = await setupWithLocal();
    const ro = (await t.json('/api/admin/keys', { method: 'POST', token: t.token, body: { name: 'ro', permission: 'read' } })).body.key;
    const r = await t.req('/dav/local/x.txt', { method: 'PUT', headers: { authorization: basic('u', ro), 'content-length': '1' }, body: 'x' });
    expect(r.status).toBe(403);
    const a = await t.req('/dav/local/x.txt', { method: 'PUT', headers: { authorization: basic('admin', 'password123'), 'content-length': '1' }, body: 'x' });
    expect(a.status).toBe(201);
  });

  it('WebDAV *client* driver works against our own server', async () => {
    const t = await setupWithLocal();
    const key = (await t.json('/api/admin/keys', { method: 'POST', token: t.token, body: { name: 'dav', permission: 'readwrite' } })).body.key;
    const fetchShim = ((input: any, init?: any) => {
      const u = new URL(typeof input === 'string' ? input : input.url);
      return t.app.request(u.pathname + u.search, init, t.env);
    }) as typeof fetch;
    const d = new WebDAVDriver({ url: 'http://edgedock.test/dav/local/', username: 'x', password: key }, { fetch: fetchShim });
    await d.test();
    await d.mkdir('/a/b');
    await d.write('/a/b/f 1.txt', 'abcdef', { size: 6 });
    const ls = await d.list('/a/b');
    expect(ls).toHaveLength(1);
    expect(ls[0]).toMatchObject({ name: 'f 1.txt', path: '/a/b/f 1.txt', size: 6, isDir: false });
    const st = await d.stat('/a');
    expect(st?.isDir).toBe(true);
    const rd = await d.read('/a/b/f 1.txt', { range: { start: 2, end: 3 } });
    expect(await new Response(rd.body).text()).toBe('cd');
    expect(rd.size).toBe(6);
    await d.copy('/a/b/f 1.txt', '/a/g.txt');
    await d.rename('/a/g.txt', '/a/h.txt');
    expect((await d.list('/a')).map((e) => e.name).sort()).toEqual(['b', 'h.txt']);
    await d.delete('/a');
    expect(await d.stat('/a')).toBeNull();
  });
});
