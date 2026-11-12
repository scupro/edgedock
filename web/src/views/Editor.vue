<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import ShareDialog from '../components/ShareDialog.vue';
import { api, signFile } from '../lib/api';
import { exportDocx, exportHtml, exportMarkdown, exportPdf, exportPng } from '../lib/export';
import { joinPath } from '../lib/format';
import { t } from '../lib/i18n';
import { isDark, loadVditor, VDITOR_CDN, vditorLang } from '../lib/markdown';
import { darkActive } from '../lib/theme';
import { toast } from '../lib/store';

const route = useRoute();
const el = ref<HTMLElement | null>(null);
const title = ref('');
const savePath = ref('');
const sharing = ref(false);
const shareContent = ref('');
const busy = ref('');
let vditor: any = null;

const DEMO = `# EdgeDock Markdown

支援 **GFM**、數學公式、流程圖與心智圖。

## 數學 $E = mc^2$

$$
\\int_0^\\infty e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2}
$$

## Mermaid 流程圖

\`\`\`mermaid
flowchart LR
  A[上傳] --> B{大於 50MB?}
  B -- 是 --> C[分段續傳]
  B -- 否 --> D[直傳 / 代理]
\`\`\`

## 心智圖

\`\`\`mindmap
- EdgeDock
  - 檔案管理
  - Markdown 分享
  - WebDAV
\`\`\`

- [x] 待辦清單
- [ ] 表格 / 註腳

| 功能 | 狀態 |
| ---- | ---- |
| 分享 | ✅ |
`;

async function init() {
  const Vditor = await loadVditor();
  const filePath = route.query.path as string | undefined;
  const dir = (route.query.dir as string | undefined) ?? '';
  let initial = '';
  if (filePath) {
    savePath.value = filePath;
    title.value = filePath.split('/').pop()!.replace(/\.(md|markdown)$/i, '');
    const r = await fetch(await signFile(filePath));
    initial = r.ok ? await r.text() : '';
  } else if (dir) {
    savePath.value = joinPath(dir, 'untitled.md');
  }
  const cacheId = filePath ? `edgedock-file-${filePath}` : 'edgedock-draft';
  const hasDraft = !filePath && !!localStorage.getItem(cacheId);
  vditor = new Vditor(el.value!, {
    cdn: VDITOR_CDN,
    lang: vditorLang(),
    mode: 'sv',
    height: Math.max(480, window.innerHeight - 190),
    theme: isDark() ? 'dark' : 'classic',
    placeholder: '# ' + t('editor.untitled'),
    cache: { enable: !filePath, id: cacheId },
    counter: { enable: true },
    outline: { enable: true, position: 'left' },
    preview: {
      mode: 'both',
      delay: 300,
      theme: { current: isDark() ? 'dark' : 'light', path: `${VDITOR_CDN}/dist/css/content-theme` },
      hljs: { style: isDark() ? 'github-dark' : 'github', lineNumber: true },
      math: { engine: 'KaTeX', inlineDigit: true },
      markdown: { toc: true, mark: true, footnotes: true, autoSpace: true, sanitize: true },
    },
    toolbar: [
      'emoji', 'headings', 'bold', 'italic', 'strike', 'link', '|',
      'list', 'ordered-list', 'check', 'outdent', 'indent', '|',
      'quote', 'line', 'code', 'inline-code', 'insert-before', 'insert-after', '|',
      'table', '|', 'undo', 'redo', '|', 'edit-mode', 'both', 'preview', 'outline', 'fullscreen', 'code-theme', 'content-theme',
    ],
    after: () => {
      if (filePath) vditor.setValue(initial, true);
      else if (!hasDraft) vditor.setValue(DEMO, true);
      else toast(t('editor.draftRestored'));
    },
  });
}

onMounted(init);
// follow the light / dark toggle without reloading the editor
watch(darkActive, (dark) => {
  vditor?.setTheme(dark ? 'dark' : 'classic', dark ? 'dark' : 'light', dark ? 'github-dark' : 'github', `${VDITOR_CDN}/dist/css/content-theme`);
});
onBeforeUnmount(() => vditor?.destroy());
watch(
  () => route.fullPath,
  () => {
    vditor?.destroy();
    vditor = null;
    init();
  },
);

const md = () => (vditor ? vditor.getValue() : '');
const docTitle = () => title.value || t('editor.untitled');

async function save() {
  let p = savePath.value || prompt(t('editor.savePath'), '/') || '';
  if (!p) return;
  if (!/\.(md|markdown|txt)$/i.test(p)) p += '.md';
  savePath.value = p;
  busy.value = 'save';
  try {
    await api(`/api/fs/write?path=${encodeURIComponent(p)}`, { method: 'PUT', raw: md(), headers: { 'content-type': 'text/markdown; charset=utf-8' } });
    toast(`${t('editor.saved')}: ${p}`);
  } catch (e) {
    toast((e as Error).message);
  } finally {
    busy.value = '';
  }
}

function share() {
  shareContent.value = md();
  sharing.value = true;
}

async function doExport(kind: string) {
  busy.value = kind;
  try {
    if (kind === 'pdf') await exportPdf(md(), docTitle());
    else if (kind === 'html') await exportHtml(md(), docTitle());
    else if (kind === 'png') await exportPng(md(), docTitle());
    else if (kind === 'docx') await exportDocx(md(), docTitle());
    else exportMarkdown(md(), docTitle());
  } catch (e) {
    toast((e as Error).message);
  } finally {
    busy.value = '';
  }
}
</script>

<template>
  <div class="container stack">
    <div class="row">
      <input v-model="title" :placeholder="t('editor.title')" style="max-width: 280px" />
      <input v-model="savePath" :placeholder="t('editor.savePath')" class="mono" style="max-width: 320px" />
      <button class="primary" :disabled="!!busy" @click="save">💾 {{ t('editor.saveAs') }}</button>
      <button :disabled="!!busy" @click="share">🔗 {{ t('editor.share') }}</button>
      <span class="spacer" />
      <span class="muted">{{ t('editor.export') }}:</span>
      <button class="small" :disabled="!!busy" @click="doExport('pdf')">{{ t('editor.exportPdf') }}</button>
      <button class="small" :disabled="!!busy" @click="doExport('html')">{{ t('editor.exportHtml') }}</button>
      <button class="small" :disabled="!!busy" @click="doExport('png')">{{ t('editor.exportPng') }}</button>
      <button class="small" :disabled="!!busy" @click="doExport('docx')">{{ t('editor.exportWord') }}</button>
      <button class="small" :disabled="!!busy" @click="doExport('md')">{{ t('editor.exportMd') }}</button>
      <span v-if="busy" class="muted">{{ t('common.loading') }}</span>
    </div>
    <div ref="el" class="vditor-wrap" />
    <ShareDialog v-if="sharing" type="markdown" :content="shareContent" :title="docTitle()" @close="sharing = false" />
  </div>
</template>
