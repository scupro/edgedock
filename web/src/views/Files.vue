<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Modal from '../components/Modal.vue';
import Preview from '../components/Preview.vue';
import ShareDialog from '../components/ShareDialog.vue';
import { api, signFile, type FileEntry } from '../lib/api';
import { fileIcon, MARKDOWN, previewKind } from '../lib/fileTypes';
import { extOf, formatDate, formatSize, joinPath, parentPath } from '../lib/format';
import { locale, t } from '../lib/i18n';
import { isAdmin, toast } from '../lib/store';
import { enqueue, onUploadDone } from '../lib/upload';

const route = useRoute();
const router = useRouter();
const path = computed(() => (route.query.path as string) || '/');
const items = ref<FileEntry[]>([]);
const storage = ref<any>(null);
const writable = ref(false);
const loading = ref(false);
const error = ref('');
const selected = ref<Set<string>>(new Set());
const query = ref('');
const searchResults = ref<FileEntry[] | null>(null);
const previewing = ref<FileEntry | null>(null);
const sharing = ref<FileEntry | null>(null);
const dragOver = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);
const folderInput = ref<HTMLInputElement | null>(null);

const crumbs = computed(() => {
  const parts = path.value.split('/').filter(Boolean);
  return parts.map((p, i) => ({ name: p, path: '/' + parts.slice(0, i + 1).join('/') }));
});
const shown = computed(() => searchResults.value ?? items.value);

async function load() {
  loading.value = true;
  error.value = '';
  selected.value = new Set();
  try {
    const r = await api<any>(`/api/fs/list?path=${encodeURIComponent(path.value)}`);
    items.value = r.items;
    storage.value = r.storage;
    writable.value = r.writable;
  } catch (e) {
    error.value = (e as Error).message;
    items.value = [];
  } finally {
    loading.value = false;
  }
}

watch(path, () => {
  searchResults.value = null;
  query.value = '';
  load();
});
onMounted(load);
const off = onUploadDone((task) => {
  if (parentPath(task.path).startsWith(path.value)) load();
});
onUnmounted(off);

function open(e: FileEntry) {
  if (e.isDir) router.push({ path: '/files', query: { path: e.path } });
  else previewing.value = e;
}

function toggle(p: string) {
  const s = new Set(selected.value);
  s.has(p) ? s.delete(p) : s.add(p);
  selected.value = s;
}

async function search() {
  if (!query.value.trim()) {
    searchResults.value = null;
    return;
  }
  searchResults.value = await api(`/api/fs/search?q=${encodeURIComponent(query.value)}&path=${encodeURIComponent(path.value)}`);
}

async function mkdir() {
  const name = prompt(t('files.folderName'));
  if (!name) return;
  await run(() => api('/api/fs/mkdir', { body: { path: joinPath(path.value, name) } }));
}

function newMarkdown() {
  router.push({ path: '/editor', query: { dir: path.value } });
}

async function rename(e: FileEntry) {
  const name = prompt(t('files.newName'), e.name);
  if (!name || name === e.name) return;
  await run(() => api('/api/fs/rename', { body: { path: e.path, name } }));
}

async function remove(paths: string[]) {
  if (!paths.length || !confirm(t('common.confirmDelete'))) return;
  await run(() => api('/api/fs/delete', { body: { paths } }));
}

async function transfer(op: 'move' | 'copy', paths: string[]) {
  const to = prompt(t('files.destination'), path.value);
  if (!to) return;
  await run(() => api(`/api/fs/${op}`, { body: { paths, to } }));
}

async function download(e: FileEntry) {
  const url = await signFile(e.path, 600);
  const a = document.createElement('a');
  a.href = url + '?download=1';
  a.click();
}

async function run(fn: () => Promise<unknown>) {
  try {
    await fn();
    await load();
  } catch (e) {
    toast((e as Error).message);
  }
}

function onFiles(e: Event) {
  const input = e.target as HTMLInputElement;
  if (input.files?.length) enqueue(input.files, path.value);
  input.value = '';
}

function onDrop(e: DragEvent) {
  dragOver.value = false;
  if (!writable.value) return;
  const files = e.dataTransfer?.files;
  if (files?.length) enqueue(files, path.value);
}

function openInEditor(e: FileEntry) {
  router.push({ path: '/editor', query: { path: e.path } });
}
const isMd = (e: FileEntry) => MARKDOWN.includes(extOf(e.name));
</script>

