import { parseRange } from '../storage/base';
import type { Vfs } from '../storage/mounts';
import { notFound } from './errors';
import { mimeFromPath } from './mime';
import { basename } from './path';

/** Content types that could execute script on our origin when served inline. */
const ACTIVE_TYPES = /^(text\/html|application\/xhtml|image\/svg|text\/javascript|application\/javascript|application\/xml|text\/xml)/i;

export function contentDisposition(kind: 'inline' | 'attachment', filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export interface ServeOptions {
  download?: boolean;
  filename?: string;
  /** force a content type */
  contentType?: string;
  /** neutralize active content (html/svg/js) by serving it as text/plain */
  safeInline?: boolean;
  method?: string;
  rangeHeader?: string | null;
  ifNoneMatch?: string | null;
  cacheControl?: string;
}

/** Serve a virtual file with Range / HEAD / ETag support. */
export async function serveVfsFile(vfs: Vfs, vpath: string, opts: ServeOptions = {}): Promise<Response> {
  const st = await vfs.stat(vpath);
  if (!st || st.isDir) throw notFound();
  const filename = opts.filename ?? basename(vpath);
  let type = opts.contentType ?? st.contentType ?? mimeFromPath(vpath);
  if (type === 'application/octet-stream') type = mimeFromPath(vpath);
  if (opts.safeInline && ACTIVE_TYPES.test(type)) type = 'text/plain; charset=utf-8';
  const headers = new Headers({
    'content-type': type,
    'accept-ranges': 'bytes',
    'content-disposition': contentDisposition(opts.download ? 'attachment' : 'inline', filename),
    'x-content-type-options': 'nosniff',
    'cache-control': opts.cacheControl ?? 'private, max-age=0, must-revalidate',
  });
  if (st.etag) headers.set('etag', `"${st.etag}"`);
  if (st.modified) headers.set('last-modified', new Date(st.modified).toUTCString());
  if (st.etag && opts.ifNoneMatch && opts.ifNoneMatch.replace(/W\//, '').replace(/"/g, '') === st.etag) {
    return new Response(null, { status: 304, headers });
  }
  const range = parseRange(opts.rangeHeader, st.size);
  if (opts.rangeHeader && !range && st.size > 0 && /^bytes=/.test(opts.rangeHeader)) {
    headers.set('content-range', `bytes */${st.size}`);
    return new Response(null, { status: 416, headers });
  }
  if (opts.method === 'HEAD') {
    headers.set('content-length', String(st.size));
    return new Response(null, { status: 200, headers });
  }
  const r = await vfs.read(vpath, range ?? undefined);
  if (range && r.range) {
    headers.set('content-range', `bytes ${r.range.start}-${r.range.end}/${r.size}`);
    headers.set('content-length', String(r.range.end - r.range.start + 1));
    return new Response(r.body, { status: 206, headers });
  }
  headers.set('content-length', String(r.size));
  return new Response(r.body, { status: 200, headers });
}
