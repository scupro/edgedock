/**
 * In-memory fakes of the provider HTTP APIs used by the Phase 2 drivers (mocked fetch).
 * Each fake records calls and supports a few injected faults (429, 401, expired URLs).
 */
const enc = new TextEncoder();

export function json(v: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json', ...headers } });
}

export function rangeResponse(data: Uint8Array, rangeH: string | null, extra: Record<string, string> = {}): Response {
  if (rangeH) {
    const m = /bytes=(\d+)-(\d*)/.exec(rangeH)!;
    const s = Number(m[1]);
    const e = m[2] ? Math.min(Number(m[2]), data.length - 1) : data.length - 1;
    return new Response(data.slice(s, e + 1), { status: 206, headers: { 'content-range': `bytes ${s}-${e}/${data.length}`, ...extra } });
  }
  return new Response(data.slice(), { status: 200, headers: { 'content-length': String(data.length), ...extra } });
}

export interface Fake {
  fetch: typeof fetch;
  calls: string[];
}

function wrap(handler: (req: Request, u: URL) => Promise<Response>, calls: string[]): typeof fetch {
  const run = async (req: Request, hops = 0): Promise<Response> => {
    const u = new URL(req.url);
    calls.push(`${req.method} ${u.host}${u.pathname}`);
    const res = await handler(req, u);
    // emulate fetch's redirect following (Authorization dropped on cross-origin hops)
    const loc = res.headers.get('location');
    if ([301, 302, 303, 307, 308].includes(res.status) && loc && req.redirect !== 'manual' && hops < 5 && !(res.status === 308 && u.host === 'www.googleapis.com')) {
      const next = new URL(loc, u);
      const h = new Headers(req.headers);
      if (next.origin !== u.origin) h.delete('authorization');
      return run(new Request(next, { method: 'GET', headers: h }), hops + 1);
    }
    return res;
  };
  return (async (input: RequestInfo | URL, init?: RequestInit) => run(new Request(input as RequestInfo, init))) as typeof fetch;
}

const concat = (a: Uint8Array, b: Uint8Array) => {
  const o = new Uint8Array(a.length + b.length);
  o.set(a);
  o.set(b, a.length);
  return o;
};

