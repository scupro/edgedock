/**
 * OAuth token handling for OneDrive / Google Drive.
 *
 * - Access tokens are cached in memory (per storage) and in D1 (`oauth_tokens`, AES-GCM encrypted),
 *   so Worker isolates don't refresh on every request.
 * - Refresh tokens come from the storage's encrypted secret. When the provider rotates it
 *   (Microsoft does), the new one is stored encrypted in `oauth_tokens.refresh_token` and wins.
 * - Concurrent refreshes are de-duplicated.
 * - Google service accounts: a signed RS256 JWT assertion instead of a refresh token.
 */
import { decryptString, encryptString } from '../lib/crypto';
import type { Env } from '../lib/types';
import { b64url, ensureOk, fetchRetry, ProviderError } from './http';

export interface TokenSource {
  /** valid access token; `force` skips caches (after a 401) */
  get(force?: boolean): Promise<string>;
}

interface Cached {
  token: string;
  expiresAt: number;
}

const memory = new Map<string, Cached>();
const inflight = new Map<string, Promise<string>>();

/** for tests */
export function clearTokenCache(): void {
  memory.clear();
  inflight.clear();
}

export interface RefreshTokenOptions {
  provider: string;
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  refreshToken?: string;
  scope?: string;
  fetch: typeof fetch;
  env?: Env;
  storageId?: string;
}

const SKEW = 120_000; // refresh 2 minutes early

abstract class CachedTokenSource implements TokenSource {
  constructor(
    protected key: string,
    protected env?: Env,
    protected storageId?: string,
    protected provider = 'oauth',
  ) {}

  protected abstract fetchToken(): Promise<{ access_token: string; expires_in?: number; refresh_token?: string }>;

  async get(force = false): Promise<string> {
    if (!force) {
      const m = memory.get(this.key);
      if (m && m.expiresAt - SKEW > Date.now()) return m.token;
      const d = await this.fromDb();
      if (d && d.expiresAt - SKEW > Date.now()) {
        memory.set(this.key, d);
        return d.token;
      }
    }
    const running = inflight.get(this.key);
    if (running) return running;
    const p = this.refresh().finally(() => inflight.delete(this.key));
    inflight.set(this.key, p);
    return p;
  }

  private async fromDb(): Promise<Cached | null> {
    if (!this.env || !this.storageId) return null;
    try {
      const row = await this.env.DB.prepare('SELECT access_token, expires_at FROM oauth_tokens WHERE storage_id = ?').bind(this.storageId).first<{ access_token: string | null; expires_at: number | null }>();
      if (!row?.access_token || !row.expires_at) return null;
      return { token: await decryptString(row.access_token, this.env.ENCRYPTION_KEY), expiresAt: row.expires_at };
    } catch {
      return null;
    }
  }

  protected async storedRefreshToken(): Promise<string | null> {
    if (!this.env || !this.storageId) return null;
    try {
      const row = await this.env.DB.prepare('SELECT refresh_token FROM oauth_tokens WHERE storage_id = ?').bind(this.storageId).first<{ refresh_token: string | null }>();
      return row?.refresh_token ? await decryptString(row.refresh_token, this.env.ENCRYPTION_KEY) : null;
    } catch {
      return null;
    }
  }

