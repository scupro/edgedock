// Copy Vditor's runtime assets (Lute, KaTeX, mermaid, highlight.js, …) into
// public/vendor/vditor so the editor/preview work without a third-party CDN
// (and offline via the PWA cache). MathJax is skipped (KaTeX is used).
import { cpSync, existsSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const src = path.join(path.dirname(require.resolve('vditor/package.json')), 'dist');
const dest = path.resolve('public/vendor/vditor/dist');
if (existsSync(dest)) rmSync(dest, { recursive: true });
cpSync(src, dest, {
  recursive: true,
  filter: (p) => !p.includes(`${path.sep}mathjax`) && !p.endsWith('.map') && !/index(\.min)?\.js$|method(\.min)?\.js$|\.d\.ts$/.test(path.basename(p)),
});
console.log('[edgedock] vditor assets ->', dest);
