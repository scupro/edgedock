/** Markdown export: HTML, PDF, PNG and Word (.docx). */
import { downloadBlob } from './format';
import { renderMarkdown, VDITOR_CDN } from './markdown';

function safeName(title: string) {
  return (title || 'note').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 100);
}

/** Render markdown in an off-screen container (light theme, fixed width) for capture. */
async function renderOffscreen(md: string): Promise<{ el: HTMLDivElement; body: HTMLDivElement; cleanup: () => void }> {
  // outer wrapper is moved off-screen; the captured element itself has static positioning
  const outer = document.createElement('div');
  outer.style.cssText = 'position:fixed;left:-10000px;top:0;z-index:-1;';
  const page = document.createElement('div');
  page.style.cssText = 'width:820px;background:#fff;color:#111;padding:32px;box-sizing:border-box;';
  const body = document.createElement('div');
  body.className = 'vditor-reset';
  page.appendChild(body);
  outer.appendChild(page);
  document.body.appendChild(outer);
  await renderMarkdown(body, md, { dark: false });
  // give mermaid / math a moment to finish asynchronous rendering
  await new Promise((r) => setTimeout(r, 1200));
  return { el: page, body, cleanup: () => outer.remove() };
}

export async function exportHtml(md: string, title: string) {
  const { body: rendered, cleanup } = await renderOffscreen(md);
  const body = rendered.innerHTML;
  cleanup();
  const doc = `<!doctype html>
<html lang="zh-Hant-TW"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title.replace(/</g, '&lt;')}</title>
<link rel="stylesheet" href="${VDITOR_CDN}/dist/index.css">
<link rel="stylesheet" href="${VDITOR_CDN}/dist/js/katex/katex.min.css">
<style>body{max-width:860px;margin:2rem auto;padding:0 1rem;font-family:system-ui,'Noto Sans TC',sans-serif}</style>
</head><body><article class="vditor-reset">${body}</article></body></html>`;
  downloadBlob(new Blob([doc], { type: 'text/html;charset=utf-8' }), `${safeName(title)}.html`);
}

export async function exportPdf(md: string, title: string) {
  const html2pdf = (await import('html2pdf.js')).default as any;
  const { el, cleanup } = await renderOffscreen(md);
  try {
    await html2pdf()
      .set({
        margin: [10, 10, 12, 10],
        filename: `${safeName(title)}.pdf`,
        image: { type: 'jpeg', quality: 0.95 },
        html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff' },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
        pagebreak: { mode: ['css', 'legacy'] },
      })
      .from(el)
      .save();
  } finally {
    cleanup();
  }
}

export async function exportPng(md: string, title: string) {
  const { toBlob } = await import('html-to-image');
  const { el, cleanup } = await renderOffscreen(md);
  try {
    const blob = await toBlob(el, { backgroundColor: '#ffffff', pixelRatio: 2, cacheBust: true });
    if (blob) downloadBlob(blob, `${safeName(title)}.png`);
  } finally {
    cleanup();
  }
}

export function exportMarkdown(md: string, title: string) {
  downloadBlob(new Blob([md], { type: 'text/markdown;charset=utf-8' }), `${safeName(title)}.md`);
}

