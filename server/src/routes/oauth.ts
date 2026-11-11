/**
 * Admin-UI OAuth helper for OneDrive / Google Drive:
 *   POST /api/oauth/:provider/start     (admin)  → { url } to open in a popup (state + PKCE kept in D1)
 *   GET  /api/oauth/:provider/callback  (public) → exchanges the code, stores the refresh token
 *                                                  encrypted in the storage secret, notifies the opener
 */
import { Hono } from 'hono';
import { assertAdmin } from '../lib/auth';
import { decryptString, encryptString, randomToken, toBase64Url } from '../lib/crypto';
import { badRequest, notFound } from '../lib/errors';
import type { AppEnv, Env } from '../lib/types';
import { GDRIVE } from '../storage/gdrive';
import { ensureOk, fetchRetry } from '../storage/http';
import { invalidateMounts, type StorageRow } from '../storage/mounts';
import { clearTokenCache } from '../storage/oauth';
import { onedriveEndpoints } from '../storage/onedrive';

export const oauthRoutes = new Hono<AppEnv>();

const STATE_TTL = 15 * 60_000;

interface ProviderUrls {
  authorize: string;
  token: string;
  scope: string;
  extra: Record<string, string>;
}

function providerUrls(provider: string, cfg: Record<string, unknown>): ProviderUrls {
  if (provider === 'onedrive') {
    const ep = onedriveEndpoints(cfg as { region?: string; tenant?: string; driveType?: string });
    return { authorize: ep.authorize, token: ep.token, scope: ep.scope, extra: { response_mode: 'query' } };
  }
  if (provider === 'gdrive') return { authorize: GDRIVE.authorize, token: GDRIVE.token, scope: GDRIVE.scope, extra: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' } };
  throw badRequest(`Unknown OAuth provider: ${provider}`);
}

async function loadStorage(env: Env, id: string, provider: string) {
  const row = await env.DB.prepare('SELECT * FROM storages WHERE id = ?').bind(id).first<StorageRow>();
  if (!row) throw notFound('Storage not found');
  if (row.type !== provider) throw badRequest(`Storage is not a ${provider} storage`);
  const config = JSON.parse(row.config || '{}') as Record<string, unknown>;
  const secret = row.secret ? (JSON.parse(await decryptString(row.secret, env.ENCRYPTION_KEY)) as Record<string, unknown>) : {};
  return { row, config, secret, all: { ...config, ...secret } };
}

export function callbackUrl(env: Env, reqUrl: string, provider: string): string {
  const base = env.PUBLIC_URL ? new URL(env.PUBLIC_URL).origin : new URL(reqUrl).origin;
  return `${base}/api/oauth/${provider}/callback`;
}

oauthRoutes.post('/:provider/start', async (c) => {
  assertAdmin(c.get('principal'));
  const provider = c.req.param('provider');
  const b = await c.req.json<{ storageId: string; redirectUri?: string }>();
  const { all } = await loadStorage(c.env, b.storageId, provider);
  if (!all.clientId) throw badRequest('Fill in and save the client id (and secret) first');
  const urls = providerUrls(provider, all);
  // the redirect must come back to this deployment's callback
  const redirectUri = b.redirectUri && new URL(b.redirectUri).pathname === `/api/oauth/${provider}/callback` ? b.redirectUri : callbackUrl(c.env, c.req.url, provider);
  const state = randomToken(24);
  const verifier = randomToken(48);
  const challenge = toBase64Url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  await c.env.DB.prepare('DELETE FROM oauth_states WHERE created_at < ?').bind(Date.now() - STATE_TTL).run();
  await c.env.DB.prepare('INSERT INTO oauth_states (state, provider, storage_id, redirect_uri, verifier, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(state, provider, b.storageId, redirectUri, verifier, Date.now())
    .run();
  const u = new URL(urls.authorize);
  const params: Record<string, string> = {
    client_id: String(all.clientId),
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: urls.scope,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...urls.extra,
  };
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return c.json({ url: u.toString(), redirectUri });
});

function page(ok: boolean, message: string): Response {
  const esc = message.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
  const payload = JSON.stringify({ type: 'edgedock-oauth', ok, error: ok ? undefined : message }).replace(/</g, '\\u003c');
  const html = `<!doctype html><html lang="zh-Hant-TW"><meta charset="utf-8"><title>EdgeDock OAuth</title>
<body style="font-family:system-ui,sans-serif;padding:2rem;line-height:1.6">
<h2>${ok ? '✅ 授權完成 / Authorized' : '❌ 授權失敗 / Authorization failed'}</h2><p>${esc}</p><p>可以關閉此視窗。You can close this window.</p>
<script>try{window.opener&&window.opener.postMessage(${payload},'*')}catch(e){};setTimeout(function(){window.close()},${ok ? 1200 : 8000})</script></body></html>`;
  return new Response(html, { status: ok ? 200 : 400, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

oauthRoutes.get('/:provider/callback', async (c) => {
  const provider = c.req.param('provider');
  const q = c.req.query();
  if (q.error) return page(false, `${q.error}: ${q.error_description ?? ''}`);
  if (!q.code || !q.state) return page(false, 'Missing code / state');
  const st = await c.env.DB.prepare('SELECT * FROM oauth_states WHERE state = ? AND provider = ?').bind(q.state, provider).first<{
    storage_id: string;
    redirect_uri: string;
    verifier: string;
    created_at: number;
  }>();
  await c.env.DB.prepare('DELETE FROM oauth_states WHERE state = ?').bind(q.state).run();
  if (!st || Date.now() - st.created_at > STATE_TTL) return page(false, 'State expired or unknown — start the authorization again');
  try {
    const { row, secret, all } = await loadStorage(c.env, st.storage_id, provider);
    const urls = providerUrls(provider, all);
    const form = new URLSearchParams({ grant_type: 'authorization_code', code: q.code, redirect_uri: st.redirect_uri, client_id: String(all.clientId), code_verifier: st.verifier });
    if (all.clientSecret) form.set('client_secret', String(all.clientSecret));
    if (provider === 'onedrive') form.set('scope', urls.scope);
    const res = await fetchRetry((...a) => fetch(...a), urls.token, () => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() }));
    await ensureOk(res, 'Token exchange');
    const tok = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
    if (!tok.refresh_token) return page(false, 'The provider returned no refresh token (Google: remove the app at myaccount.google.com/permissions and retry; Microsoft: include offline_access)');
    const k = c.env.ENCRYPTION_KEY;
    const newSecret = await encryptString(JSON.stringify({ ...secret, refreshToken: tok.refresh_token }), k);
    const now = Date.now();
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE storages SET secret = ?, updated_at = ? WHERE id = ?').bind(newSecret, now, row.id),
      c.env.DB.prepare(
        `INSERT INTO oauth_tokens (storage_id, provider, access_token, refresh_token, expires_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(storage_id) DO UPDATE SET access_token = excluded.access_token, refresh_token = excluded.refresh_token, expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
      ).bind(row.id, provider, await encryptString(tok.access_token, k), await encryptString(tok.refresh_token, k), now + (Number(tok.expires_in) || 3600) * 1000, now),
    ]);
    clearTokenCache();
    invalidateMounts();
    return page(true, `${row.name}: refresh token saved (encrypted).`);
  } catch (e) {
    return page(false, (e as Error).message);
  }
});