  private async refresh(): Promise<string> {
    const t = await this.fetchToken();
    if (!t.access_token) throw new ProviderError(401, 'Token endpoint returned no access_token');
    const expiresAt = Date.now() + (Number(t.expires_in) || 3600) * 1000;
    memory.set(this.key, { token: t.access_token, expiresAt });
    if (this.env && this.storageId) {
      const k = this.env.ENCRYPTION_KEY;
      const access = await encryptString(t.access_token, k);
      const refresh = t.refresh_token ? await encryptString(t.refresh_token, k) : null;
      await this.env.DB.prepare(
        `INSERT INTO oauth_tokens (storage_id, provider, access_token, refresh_token, expires_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(storage_id) DO UPDATE SET access_token = excluded.access_token, refresh_token = COALESCE(excluded.refresh_token, oauth_tokens.refresh_token), expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
      )
        .bind(this.storageId, this.provider, access, refresh, expiresAt, Date.now())
        .run()
        .catch((e) => console.warn('[edgedock] could not persist oauth token', (e as Error).message));
    }
    return t.access_token;
  }
}

/** OAuth2 refresh_token grant (OneDrive, Google user accounts). */
export class RefreshTokenSource extends CachedTokenSource {
  constructor(private o: RefreshTokenOptions) {
    super(`${o.provider}:${o.storageId ?? o.clientId + ':' + (o.refreshToken ?? '').slice(-12)}`, o.env, o.storageId, o.provider);
  }

  protected async fetchToken() {
    const refreshToken = (await this.storedRefreshToken()) ?? this.o.refreshToken;
    if (!refreshToken) throw new ProviderError(401, `${this.o.provider}: no refresh token — use the OAuth authorize button in the storage settings`);
    const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: this.o.clientId });
    if (this.o.clientSecret) form.set('client_secret', this.o.clientSecret);
    if (this.o.scope) form.set('scope', this.o.scope);
    const res = await fetchRetry(this.o.fetch, this.o.tokenUrl, () => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() }));
    if (res.status === 400 || res.status === 401) {
      const j = (await res.json().catch(() => ({}))) as { error?: string; error_description?: string };
      throw new ProviderError(401, `${this.o.provider} token refresh failed (${j.error ?? res.status}): ${j.error_description ?? ''} — re-authorize the storage`.trim());
    }
    await ensureOk(res, `${this.o.provider} token refresh`);
    return res.json() as Promise<{ access_token: string; expires_in?: number; refresh_token?: string }>;
  }
}

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  const b = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(b);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** RS256 JWT for Google's jwt-bearer grant. */
export async function signServiceAccountJwt(key: ServiceAccountKey, scope: string, now = Math.floor(Date.now() / 1000), subject?: string): Promise<string> {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims: Record<string, unknown> = { iss: key.client_email, scope, aud: key.token_uri || 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 };
  if (subject) claims.sub = subject;
  const payload = b64url(JSON.stringify(claims));
  const k = await crypto.subtle.importKey('pkcs8', pemToDer(key.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', k, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
}

export class ServiceAccountSource extends CachedTokenSource {
  constructor(
    private saKey: ServiceAccountKey,
    private scope: string,
    private fetchFn: typeof fetch,
    env?: Env,
    storageId?: string,
    private subject?: string,
  ) {
    super(`gsa:${storageId ?? saKey.client_email}`, env, storageId, 'gdrive');
  }

  protected async fetchToken() {
    const assertion = await signServiceAccountJwt(this.saKey, this.scope, undefined, this.subject);
    const form = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion });
    const res = await fetchRetry(this.fetchFn, this.saKey.token_uri || 'https://oauth2.googleapis.com/token', () => ({
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    }));
    await ensureOk(res, 'Google service account token');
    return res.json() as Promise<{ access_token: string; expires_in?: number }>;
  }
}

/**
 * fetch with a bearer token: retries 429/5xx (fetchRetry) and refreshes the token once on 401.
 */
export async function authedFetch(fetchFn: typeof fetch, tokens: TokenSource, url: string, init: () => RequestInit, retryOpts?: Parameters<typeof fetchRetry>[3]): Promise<Response> {
  const run = async (force: boolean) => {
    const token = await tokens.get(force);
    return fetchRetry(
      fetchFn,
      url,
      () => {
        const i = init();
        const h = new Headers(i.headers);
        h.set('authorization', `Bearer ${token}`);
        return { ...i, headers: h };
      },
      retryOpts,
    );
  };
  const res = await run(false);
  if (res.status !== 401) return res;
  await res.body?.cancel().catch(() => {});
  return run(true);
}