/** Markdown -> .docx using the marked lexer + docx builder (headings, lists, code, quotes, tables, links). */
export async function exportDocx(md: string, title: string) {
  const { marked } = await import('marked');
  const docx = await import('docx');
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, ExternalHyperlink, Table, TableRow, TableCell, WidthType, BorderStyle, ShadingType } = docx;
  type Child = InstanceType<typeof TextRun> | InstanceType<typeof ExternalHyperlink>;

  const inline = (tokens: any[] | undefined, style: { bold?: boolean; italics?: boolean; strike?: boolean } = {}): Child[] => {
    const out: Child[] = [];
    for (const tk of tokens ?? []) {
      switch (tk.type) {
        case 'strong':
          out.push(...inline(tk.tokens, { ...style, bold: true }));
          break;
        case 'em':
          out.push(...inline(tk.tokens, { ...style, italics: true }));
          break;
        case 'del':
          out.push(...inline(tk.tokens, { ...style, strike: true }));
          break;
        case 'codespan':
          out.push(new TextRun({ text: decode(tk.text), font: 'Consolas', shading: { type: ShadingType.CLEAR, fill: 'EEEEEE', color: 'auto' }, ...style }));
          break;
        case 'link':
          out.push(new ExternalHyperlink({ link: tk.href, children: [new TextRun({ text: decode(tk.text), style: 'Hyperlink', ...style })] }));
          break;
        case 'image':
          out.push(new TextRun({ text: `[${decode(tk.text || 'image')}](${tk.href})`, italics: true }));
          break;
        case 'br':
          out.push(new TextRun({ text: '', break: 1 }));
          break;
        case 'text':
          if (tk.tokens) out.push(...inline(tk.tokens, style));
          else out.push(new TextRun({ text: decode(tk.text), ...style }));
          break;
        default:
          out.push(new TextRun({ text: decode(tk.raw ?? tk.text ?? ''), ...style }));
      }
    }
    return out;
  };

  const headingMap = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];
  const blocks: (InstanceType<typeof Paragraph> | InstanceType<typeof Table>)[] = [];

  const walk = (tokens: any[], ctx: { level?: number; ordered?: boolean; quote?: boolean } = {}) => {
    for (const tk of tokens) {
      switch (tk.type) {
        case 'heading':
          blocks.push(new Paragraph({ heading: headingMap[tk.depth - 1], children: inline(tk.tokens) }));
          break;
        case 'paragraph':
          blocks.push(new Paragraph({ children: inline(tk.tokens), indent: ctx.quote ? { left: 480 } : undefined, spacing: { after: 120 } }));
          break;
        case 'code':
          for (const line of String(tk.text).split('\n')) {
            blocks.push(new Paragraph({ children: [new TextRun({ text: line || ' ', font: 'Consolas', size: 20 })], shading: { type: ShadingType.CLEAR, fill: 'F3F4F6', color: 'auto' } }));
          }
          blocks.push(new Paragraph({ children: [] }));
          break;
        case 'blockquote':
          walk(tk.tokens, { ...ctx, quote: true });
          break;
        case 'list':
          for (const item of tk.items) {
            const level = ctx.level ?? 0;
            const first = item.tokens.find((x: any) => x.type === 'text' || x.type === 'paragraph');
            const prefix = item.task ? (item.checked ? '☑ ' : '☐ ') : '';
            const kids = [new TextRun(prefix), ...inline(first?.tokens ?? [{ type: 'text', text: first?.text ?? '' }])];
            blocks.push(
              tk.ordered
                ? new Paragraph({ children: kids, numbering: { reference: 'ordered', level: Math.min(level, 8) } })
                : new Paragraph({ children: kids, bullet: { level: Math.min(level, 8) } }),
            );
            const nested = item.tokens.filter((x: any) => x !== first);
            if (nested.length) walk(nested, { ...ctx, level: level + 1 });
          }
          break;
        case 'table': {
          const border = { style: BorderStyle.SINGLE, size: 4, color: 'BBBBBB' };
          const borders = { top: border, bottom: border, left: border, right: border };
          const row = (cells: any[], header: boolean) =>
            new TableRow({ children: cells.map((c) => new TableCell({ borders, children: [new Paragraph({ children: inline(c.tokens, { bold: header }) })] })) });
          blocks.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [row(tk.header, true), ...tk.rows.map((r: any[]) => row(r, false))] }));
          blocks.push(new Paragraph({ children: [] }));
          break;
        }
        case 'hr':
          blocks.push(new Paragraph({ children: [], border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'CCCCCC', space: 1 } } }));
          break;
        case 'space':
          break;
        default:
          if (tk.raw?.trim()) blocks.push(new Paragraph({ children: [new TextRun(decode(tk.raw))] }));
      }
    }
  };

  walk(marked.lexer(md, { gfm: true }));
  const doc = new Document({
    title,
    creator: 'EdgeDock',
    styles: { default: { document: { run: { font: 'Microsoft JhengHei', size: 22 } } } },
    numbering: {
      config: [
        {
          reference: 'ordered',
          levels: Array.from({ length: 9 }, (_, i) => ({ level: i, format: docx.LevelFormat.DECIMAL, text: `%${i + 1}.`, alignment: docx.AlignmentType.START, style: { paragraph: { indent: { left: 720 * (i + 1), hanging: 360 } } } })),
        },
      ],
    },
    sections: [{ children: blocks }],
  });
  downloadBlob(await Packer.toBlob(doc), `${safeName(title)}.docx`);
}

function decode(s: string): string {
  return String(s ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}