// ---------------------------------------------------------------- OneDrive (Graph)
export function oneDriveFake() {
  interface It {
    id: string;
    dir: boolean;
    data?: Uint8Array;
  }
  const items = new Map<string, It>([['/', { id: 'root', dir: true }]]);
  const sessions = new Map<string, { path: string; size: number; data: Uint8Array }>();
  const state = { tokenN: 0, refreshSeen: [] as string[], fail429: 0, revokeAccess: false };
  let ids = 0;
  const calls: string[] = [];
  const parent = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/';
  const name = (p: string) => p.slice(p.lastIndexOf('/') + 1);
  const itemJson = (p: string, it: It) => ({
    id: it.id,
    name: p === '/' ? 'root' : name(p),
    size: it.data?.length ?? 0,
    ...(it.dir ? { folder: { childCount: 0 } } : { file: { mimeType: 'application/octet-stream' }, '@microsoft.graph.downloadUrl': `https://dl.fake/${it.id}` }),
    lastModifiedDateTime: '2026-01-01T00:00:00Z',
    eTag: `e-${it.id}`,
    parentReference: { driveId: 'd1', id: items.get(parent(p))?.id },
  });
  const pathOfId = (id: string) => [...items.entries()].find(([, v]) => v.id === id)?.[0];
  const fetch = wrap(async (req, u) => {
    if (u.pathname.endsWith('/oauth2/v2.0/token')) {
      const form = new URLSearchParams(await req.text());
      state.refreshSeen.push(form.get('refresh_token') ?? form.get('code') ?? '');
      state.tokenN++;
      return json({ access_token: `at${state.tokenN}`, refresh_token: `rt${state.tokenN}`, expires_in: 3600 });
    }
    if (u.host === 'dl.fake') {
      const p = pathOfId(u.pathname.slice(1));
      if (!p) return new Response('', { status: 404 });
      return rangeResponse(items.get(p)!.data!, req.headers.get('range'));
    }
    if (u.host === 'upload.fake') {
      const id = u.pathname.slice(1);
      const s = sessions.get(id);
      if (!s) return json({ error: { message: 'gone' } }, 404);
      if (req.method === 'DELETE') {
        sessions.delete(id);
        return new Response(null, { status: 204 });
      }
      if (req.method === 'GET') return json({ nextExpectedRanges: [`${s.data.length}-`] });
      if (req.headers.get('authorization')) return json({ error: { message: 'no auth on upload urls' } }, 400);
      const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(req.headers.get('content-range') ?? '')!;
      const start = Number(m[1]);
      if (start !== s.data.length) return json({ error: { message: 'out of order' } }, 416);
      s.data = concat(s.data, new Uint8Array(await req.arrayBuffer()));
      if (s.data.length === s.size) {
        items.set(s.path, { id: `i${++ids}`, dir: false, data: s.data });
        sessions.delete(id);
        return json(itemJson(s.path, items.get(s.path)!), 201);
      }
      return json({ nextExpectedRanges: [`${s.data.length}-`] }, 202);
    }
    // graph
    if (state.revokeAccess || req.headers.get('authorization') !== `Bearer at${state.tokenN}`) {
      state.revokeAccess = false;
      return json({ error: { code: 'InvalidAuthenticationToken', message: 'expired' } }, 401);
    }
    if (state.fail429 > 0) {
      state.fail429--;
      return json({ error: { message: 'throttled' } }, 429, { 'retry-after': '0' });
    }
    let rest = decodeURIComponent(u.pathname.replace('/v1.0/me/drive', ''));
    if (rest === '') return json({ id: 'd1', driveType: 'personal' });
    rest = rest.replace(/^\/root/, '');
    let p = '/';
    let suffix = rest;
    if (rest.startsWith(':')) {
      const s = rest.slice(1);
      const i = s.indexOf(':');
      p = i < 0 ? s : s.slice(0, i);
      suffix = i < 0 ? '' : s.slice(i + 1);
    }
    const it = items.get(p);
    if (req.method === 'GET' && suffix === '') return it ? json(itemJson(p, it)) : json({ error: { message: 'itemNotFound' } }, 404);
    if (req.method === 'GET' && suffix === '/children') {
      if (!it) return json({ error: { message: 'itemNotFound' } }, 404);
      const kids = [...items.entries()].filter(([k]) => k !== '/' && parent(k) === p).map(([k, v]) => itemJson(k, v));
      const skip = Number(u.searchParams.get('$skiptoken') ?? 0);
      const page = kids.slice(skip, skip + 2);
      const next = skip + 2 < kids.length ? `https://graph.microsoft.com/v1.0/me/drive/root${p === '/' ? '' : ':' + p + ':'}/children?$skiptoken=${skip + 2}` : undefined;
      return json({ value: page, '@odata.nextLink': next });
    }
    if (req.method === 'PUT' && suffix === '/content') {
      items.set(p, { id: `i${++ids}`, dir: false, data: new Uint8Array(await req.arrayBuffer()) });
      return json(itemJson(p, items.get(p)!), 201);
    }
    if (req.method === 'POST' && suffix === '/createUploadSession') {
      const sid = `s${++ids}`;
      sessions.set(sid, { path: p, size: -1, data: new Uint8Array(0) });
      // size is learned from the first Content-Range
      const s = sessions.get(sid)!;
      Object.defineProperty(s, 'size', { get: () => sizes.get(sid) ?? Infinity });
      return json({ uploadUrl: `https://upload.fake/${sid}` });
    }
    if (req.method === 'POST' && suffix === '/children') {
      const b = (await req.json()) as { name: string };
      const np = (p === '/' ? '' : p) + '/' + b.name;
      if (items.has(np)) return json({ error: { code: 'nameAlreadyExists', message: 'exists' } }, 409);
      items.set(np, { id: `i${++ids}`, dir: true });
      return json(itemJson(np, items.get(np)!), 201);
    }
    if (req.method === 'DELETE') {
      if (!it) return json({}, 404);
      for (const k of [...items.keys()]) if (k === p || k.startsWith(p + '/')) items.delete(k);
      return new Response(null, { status: 204 });
    }
    if (req.method === 'PATCH') {
      const b = (await req.json()) as { name: string; parentReference: { id: string } };
      const np = ((pathOfId(b.parentReference.id) ?? '/') === '/' ? '' : pathOfId(b.parentReference.id)) + '/' + b.name;
      for (const [k, v] of [...items.entries()])
        if (k === p || k.startsWith(p + '/')) {
          items.delete(k);
          items.set(np + k.slice(p.length), v);
        }
      return json(itemJson(np, items.get(np)!));
    }
    return json({ error: { message: `unhandled ${req.method} ${u.pathname}` } }, 500);
  }, calls);
  // capture total sizes from Content-Range of the first chunk
  const sizes = new Map<string, number>();
  const outer = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as RequestInfo, init);
    const u = new URL(req.url);
    if (u.host === 'upload.fake' && req.method === 'PUT') {
      const m = /\/(\d+)$/.exec(req.headers.get('content-range') ?? '');
      if (m) sizes.set(u.pathname.slice(1), Number(m[1]));
    }
    return fetch(req);
  }) as typeof globalThis.fetch;
  return { fetch: outer, calls, items, sessions, state };
}

