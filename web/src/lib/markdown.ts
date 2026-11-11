/** Markdown rendering via Vditor (GFM, KaTeX math, mermaid, flowchart, mindmap, …). */
import { locale } from './i18n';

/**
 * Vditor loads Lute, KaTeX, mermaid … at runtime from this base URL. By default the
 * assets are self-hosted under /vendor/vditor (copied at build time by
 * scripts/copy-vditor.mjs). Set VITE_VDITOR_CDN=https://unpkg.com/vditor@3.11.3 to use a CDN instead.
 */
export const VDITOR_CDN = (import.meta.env.VITE_VDITOR_CDN as string | undefined) || `${location.origin}/vendor/vditor`;

export const isDark = () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;

export function vditorLang(): 'zh_TW' | 'en_US' {
  return locale.value === 'zh-TW' ? 'zh_TW' : 'en_US';
}

export async function loadVditor() {
  const mod = await import('vditor');
  await import('vditor/dist/index.css');
  return mod.default;
}

/** Render markdown into an element. Raw HTML is sanitized by Lute. */
export async function renderMarkdown(el: HTMLElement, md: string, opts: { dark?: boolean } = {}): Promise<void> {
  const Vditor = await loadVditor();
  const dark = opts.dark ?? isDark();
  await Vditor.preview(el as HTMLDivElement, md, {
    cdn: VDITOR_CDN,
    mode: dark ? 'dark' : 'light',
    lang: vditorLang(),
    theme: { current: dark ? 'dark' : 'light', path: `${VDITOR_CDN}/dist/css/content-theme` },
    hljs: { style: dark ? 'github-dark' : 'github', lineNumber: false },
    math: { engine: 'KaTeX', inlineDigit: true },
    markdown: { sanitize: true, toc: true, mark: true, footnotes: true, autoSpace: true },
    anchor: 0,
  });
}
