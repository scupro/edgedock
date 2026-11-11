<script setup lang="ts">
/**
 * Universal previewer. Heavy libraries (pdf.js, docx-preview, SheetJS, epub.js,
 * highlight.js, Vditor) are lazy-loaded per format.
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { absoluteUrl, signFile } from '../lib/api';
import { formatSize } from '../lib/format';
import { CODE, MAX_TEXT_PREVIEW, previewKind, TEXT_KINDS, type PreviewKind } from '../lib/fileTypes';
import { t } from '../lib/i18n';
import { store } from '../lib/store';
import { renderMarkdown } from '../lib/markdown';

const props = defineProps<{ name: string; path?: string; url?: string; size?: number | null }>();

const src = ref('');
const error = ref('');
const loading = ref(true);
const text = ref('');
const html = ref('');
const sheets = ref<{ name: string; html: string }[]>([]);
const activeSheet = ref(0);
const box = ref<HTMLElement | null>(null);
const pdfPages = ref(0);
const pdfShown = ref(0);
let pdfDoc: any = null;
let rendition: any = null;
const forceExternal = ref(false);

const externalExts = computed(() => (store.settings.externalPreviewExts || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
const kind = computed<PreviewKind>(() => (forceExternal.value ? 'external' : previewKind(props.name, externalExts.value)));
const ext = computed(() => (props.name.includes('.') ? props.name.slice(props.name.lastIndexOf('.') + 1).toLowerCase() : props.name.toLowerCase()));

const externalUrl = computed(() => {
  if (!src.value) return '';
  const abs = absoluteUrl(src.value);
  const tpl = store.settings.externalPreviewTemplate;
  if (!tpl) return `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(abs)}`;
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(abs)));
  return tpl
    .replace('{urlEncoded}', encodeURIComponent(abs))
    .replace('{base64}', encodeURIComponent(b64))
    .replace('{name}', encodeURIComponent(props.name))
    .replace('{url}', abs);
});

async function fetchBlob(): Promise<Blob> {
  const r = await fetch(src.value);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.blob();
}

async function load() {
  error.value = '';
  loading.value = true;
  text.value = '';
  html.value = '';
  sheets.value = [];
  try {
    src.value = props.url ?? (props.path ? await signFile(props.path) : '');
    const k = kind.value;
    if (TEXT_KINDS.includes(k)) {
      if ((props.size ?? 0) > MAX_TEXT_PREVIEW) throw new Error(t('preview.tooLarge'));
      const r = await fetch(src.value);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      text.value = await r.text();
      if (k === 'markdown') {
        loading.value = false;
        await nextTick();
        await renderMarkdown(box.value!, text.value);
        return;
      }
      const hljs = (await import('highlight.js')).default;
      await import('highlight.js/styles/github.css');
      if (k === 'json') {
        let pretty = text.value;
        try {
          pretty = JSON.stringify(JSON.parse(text.value), null, 2);
        } catch {
          /* show as-is */
        }
        html.value = hljs.highlight(pretty, { language: 'json' }).value;
      } else if (k === 'code') {
        const lang = CODE[ext.value] ?? (ext.value === 'dockerfile' ? 'dockerfile' : ext.value === 'makefile' ? 'makefile' : undefined);
        html.value = lang && hljs.getLanguage(lang) ? hljs.highlight(text.value, { language: lang }).value : hljs.highlightAuto(text.value).value;
      }
    } else if (k === 'pdf') {
      const pdfjs = await import('pdfjs-dist');
      const worker = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
      pdfjs.GlobalWorkerOptions.workerSrc = worker;
      pdfDoc = await pdfjs.getDocument({ url: src.value }).promise;
      pdfPages.value = pdfDoc.numPages;
      loading.value = false;
      await nextTick();
      await renderPdfPages(Math.min(10, pdfDoc.numPages));
      return;
    } else if (k === 'docx') {
      const { renderAsync } = await import('docx-preview');
      const blob = await fetchBlob();
      loading.value = false;
      await nextTick();
      await renderAsync(blob, box.value!, undefined, { inWrapper: true, ignoreLastRenderedPageBreak: true });
      return;
    } else if (k === 'sheet') {
      const XLSX = await import('xlsx');
      const buf = await (await fetchBlob()).arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array', sheetRows: 2000, codepage: 65001 });
      sheets.value = wb.SheetNames.map((n) => ({ name: n, html: XLSX.utils.sheet_to_html(wb.Sheets[n], { header: '', footer: '' }) }));
    } else if (k === 'epub') {
      const ePub = (await import('epubjs')).default;
      const buf = await (await fetchBlob()).arrayBuffer();
      loading.value = false;
      await nextTick();
      const book = ePub(buf as any);
      rendition = book.renderTo(box.value!, { width: '100%', height: '100%', spread: 'none' });
      await rendition.display();
      return;
    }
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

