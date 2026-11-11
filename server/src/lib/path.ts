/** Virtual path helpers. Virtual paths are absolute, '/'-separated, no trailing slash (except root). */

export function normalizePath(input: string | undefined | null): string {
  const p = (input ?? '/').replace(/\\/g, '/');
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return '/' + out.join('/');
}

export function joinPath(...parts: string[]): string {
  return normalizePath(parts.filter(Boolean).join('/'));
}

export function basename(p: string): string {
  const n = normalizePath(p);
  if (n === '/') return '';
  return n.slice(n.lastIndexOf('/') + 1);
}

export function dirname(p: string): string {
  const n = normalizePath(p);
  const i = n.lastIndexOf('/');
  return i <= 0 ? '/' : n.slice(0, i);
}

/** True if `path` equals `prefix` or is inside it. */
export function isWithin(path: string, prefix: string): boolean {
  const p = normalizePath(path);
  const pre = normalizePath(prefix);
  if (pre === '/') return true;
  return p === pre || p.startsWith(pre + '/');
}

export function extname(p: string): string {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i + 1).toLowerCase() : '';
}