// ---------------------------------------------------------------- Google Drive
export function gdriveFake(opts: { publicKey?: CryptoKey } = {}) {
  interface F {
    id: string;
    name: string;
    parent: string;
    mimeType: string;
    data?: Uint8Array;
  }
  const files = new Map<string, F>();
  const sessions = new Map<string, { meta: { name: string; parents?: string[] }; fileId?: string; size: number; data: Uint8Array; mime: string }>();
  const calls: string[] = [];
  const state = { tokens: 0, jwtOk: 0 };
  let ids = 0;
  const FOLDER = 'application/vnd.google-apps.folder';
  const meta = (f: F) => ({ id: f.id, name: f.name, mimeType: f.mimeType, size: f.data ? String(f.data.length) : undefined, parents: [f.parent], modifiedTime: '2026-01-01T00:00:00Z' });
  const fetch = wrap(async (req, u) => {
    if (u.host === 'oauth2.googleapis.com') {
      const form = new URLSearchParams(await req.text());
      if (form.get('grant_type') === 'urn:ietf:params:oauth:grant-type:jwt-bearer') {
        const [h, p, s] = form.get('assertion')!.split('.');
        const dec = (x: string) => Uint8Array.from(atob(x.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((x.length + 3) % 4)), (c) => c.charCodeAt(0));
        const ok = opts.publicKey ? await crypto.subtle.verify('RSASSA-PKCS1-v1_5', opts.publicKey, dec(s), enc.encode(`${h}.${p}`)) : true;
        if (!ok) return json({ error: 'invalid_grant' }, 400);
        state.jwtOk++;
      }
      state.tokens++;
      return json({ access_token: `g${state.tokens}`, expires_in: 3600 });
    }
    if (req.headers.get('authorization') !== `Bearer g${state.tokens}`) return json({ error: { message: 'auth' } }, 401);
    const path = u.pathname;
    if (path === '/upload/drive/v3/files' && u.searchParams.get('upload_id')) {
      const s = sessions.get(u.searchParams.get('upload_id')!)!;
      const cr = req.headers.get('content-range')!;
      if (/^bytes \*\//.test(cr)) {
        if (s.data.length === s.size) return json({ id: s.fileId });
        return new Response(null, { status: 308, headers: s.data.length ? { range: `bytes=0-${s.data.length - 1}` } : {} });
      }
      const start = Number(/bytes (\d+)-/.exec(cr)![1]);
      if (start !== s.data.length) return json({ error: { message: 'bad offset' } }, 400);
      s.data = concat(s.data, new Uint8Array(await req.arrayBuffer()));
      if (s.data.length < s.size) return new Response(null, { status: 308, headers: { range: `bytes=0-${s.data.length - 1}` } });
      const f: F = s.fileId ? { ...files.get(s.fileId)!, data: s.data } : { id: `f${++ids}`, name: s.meta.name, parent: s.meta.parents![0], mimeType: s.mime, data: s.data };
      files.set(f.id, f);
      s.fileId = f.id;
      return json(meta(f));
    }
    if (path.startsWith('/upload/drive/v3/files')) {
      const fileId = path.split('/')[5];
      if (u.searchParams.get('uploadType') === 'resumable') {
        const sid = `u${++ids}`;
        sessions.set(sid, { meta: (await req.json()) as { name: string }, fileId, size: Number(req.headers.get('x-upload-content-length')), data: new Uint8Array(0), mime: req.headers.get('x-upload-content-type') ?? '' });
        return new Response(null, { status: 200, headers: { location: `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=${sid}` } });
      }
      // multipart/related
      const ct = req.headers.get('content-type')!;
      const boundary = /boundary=(\S+)/.exec(ct)![1];
      const raw = new Uint8Array(await req.arrayBuffer());
      const text = new TextDecoder('latin1').decode(raw);
      const parts = text.split(`--${boundary}`);
      const metaJson = JSON.parse(parts[1].split('\r\n\r\n')[1].trim());
      const headEnd = text.indexOf('\r\n\r\n', text.indexOf(`--${boundary}`, 10)) + 4;
      const tailStart = text.lastIndexOf(`\r\n--${boundary}--`);
      const data = raw.slice(headEnd, tailStart);
      const f: F = fileId ? { ...files.get(fileId)!, data } : { id: `f${++ids}`, name: metaJson.name, parent: metaJson.parents[0], mimeType: 'application/octet-stream', data };
      files.set(f.id, f);
      return json(meta(f));
    }
    if (path === '/drive/v3/files' && req.method === 'GET') {
      const q = u.searchParams.get('q')!;
      const pm = /'([^']+)' in parents/.exec(q)!;
      const nm = /name = '((?:[^'\\]|\\.)*)'/.exec(q);
      const list = [...files.values()].filter((f) => f.parent === pm[1] && (!nm || f.name === nm[1].replace(/\\(.)/g, '$1')));
      return json({ files: list.map(meta) });
    }
    if (path === '/drive/v3/files' && req.method === 'POST') {
      const b = (await req.json()) as { name: string; parents: string[]; mimeType: string };
      const f: F = { id: `f${++ids}`, name: b.name, parent: b.parents[0], mimeType: b.mimeType };
      files.set(f.id, f);
      return json(meta(f));
    }
    const m = /^\/drive\/v3\/files\/([^/]+)(\/copy)?$/.exec(path);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (id === 'root' && req.method === 'GET') return json({ id: 'root', mimeType: FOLDER });
      const f = files.get(id);
      if (!f) return json({ error: { message: 'notFound' } }, 404);
      if (req.method === 'GET') return u.searchParams.get('alt') === 'media' ? rangeResponse(f.data!, req.headers.get('range')) : json(meta(f));
      if (req.method === 'DELETE') {
        const del = (x: string) => {
          files.delete(x);
          for (const c of [...files.values()]) if (c.parent === x) del(c.id);
        };
        del(id);
        return new Response(null, { status: 204 });
      }
      if (req.method === 'PATCH') {
        const b = (await req.json()) as { name?: string };
        if (b.name) f.name = b.name;
        if (u.searchParams.get('addParents')) f.parent = u.searchParams.get('addParents')!;
        return json(meta(f));
      }
      if (m[2]) {
        const b = (await req.json()) as { name: string; parents: string[] };
        const c: F = { ...f, id: `f${++ids}`, name: b.name, parent: b.parents[0] };
        files.set(c.id, c);
        return json(meta(c));
      }
    }
    return json({ error: { message: `unhandled ${req.method} ${path}` } }, 500);
  }, calls);
  return { fetch, calls, files, state };
}