<template>
  <div class="container stack">
    <div class="row">
      <nav class="breadcrumb">
        <router-link :to="{ path: '/files', query: { path: '/' } }">🏠</router-link>
        <template v-for="c in crumbs" :key="c.path">
          <span class="muted">/</span>
          <router-link :to="{ path: '/files', query: { path: c.path } }">{{ c.name }}</router-link>
        </template>
      </nav>
      <span v-if="storage" class="badge">{{ storage.name }} · {{ storage.type }}</span>
      <span v-if="storage && !writable" class="badge warn">{{ t('files.readonly') }}</span>
      <span class="spacer" />
      <form class="row" @submit.prevent="search">
        <input v-model="query" type="search" :placeholder="t('files.search')" style="width: 220px" @search="search" />
      </form>
    </div>

    <div class="row" v-if="storage">
      <button class="primary" :disabled="!writable" @click="fileInput?.click()">⬆ {{ t('files.upload') }}</button>
      <button :disabled="!writable" @click="folderInput?.click()" class="hide-sm">📂 {{ t('files.uploadFolder') }}</button>
      <button :disabled="!writable" @click="mkdir">＋ {{ t('files.newFolder') }}</button>
      <button :disabled="!writable" @click="newMarkdown">📝 {{ t('files.newMarkdown') }}</button>
      <button class="ghost" @click="load">⟳</button>
      <span class="spacer" />
      <template v-if="selected.size">
        <span class="muted">{{ t('files.selected', { n: selected.size }) }}</span>
        <button :disabled="!writable" @click="transfer('move', [...selected])">{{ t('files.move') }}</button>
        <button @click="transfer('copy', [...selected])">{{ t('files.copyTo') }}</button>
        <button class="danger" :disabled="!writable" @click="remove([...selected])">{{ t('common.delete') }}</button>
      </template>
      <input ref="fileInput" type="file" multiple hidden @change="onFiles" />
      <input ref="folderInput" type="file" webkitdirectory multiple hidden @change="onFiles" />
    </div>

    <div
      class="card dropzone"
      :class="{ over: dragOver }"
      @dragover.prevent="dragOver = writable"
      @dragleave.prevent="dragOver = false"
      @drop.prevent="onDrop"
    >
      <p v-if="dragOver" class="muted" style="text-align: center">{{ t('files.dropHere') }}</p>
      <p v-if="searchResults" class="muted">{{ t('files.searchResults') }} ({{ searchResults.length }}) <button class="small" @click="searchResults = null">✕</button></p>
      <p v-if="loading" class="muted">{{ t('common.loading') }}</p>
      <p v-else-if="error" style="color: var(--c-danger)">{{ error }}</p>
      <div v-else-if="!shown.length && path === '/' && !searchResults" class="stack" style="align-items: center; padding: 2rem">
        <p class="muted">{{ t('files.noStorage') }}</p>
        <router-link v-if="isAdmin()" class="btn primary" to="/admin/storages">{{ t('files.goStorages') }}</router-link>
      </div>
      <p v-else-if="!shown.length" class="muted" style="text-align: center; padding: 2rem 0">{{ t('files.empty') }}</p>
      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr>
              <th style="width: 28px"></th>
              <th>{{ t('common.name') }}</th>
              <th class="hide-sm">{{ t('common.size') }}</th>
              <th class="hide-sm">{{ t('common.modified') }}</th>
              <th style="text-align: right">{{ t('common.actions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="path !== '/' && !searchResults" class="clickable" @click="router.push({ path: '/files', query: { path: parentPath(path) } })">
              <td></td><td>⤴ ..</td><td class="hide-sm"></td><td class="hide-sm"></td><td></td>
            </tr>
            <tr v-for="e in shown" :key="e.path" class="clickable" @click="open(e)">
              <td @click.stop><input type="checkbox" :checked="selected.has(e.path)" @change="toggle(e.path)" /></td>
              <td>
                <span class="ficon" :class="`k-${e.isDir ? 'dir' : previewKind(e.name)}`">{{ fileIcon(e.name, e.isDir) }}</span>{{ e.name }}
                <div v-if="searchResults" class="muted mono">{{ e.path }}</div>
              </td>
              <td class="hide-sm muted">{{ e.isDir ? '—' : formatSize(e.size) }}</td>
              <td class="hide-sm muted">{{ formatDate(e.modified, locale) }}</td>
              <td style="text-align: right; white-space: nowrap" @click.stop>
                <button v-if="!e.isDir" class="ghost small" :title="t('common.download')" @click="download(e)">⬇</button>
                <button v-if="!e.isDir" class="ghost small" :title="t('files.share')" @click="sharing = e">🔗</button>
                <button v-if="isMd(e) && writable" class="ghost small" :title="t('files.openInEditor')" @click="openInEditor(e)">✏️</button>
                <button v-if="writable" class="ghost small" :title="t('files.rename')" @click="rename(e)">✎</button>
                <button v-if="writable" class="ghost small" :title="t('common.delete')" @click="remove([e.path])">🗑</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <Modal v-if="previewing" :title="previewing.name" wide @close="previewing = null">
      <template #actions>
        <button class="small" @click="download(previewing!)">⬇ {{ t('common.download') }}</button>
        <button class="small" @click="sharing = previewing">🔗 {{ t('files.share') }}</button>
        <button v-if="isMd(previewing) && writable" class="small" @click="openInEditor(previewing!)">✏️</button>
      </template>
      <Preview :name="previewing.name" :path="previewing.path" :size="previewing.size" />
    </Modal>
    <ShareDialog v-if="sharing" type="file" :storage-path="sharing.path" :title="sharing.name" @close="sharing = null" />
  </div>
</template>
