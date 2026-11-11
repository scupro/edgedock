import type { MiddlewareHandler } from 'hono';
import type { AppEnv, Env } from './types';

/**
 * CORS for /api, /raw and /dav.
 *
 * CORS_ORIGINS: comma separated list. Entries may be
 *   - "*"                         any origin (credentials are then NOT allowed unless CORS_CREDENTIALS=true,
 *                                 in which case the request origin is reflected)
 *   - "https://app.example.com"   exact origin (scheme + host + port)
 *   - "https://*.example.com"     wildcard sub-domain(s) (any depth); "*" may also replace the port: "http://localhost:*"
 * CORS_CREDENTIALS: "true" | "false" (default true for explicit/wildcard-pattern origins, false for "*")
 * CORS_MAX_AGE: preflight cache seconds (default 86400; browsers cap at 7200 / 600)
 *
 * Preflights (OPTIONS + Access-Control-Request-Method) are answered here, *before* authentication.
 * A plain OPTIONS on /dav (no Access-Control-Request-Method) still reaches the WebDAV handler, so
 * DAV clients get their `DAV:` / `Allow:` capability headers.
 */

export const CORS_ALLOW_HEADERS = [
  'Authorization',
  'Content-Type',
  'Content-MD5',
  'X-API-Key',
  'X-Share-Password',
  'X-Share-Token',
  'X-Part-MD5',
  'X-Requested-With',
  'Range',
  'If-Match',
  'If-None-Match',
  'If-Modified-Since',
  // WebDAV
  'Depth',
  'Destination',
  'Overwrite',
  'If',
  'Lock-Token',
  'Timeout',
  'Translate',
];

export const CORS_EXPOSE_HEADERS = [
  'ETag',
  'Content-Range',
  'Content-Length',
  'Content-Type',
  'Content-Disposition',
  'Accept-Ranges',
  'Last-Modified',
  'Location',
  'Retry-After',
  'DAV',
  'Allow',
  'Lock-Token',
  'MS-Author-Via',
  'X-EdgeDock-Retriable',
  'X-EdgeDock-Part-MD5',
];

export const CORS_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'PROPFIND', 'PROPPATCH', 'MKCOL', 'COPY', 'MOVE', 'LOCK', 'UNLOCK'];

interface CorsPolicy {
  any: boolean;
  exact: Set<string>;
  patterns: RegExp[];
  credentials: boolean | null;
  maxAge: number;
}

const policyCache = new Map<string, CorsPolicy>();

function escapeRe(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

export function parseCorsOrigins(raw: string | undefined, credentials?: string, maxAge?: string): CorsPolicy {
  const key = `${raw}|${credentials}|${maxAge}`;
  const hit = policyCache.get(key);
  if (hit) return hit;
  const p: CorsPolicy = { any: false, exact: new Set(), patterns: [], credentials: null, maxAge: 86400 };
  for (const entry of (raw ?? '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean)) {
    if (entry === '*') p.any = true;
    else if (entry.includes('*')) {
      // "*." matches one or more labels; ":*" any port
      const tokenized = entry.replace(/\*\./g, '\u0001').replace(/:\*/g, '\u0002').replace(/\*/g, '\u0003');
      const re =
        '^' +
        escapeRe(tokenized)
          .replace(/\u0001/g, '(?:[a-z0-9-]+\\.)+')
          .replace(/\u0002/g, '(?::\\d+)?')
          .replace(/\u0003/g, '[a-z0-9-]*') +
        '$';
      p.patterns.push(new RegExp(re, 'i'));
    } else p.exact.add(entry.toLowerCase());
  }
  if (credentials === 'true') p.credentials = true;
  else if (credentials === 'false') p.credentials = false;
  const ma = Number(maxAge);
  if (maxAge !== undefined && maxAge !== '' && Number.isFinite(ma) && ma >= 0) p.maxAge = ma;
  policyCache.set(key, p);
  return p;
}

/** Returns the Access-Control-Allow-Origin value + whether credentials are allowed, or null if not allowed. */
export function matchOrigin(policy: CorsPolicy, origin: string, selfOrigin?: string): { allow: string; credentials: boolean } | null {
  if (!origin) return null;
  const o = origin.toLowerCase();
  if (selfOrigin && o === selfOrigin.toLowerCase()) return { allow: origin, credentials: true };
  if (policy.exact.has(o) || policy.patterns.some((r) => r.test(o))) return { allow: origin, credentials: policy.credentials ?? true };
  if (policy.any) {
    if (policy.credentials) return { allow: origin, credentials: true };
    return { allow: '*', credentials: false };
  }
  return null;
}

function policyFor(env: Env): CorsPolicy {
  return parseCorsOrigins(env.CORS_ORIGINS, env.CORS_CREDENTIALS, env.CORS_MAX_AGE);
}

function applyHeaders(h: Headers, m: { allow: string; credentials: boolean }) {
  h.set('Access-Control-Allow-Origin', m.allow);
  if (m.credentials) h.set('Access-Control-Allow-Credentials', 'true');
  h.set('Access-Control-Expose-Headers', CORS_EXPOSE_HEADERS.join(', '));
  const vary = h.get('Vary');
  if (m.allow !== '*' && !(vary ?? '').toLowerCase().includes('origin')) h.set('Vary', vary ? `${vary}, Origin` : 'Origin');
}

export function corsMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const origin = c.req.header('origin') ?? '';
    const policy = policyFor(c.env);
    const self = new URL(c.req.url).origin;
    const m = origin ? matchOrigin(policy, origin, self) : null;
    const isPreflight = c.req.method === 'OPTIONS' && !!c.req.header('access-control-request-method');

    if (isPreflight) {
      const h = new Headers();
      h.set('Vary', 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers');
      if (!m) return new Response(null, { status: 204, headers: h }); // no CORS headers = browser blocks
      applyHeaders(h, m);
      h.set('Access-Control-Allow-Methods', CORS_METHODS.join(', '));
      const reqHeaders = c.req.header('access-control-request-headers');
      // reflect what the browser asks for (we authenticate every request anyway), fall back to the known list
      h.set('Access-Control-Allow-Headers', reqHeaders && reqHeaders.trim() ? reqHeaders : CORS_ALLOW_HEADERS.join(', '));
      h.set('Access-Control-Max-Age', String(policy.maxAge));
      h.set('Content-Length', '0');
      return new Response(null, { status: 204, headers: h });
    }

    await next();
    if (!m) return;
    try {
      applyHeaders(c.res.headers, m);
    } catch {
      // immutable headers (e.g. a fetched upstream Response): copy
      const res = new Response(c.res.body, c.res);
      applyHeaders(res.headers, m);
      c.res = res;
    }
  };
}