// ---------------------------------------------------------------- Telegram Bot API
export function telegramFake() {
  const msgs = new Map<number, { fileId: string; data: Uint8Array }>();
  const calls: string[] = [];
  const state = { fail429: 1, deleted: [] as number[], downloads: 0 };
  let n = 0;
  const fetch = wrap(async (req, u) => {
    const m = /^\/bot([^/]+)\/(\w+)$/.exec(u.pathname);
    if (m) {
      if (m[1] !== 'TOKEN') return json({ ok: false, error_code: 401, description: 'Unauthorized' }, 401);
      const method = m[2];
      if (method === 'getMe') return json({ ok: true, result: { id: 1, is_bot: true } });
      if (method === 'getChat') return json({ ok: true, result: { id: -100 } });
      if (method === 'sendDocument') {
        if (state.fail429 > 0) {
          state.fail429--;
          return json({ ok: false, error_code: 429, description: 'Too Many Requests: retry after 0', parameters: { retry_after: 0 } }, 429);
        }
        const fd = await req.formData();
        const doc = fd.get('document') as File;
        const data = new Uint8Array(await doc.arrayBuffer());
        if (data.length > 50 * 1000 * 1000) return json({ ok: false, error_code: 413, description: 'Request Entity Too Large' }, 413);
        const id = ++n;
        msgs.set(id, { fileId: `F${id}`, data });
        return json({ ok: true, result: { message_id: id, document: { file_id: `F${id}`, file_size: data.length } } });
      }
      const b = (await req.json()) as { file_id?: string; message_id?: number };
      if (method === 'getFile') {
        const e = [...msgs.entries()].find(([, v]) => v.fileId === b.file_id);
        if (!e) return json({ ok: false, error_code: 400, description: 'Bad Request: invalid file_id' }, 400);
        if (e[1].data.length > 20 * 1000 * 1000) return json({ ok: false, error_code: 400, description: 'Bad Request: file is too big' }, 400);
        return json({ ok: true, result: { file_id: b.file_id, file_path: `documents/file_${e[0]}` } });
      }
      if (method === 'deleteMessage') {
        state.deleted.push(b.message_id!);
        msgs.delete(b.message_id!);
        return json({ ok: true, result: true });
      }
    }
    const f = /^\/file\/botTOKEN\/documents\/file_(\d+)$/.exec(u.pathname);
    if (f) {
      state.downloads++;
      const e = msgs.get(Number(f[1]));
      return e ? rangeResponse(e.data, req.headers.get('range')) : new Response('', { status: 404 });
    }
    return json({ ok: false, description: 'unhandled ' + u.pathname }, 404);
  }, calls);
  return { fetch, calls, msgs, state };
}

