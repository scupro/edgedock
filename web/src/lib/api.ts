/** API client. VITE_API_BASE lets the SPA talk to a Worker on another origin (separate deploy). */
export const API_BASE = ((import.meta.env.VITE_API_BASE as string | undefined) || '').replace(/\/+$/, '');

const TOKEN_KEY = 'edgedock.token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(t: string | null): void {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

export function apiUrl(path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  return API_BASE + path;
}

/** Absolute URL (for external viewers / copy-to-clipboard). */
export function absoluteUrl(path: string): string {
  const u = apiUrl(path);
  return /^https?:\/\//.test(u) ? u : location.origin + u;
}

export function authHeaders(): Record<string, string> {
  const t = getToken();
  return t ? { authorization: `Bearer ${t}` } : {};
}

export async function api<T = any>(
  path: string,
  opts: { method?: string; body?: unknown; headers?: Record<string, string>; raw?: BodyInit; auth?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = { ...(opts.auth === false ? {} : authHeaders()), ...(opts.headers ?? {}) };
  let body: BodyInit | undefined = opts.raw;
  if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers['content-type'] = 'application/json';
  }
  const res = await fetch(apiUrl(path), { method: opts.method ?? (body ? 'POST' : 'GET'), headers, body });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    if (res.status === 401 && getToken() && !path.startsWith('/api/public') && !path.startsWith('/api/auth/login')) {
      window.dispatchEvent(new CustomEvent('edgedock:unauthorized'));
    }
    throw new ApiError(res.status, (data && data.error) || res.statusText || 'Request failed', data?.code);
  }
  return data as T;
}

export async function signFile(path: string, expiresIn = 3600): Promise<string> {
  const r = await api<{ url: string }>('/api/fs/sign', { body: { path, expiresIn } });
  return apiUrl(r.url);
}

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modified?: number;
  contentType?: string;
}