async function renderPdfPages(upTo: number) {
  for (let i = pdfShown.value + 1; i <= upTo; i++) {
    const page = await pdfDoc.getPage(i);
    const viewport = page.getViewport({ scale: 1.5 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    box.value?.appendChild(canvas);
    await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise;
    pdfShown.value = i;
  }
}

watch(() => [props.path, props.url, forceExternal.value], load, { immediate: true });
onBeforeUnmount(() => {
  pdfDoc?.destroy?.();
  rendition?.destroy?.();
});
</script>

<template>
  <div class="preview-box">
    <p v-if="loading" class="muted">{{ t('common.loading') }}</p>
    <p v-else-if="error" style="color: var(--c-danger)">{{ error }}</p>

    <template v-if="src && !error">
      <img v-if="kind === 'image' || kind === 'svg'" :src="src" :alt="name" />
      <video v-else-if="kind === 'video'" :src="src" controls playsinline preload="metadata" />
      <audio v-else-if="kind === 'audio'" :src="src" controls preload="metadata" />
      <div v-else-if="kind === 'markdown'" ref="box" class="md-body vditor-reset" />
      <pre v-else-if="kind === 'code' || kind === 'json'" class="hljs"><code v-html="html" /></pre>
      <pre v-else-if="kind === 'text'">{{ text }}</pre>
      <div v-else-if="kind === 'pdf'">
        <div ref="box" />
        <div class="row" v-if="pdfShown < pdfPages">
          <span class="muted">{{ pdfShown }} / {{ pdfPages }}</span>
          <button class="small" @click="renderPdfPages(Math.min(pdfShown + 10, pdfPages))">+10</button>
          <button class="small" @click="renderPdfPages(pdfPages)">All</button>
        </div>
      </div>
      <div v-else-if="kind === 'docx'" class="docx-wrap"><div ref="box" /></div>
      <div v-else-if="kind === 'sheet'">
        <div class="row" style="margin-bottom: 0.5rem" v-if="sheets.length > 1">
          <button v-for="(s, i) in sheets" :key="s.name" class="small" :class="{ primary: i === activeSheet }" @click="activeSheet = i">{{ s.name }}</button>
        </div>
        <div class="sheet-html table-wrap" v-if="sheets[activeSheet]" v-html="sheets[activeSheet].html" />
      </div>
      <div v-else-if="kind === 'epub'">
        <div ref="box" class="epub-view" />
        <div class="row" style="margin-top: 0.5rem">
          <button class="small" @click="rendition?.prev()">‹ {{ t('preview.prev') }}</button>
          <button class="small" @click="rendition?.next()">{{ t('preview.next') }} ›</button>
        </div>
      </div>
      <iframe v-else-if="kind === 'external'" :src="externalUrl" referrerpolicy="no-referrer" allowfullscreen />
      <div v-else class="stack" style="align-items: center; padding: 2rem 0">
        <div style="font-size: 3rem">📦</div>
        <p class="muted">{{ t('preview.unsupported') }} <span v-if="size">({{ formatSize(size) }})</span></p>
        <div class="row">
          <a class="btn primary" :href="src + (src.includes('?') ? '&' : '?') + 'download=1'">{{ t('common.download') }}</a>
          <button @click="forceExternal = true">{{ t('preview.external') }}</button>
        </div>
      </div>
    </template>
  </div>
</template>