// ---------------------------------------------------------------- Discord
export function discordFake() {
  const msgs = new Map<string, { att: string; name: string; data: Uint8Array; ex: number }>();
  const calls: string[] = [];
  const state = { fail429: 1, refreshes: 0, expireNew: true };
  let n = 100;
  const url = (mid: string) => {
    const m = msgs.get(mid)!;
    return `https://cdn.discordapp.com/attachments/C1/${m.att}/${m.name}?ex=${Math.floor(m.ex / 1000).toString(16)}&is=0&hm=sig`;
  };
  const fetch = wrap(async (req, u) => {
    if (u.host === 'cdn.discordapp.com') {
      const [, , , att] = u.pathname.split('/');
      const e = [...msgs.values()].find((x) => x.att === att);
      const ex = parseInt(u.searchParams.get('ex') ?? '0', 16) * 1000;
      if (!e || ex < Date.now() || ex !== Math.floor(e.ex / 1000) * 1000) return new Response('This content is no longer available.', { status: 404 });
      return rangeResponse(e.data, req.headers.get('range'));
    }
    if (req.headers.get('authorization') !== 'Bot DTOKEN') return json({ message: '401: Unauthorized', code: 0 }, 401);
    const m = /^\/api\/v10\/channels\/(\w+)(?:\/messages(?:\/(\w+))?)?$/.exec(u.pathname);
    if (!m) return json({ message: 'unhandled' }, 404);
    if (!u.pathname.includes('/messages')) return json({ id: m[1], type: 0 });
    if (req.method === 'POST') {
      if (state.fail429 > 0) {
        state.fail429--;
        return json({ message: 'You are being rate limited.', retry_after: 0.01, global: false }, 429);
      }
      const fd = await req.formData();
      const file = fd.get('files[0]') as File;
      const data = new Uint8Array(await file.arrayBuffer());
      if (data.length > 10 * 1024 * 1024) return json({ message: 'Request entity too large', code: 40005 }, 413);
      const id = String(++n);
      // new uploads get an already-expired URL so the driver must refresh it on read
      msgs.set(id, { att: `A${id}`, name: file.name, data, ex: state.expireNew ? Date.now() - 1000 : Date.now() + 86400_000 });
      return json({ id, attachments: [{ id: `A${id}`, filename: file.name, size: data.length, url: url(id) }] });
    }
    const mid = m[2]!;
    const e = msgs.get(mid);
    if (!e) return json({ message: 'Unknown Message', code: 10008 }, 404);
    if (req.method === 'DELETE') {
      msgs.delete(mid);
      return new Response(null, { status: 204 });
    }
    // GET message: refreshed signed URL
    state.refreshes++;
    e.ex = Date.now() + 86400_000;
    return json({ id: mid, attachments: [{ id: e.att, filename: e.name, size: e.data.length, url: url(mid) }] });
  }, calls);
  return { fetch, calls, msgs, state };
}

