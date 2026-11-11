import { Hono, type Context } from 'hono';
import { assertRead, assertWrite } from '../lib/auth';
import { badRequest, forbidden, gone, notFound, unauthorized } from '../lib/errors';
import { serveVfsFile } from '../lib/serve';
import { getSettings } from '../lib/settings';
import {
  checkSharePassword,
  consumeView,
  createShare,
  getShareBySlug,
  issueShareToken,
  publicShare,
  shareState,
  updateShare,
  verifyShareToken,
  type ShareInput,
  type ShareRow,
} from '../lib/shares';
import type { AppEnv, Principal } from '../lib/types';
import { Vfs } from '../storage/mounts';

/** Management API (/api/shares) — admin or read-write API key. */
export const shareRoutes = new Hono<AppEnv>();
/** Public API (/api/public/shares) */
export const publicShareRoutes = new Hono<AppEnv>();
/** Raw links (/raw/:slug) */
export const rawRoutes = new Hono<AppEnv>();

const owner = (p: Principal) => `${p.kind}:${p.id}`;

function canManage(p: Principal, s: ShareRow): boolean {
  return p.permission === 'admin' || s.created_by === owner(p);
}

shareRoutes.get('/', async (c) => {
  const p = c.get('principal');
  if (p.kind === 'anonymous') throw unauthorized();
  const q = p.permission === 'admin'
    ? c.env.DB.prepare('SELECT * FROM shares ORDER BY created_at DESC LIMIT 500')
    : c.env.DB.prepare('SELECT * FROM shares WHERE created_by = ? ORDER BY created_at DESC LIMIT 500').bind(owner(p));
  const { results } = await q.all<ShareRow>();
  return c.json(results.map((s) => ({ ...publicShare(s), state: shareState(s) })));
});

shareRoutes.get('/:id', async (c) => {
  const p = c.get('principal');
  const s = await c.env.DB.prepare('SELECT * FROM shares WHERE id = ?').bind(c.req.param('id')).first<ShareRow>();
  if (!s || !canManage(p, s)) throw notFound();
  return c.json({ ...publicShare(s), content: s.content, state: shareState(s) });
});

shareRoutes.post('/', async (c) => {
  const p = c.get('principal');
  const body = await c.req.json<ShareInput>();
  if (body.type === 'file') {
    assertRead(p, body.storagePath ?? '/');
    const st = await (await Vfs.create(c.env)).stat(body.storagePath ?? '/');
    if (!st || st.isDir) throw badRequest('File not found');
  }
  if (p.kind === 'anonymous') throw unauthorized();
  if (p.permission === 'read') throw forbidden('Read-only keys cannot create shares');
  if (p.kind === 'apikey') assertWrite(p, p.pathPrefix);
  const settings = await getSettings(c.env);
  const s = await createShare(c.env, body, owner(p), settings.maxShareContentKB);
  return c.json(publicShare(s), 201);
});

shareRoutes.patch('/:id', async (c) => {
  const p = c.get('principal');
  const s = await c.env.DB.prepare('SELECT * FROM shares WHERE id = ?').bind(c.req.param('id')).first<ShareRow>();
  if (!s || !canManage(p, s)) throw notFound();
  const settings = await getSettings(c.env);
  const next = await updateShare(c.env, s.id, await c.req.json<Partial<ShareInput>>(), settings.maxShareContentKB);
  return c.json(publicShare(next!));
});

shareRoutes.post('/:id/reset-views', async (c) => {
  const p = c.get('principal');
  const s = await c.env.DB.prepare('SELECT * FROM shares WHERE id = ?').bind(c.req.param('id')).first<ShareRow>();
  if (!s || !canManage(p, s)) throw notFound();
  await c.env.DB.prepare('UPDATE shares SET views = 0, updated_at = ? WHERE id = ?').bind(Date.now(), s.id).run();
  return c.json({ ok: true });
});

shareRoutes.delete('/:id', async (c) => {
  const p = c.get('principal');
  const s = await c.env.DB.prepare('SELECT * FROM shares WHERE id = ?').bind(c.req.param('id')).first<ShareRow>();
  if (!s || !canManage(p, s)) throw notFound();
  await c.env.DB.prepare('DELETE FROM shares WHERE id = ?').bind(s.id).run();
  return c.json({ ok: true });
});

