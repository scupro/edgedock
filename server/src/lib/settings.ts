import type { Env } from './types';

export interface Settings {
  siteTitle: string;
  /** UI default language: zh-TW (正體中文) or en */
  defaultLanguage: 'zh-TW' | 'en';
  /** WebDAV GET/PROPFIND cache TTL in seconds (Cache API). 0 = disabled */
  webdavCacheTtl: number;
  /** External preview URL template. Placeholders: {url} {urlEncoded} {name}. Empty = Microsoft Office Online viewer */
  externalPreviewTemplate: string;
  /** Extensions previewed with the external viewer (comma separated) */
  externalPreviewExts: string;
  /** Multipart chunk size in MiB (S3 minimum is 5) */
  uploadPartSizeMB: number;
  /** Files larger than this use multipart upload (MiB) */
  multipartThresholdMB: number;
  /** Max size of markdown/text share content stored in D1 (KiB) */
  maxShareContentKB: number;
  /** Incomplete upload sessions expire after N hours */
  uploadSessionTtlHours: number;
}

export const DEFAULT_SETTINGS: Settings = {
  siteTitle: 'EdgeDock',
  defaultLanguage: 'zh-TW',
  webdavCacheTtl: 30,
  externalPreviewTemplate: '',
  externalPreviewExts: 'ppt,pptx,doc,xls,odt,ods,odp,rtf',
  uploadPartSizeMB: 8,
  multipartThresholdMB: 50,
  maxShareContentKB: 900,
  uploadSessionTtlHours: 48,
};

/** Settings safe to expose to anonymous visitors. */
export const PUBLIC_KEYS: (keyof Settings)[] = ['siteTitle', 'defaultLanguage', 'externalPreviewTemplate', 'externalPreviewExts', 'uploadPartSizeMB', 'multipartThresholdMB'];

export async function getSettings(env: Env): Promise<Settings> {
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>();
  const s: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const r of results) {
    if (!(r.key in DEFAULT_SETTINGS)) continue;
    try {
      s[r.key] = JSON.parse(r.value);
    } catch {
      s[r.key] = r.value;
    }
  }
  return s as unknown as Settings;
}

export async function saveSettings(env: Env, patch: Partial<Settings>): Promise<Settings> {
  const stmts = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    const def = (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[k];
    const val = typeof def === 'number' ? Number(v) : typeof def === 'boolean' ? !!v : String(v ?? '');
    stmts.push(env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(k, JSON.stringify(val)));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return getSettings(env);
}