// ---------------------------------------------------------------- HuggingFace Hub
export function hfFake(repo = 'me/data', kind = 'datasets') {
  const files = new Map<string, { data: Uint8Array; lfs?: string }>();
  const lfsStore = new Map<string, Uint8Array>();
  const calls: string[] = [];
  const commits: { summary: string; ops: { key: string; value: Record<string, unknown> }[] }[] = [];
  const sha256 = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource))].map((x) => x.toString(16).padStart(2, '0')).join('');
  const entry = (p: string) => {
    const f = files.get(p);
    if (f) return { type: 'file', path: p, size: f.lfs ? 134 : f.data.length, oid: 'git' + p.length, ...(f.lfs ? { lfs: { oid: f.lfs, size: f.data.length } } : {}) };
    return { type: 'directory', path: p, oid: 'tree' };
  };
  const dirs = () => {
    const s = new Set<string>();
    for (const p of files.keys()) {
      const parts = p.split('/');
      for (let i = 1; i < parts.length; i++) s.add(parts.slice(0, i).join('/'));
    }
    return s;
  };
  const fetch = wrap(async (req, u) => {
    const api = `/api/${kind}/${repo}`;
    if (u.host === 'cdn.fake') {
      const f = files.get(decodeURIComponent(u.pathname.slice(1)));
      return f ? rangeResponse(f.data, req.headers.get('range')) : new Response('', { status: 404 });
    }
    if (u.host === 'lfs.fake') {
      const oid = u.pathname.slice(1);
      const data = new Uint8Array(await req.arrayBuffer());
      if ((await sha256(data)) !== oid) return new Response('bad oid', { status: 400 });
      lfsStore.set(oid, data);
      return new Response(null, { status: 200 });
    }
    const p = decodeURIComponent(u.pathname);
    if (p.startsWith(`${api}/tree/main`)) {
      const dir = p.slice(`${api}/tree/main`.length).replace(/^\//, '');
      if (dir && !dirs().has(dir)) return json({ error: 'not found' }, 404);
      const all = [...new Set([...files.keys(), ...dirs()])].filter((x) => (u.searchParams.get('recursive') ? x.startsWith(dir ? dir + '/' : '') : (x.slice(0, x.lastIndexOf('/') < 0 ? 0 : x.lastIndexOf('/'))) === dir)).sort();
      const cursor = Number(u.searchParams.get('cursor') ?? 0);
      const page = all.slice(cursor, cursor + 3);
      const headers: Record<string, string> = cursor + 3 < all.length ? { link: `<https://huggingface.co${api}/tree/main${dir ? '/' + dir : ''}?cursor=${cursor + 3}>; rel="next"` } : {};
      return json(page.map(entry), 200, headers);
    }
    if (p === `${api}/paths-info/main`) {
      const form = new URLSearchParams(await req.text());
      return json(form.getAll('paths').filter((x) => files.has(x) || dirs().has(x)).map(entry));
    }
    if (p === `${api}/revision/main`) return json({ id: repo, sha: 'abc' });
    if (p === `${api}/preupload/main`) {
      const b = (await req.json()) as { files: { path: string }[] };
      return json({ files: b.files.map((f) => ({ path: f.path, uploadMode: f.path.endsWith('.bin') ? 'lfs' : 'regular' })) });
    }
    if (p === `/${kind}/${repo}.git/info/lfs/objects/batch`) {
      const b = (await req.json()) as { objects: { oid: string; size: number }[] };
      return json({ transfer: 'basic', objects: b.objects.map((o) => (lfsStore.has(o.oid) ? { ...o } : { ...o, actions: { upload: { href: `https://lfs.fake/${o.oid}`, header: {} } } })) });
    }
    if (p === `${api}/commit/main`) {
      if (req.headers.get('authorization') !== 'Bearer HFTOKEN') return json({ error: 'unauthorized' }, 401);
      const lines = (await req.text()).split('\n').map((l) => JSON.parse(l));
      const ops = lines.slice(1);
      for (const o of ops) {
        const v = o.value;
        if (o.key === 'file') files.set(v.path, { data: Uint8Array.from(atob(v.content), (c) => c.charCodeAt(0)) });
        else if (o.key === 'lfsFile') {
          const data = lfsStore.get(v.oid);
          if (!data) return json({ error: `lfs object ${v.oid} missing` }, 400);
          files.set(v.path, { data, lfs: v.oid });
        } else if (o.key === 'deletedFile') files.delete(v.path);
        else if (o.key === 'deletedFolder') for (const k of [...files.keys()]) if (k.startsWith(v.path)) files.delete(k);
      }
      commits.push({ summary: lines[0].value.summary, ops });
      return json({ commitOid: 'c' + commits.length });
    }
    const r = new RegExp(`^/${kind}/${repo}/resolve/main/(.+)$`).exec(p);
    if (r) {
      if (!files.has(r[1])) return new Response('', { status: 404 });
      return new Response(null, { status: 302, headers: { location: `https://cdn.fake/${encodeURIComponent(r[1])}` } });
    }
    return json({ error: `unhandled ${req.method} ${p}` }, 500);
  }, calls);
  return { fetch, calls, files, lfsStore, commits };
}