// ------------------------------------------------------------ public
async function loadLive(c: Context<AppEnv>, slug: string): Promise<ShareRow> {
  const s = await getShareBySlug(c.env, slug);
  if (!s) throw notFound('Share not found');
  const state = shareState(s);
  if (state === 'expired') throw gone('This share has expired');
  if (state === 'exhausted') throw gone('This share has reached its view limit');
  return s;
}

/** Password via ?token= (from /unlock), ?password=, or X-Share-Password header. */
export async function isShareAuthorized(c: Context<AppEnv>, s: ShareRow): Promise<boolean> {
  if (!s.password_hash) return true;
  const token = c.req.query('token') ?? c.req.header('x-share-token');
  if (await verifyShareToken(c.env, s, token)) return true;
  const pw = c.req.query('password') ?? c.req.header('x-share-password');
  return !!pw && (await checkSharePassword(s, pw));
}

async function requireShareAuth(c: Context<AppEnv>, s: ShareRow) {
  if (!(await isShareAuthorized(c, s))) throw unauthorized('Password required');
}

publicShareRoutes.get('/:slug', async (c) => {
  const s = await loadLive(c, c.req.param('slug'));
  const meta: Record<string, unknown> = { ...publicShare(s), storagePath: undefined, id: undefined };
  if (s.type === 'file' && s.storage_path) {
    const st = await (await Vfs.create(c.env)).stat(s.storage_path).catch(() => null);
    meta.fileName = s.storage_path.split('/').pop();
    meta.size = st?.size ?? null;
  }
  return c.json(meta);
});

publicShareRoutes.post('/:slug/unlock', async (c) => {
  const s = await loadLive(c, c.req.param('slug'));
  const { password } = await c.req.json<{ password: string }>().catch(() => ({ password: '' }));
  if (!(await checkSharePassword(s, password))) throw unauthorized('Wrong password');
  return c.json({ token: await issueShareToken(c.env, s) });
});

/** Text/markdown content as JSON. Counts one view. */
publicShareRoutes.get('/:slug/content', async (c) => {
  const s = await loadLive(c, c.req.param('slug'));
  await requireShareAuth(c, s);
  if (s.type === 'file') throw badRequest('Use the raw link for file shares');
  if (!(await consumeView(c.env, s))) throw gone('This share has reached its view limit');
  return c.json({ title: s.title, type: s.type, content: s.content, contentType: s.content_type, views: s.views + 1, maxViews: s.max_views });
});

// ------------------------------------------------------------ raw
rawRoutes.on(['GET', 'HEAD'], '/:slug/:name?', async (c) => {
  const s = await loadLive(c, c.req.param('slug'));
  await requireShareAuth(c, s);
  const range = c.req.header('range');
  // don't count HEAD or follow-up range requests (video seeking) as views
  const countable = c.req.method === 'GET' && (!range || /^bytes=0-/.test(range));
  if (countable && !(await consumeView(c.env, s))) throw gone('This share has reached its view limit');
  const security = { 'content-security-policy': "default-src 'none'; img-src * data:; media-src *; style-src 'unsafe-inline'; sandbox", 'x-content-type-options': 'nosniff', 'access-control-allow-origin': '*' };
  if (s.type !== 'file') {
    const body = s.content ?? '';
    const headers = new Headers({ 'content-type': s.content_type || 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...security });
    if (/text\/html|svg|javascript/i.test(headers.get('content-type')!)) headers.set('content-type', 'text/plain; charset=utf-8');
    return new Response(c.req.method === 'HEAD' ? null : body, { headers });
  }
  const res = await serveVfsFile(await Vfs.create(c.env), s.storage_path!, {
    download: c.req.query('download') === '1',
    safeInline: true,
    method: c.req.method,
    rangeHeader: range,
    cacheControl: 'no-store',
  });
  for (const [k, v] of Object.entries(security)) res.headers.set(k, v);
  return res;
});