// ---------------------------------------------------------------- GitHub
export function githubFake() {
  const tree: Record<string, string | null> = { 'README.md': '# hello\n', 'src/a.ts': 'export const a = 1;\n', src: null };
  const asset = new Uint8Array(3000).map((_, i) => i % 251);
  const calls: string[] = [];
  const state = { limited: 1 };
  const fetch = wrap(async (req, u) => {
    if (u.host === 'objects.fake') return rangeResponse(asset, req.headers.get('range'));
    const p = decodeURIComponent(u.pathname);
    if (state.limited > 0 && p.endsWith('/releases')) {
      state.limited--;
      return json({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000)) });
    }
    if (p === '/repos/o/r') return json({ full_name: 'o/r' });
    const c = /^\/repos\/o\/r\/contents\/?(.*)$/.exec(p);
    if (c) {
      const path = c[1];
      const raw = req.headers.get('accept') === 'application/vnd.github.raw';
      if (path === '' || tree[path] === null) {
        const kids = Object.keys(tree).filter((k) => k.includes('/') ? k.slice(0, k.lastIndexOf('/')) === path : path === '');
        return json(kids.map((k) => ({ type: tree[k] === null ? 'dir' : 'file', name: k.split('/').pop(), path: k, size: tree[k]?.length ?? 0, sha: 'sha-' + k })));
      }
      if (typeof tree[path] === 'string') {
        if (raw) return rangeResponse(new TextEncoder().encode(tree[path]!), req.headers.get('range'));
        return json({ type: 'file', name: path.split('/').pop(), path, size: tree[path]!.length, sha: 'sha-' + path });
      }
      return json({ message: 'Not Found' }, 404);
    }
    if (p === '/repos/o/r/releases') return json([{ tag_name: 'v1.0', published_at: '2026-01-01T00:00:00Z', assets: [{ id: 7, name: 'app.zip', size: asset.length, content_type: 'application/zip' }] }]);
    if (p === '/repos/o/r/releases/assets/7') {
      if (req.headers.get('accept') !== 'application/octet-stream') return json({ message: 'need octet-stream' }, 415);
      return new Response(null, { status: 302, headers: { location: 'https://objects.fake/app.zip?sig=1' } });
    }
    return json({ message: 'Not Found' }, 404);
  }, calls);
  return { fetch, calls, asset, state };
}
