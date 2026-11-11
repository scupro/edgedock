<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { formatSize } from '../lib/format';
import { t } from '../lib/i18n';
import type { PersistedUpload } from '../lib/idb';
import { toast } from '../lib/store';
import { cancel, clearFinished, forgetPending, pause, pendingUploads, resume, resumePending, retry, uploads, type UploadTask } from '../lib/upload';

const open = ref(true);
const pending = ref<PersistedUpload[]>([]);
const refreshPending = async () => (pending.value = await pendingUploads());
onMounted(refreshPending);

const visible = computed(() => uploads.tasks.length > 0 || pending.value.length > 0);
const isActive = (x: UploadTask) => ['uploading', 'queued', 'paused', 'offline', 'retrying'].includes(x.status);
const active = computed(() => uploads.tasks.filter(isActive).length);
watch(
  () => uploads.tasks.filter(isActive).length,
  (n, prev) => {
    if (n > 0) open.value = true;
    else if (prev > 0 && !pending.value.length) setTimeout(() => (open.value = false), 1500);
    void refreshPending();
  },
);
const totalPct = computed(() => {
  const size = uploads.tasks.reduce((a, x) => a + x.size, 0);
  const loaded = uploads.tasks.reduce((a, x) => a + Math.min(x.loaded, x.size), 0);
  return size ? Math.round((loaded / size) * 100) : 0;
});
const pct = (l: number, s: number) => (s ? Math.min(100, Math.round((l / s) * 100)) : 100);
function fmtEta(sec?: number): string {
  if (sec === undefined || !isFinite(sec)) return '';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, '0')}s`;
  return `${Math.floor(sec / 3600)}h${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}m`;
}

async function forget(p: PersistedUpload) {
  await forgetPending(p);
  await refreshPending();
}

const picker = ref<HTMLInputElement | null>(null);
let picking: PersistedUpload | null = null;
function reselect(p: PersistedUpload) {
  picking = p;
  picker.value?.click();
}
async function onPicked(e: Event) {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  input.value = '';
  if (!f || !picking) return;
  if (!(await resumePending(picking, f))) toast(t('upload.mismatch'));
  picking = null;
  await refreshPending();
}
</script>

<template>
  <div v-if="visible" class="card upload-panel stack">
    <input ref="picker" type="file" hidden @change="onPicked" />
    <div class="row">
      <strong>{{ t('upload.title') }}</strong>
      <span class="muted">{{ active }} · {{ totalPct }}%</span>
      <span class="spacer" />
      <button class="small" @click="clearFinished">{{ t('upload.clear') }}</button>
      <button class="ghost small" @click="open = !open">{{ open ? '▾' : '▴' }}</button>
    </div>
    <div v-if="!uploads.online" class="muted" style="color: var(--c-warn, #b7791f)">{{ t('upload.offline') }}</div>
    <div v-if="open" class="list stack">
      <div v-for="task in uploads.tasks" :key="task.id" class="stack" style="gap: 0.25rem">
        <div class="row">
          <span class="mono" style="flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap" :title="task.path">{{ task.path }}</span>
          <span class="badge" :class="{ danger: task.status === 'error', warn: ['canceled', 'paused', 'offline', 'retrying'].includes(task.status) }">{{ t(`upload.status.${task.status}` as any) }}</span>
        </div>
        <div class="progress"><div :style="{ width: pct(task.loaded, task.size) + '%' }" /></div>
        <div class="row muted" style="flex-wrap: wrap">
          <span>{{ formatSize(task.loaded) }} / {{ formatSize(task.size) }}</span>
          <span v-if="task.speed && task.status === 'uploading'">· {{ formatSize(task.speed) }}/s</span>
          <span v-if="task.eta && task.status === 'uploading'">· {{ t('upload.eta', { t: fmtEta(task.eta) }) }}</span>
          <span v-if="task.retries">· {{ t('upload.retries', { n: task.retries }) }}</span>
          <span v-if="task.strategy">· {{ task.strategy }}</span>
          <span class="spacer" />
          <button v-if="task.status === 'uploading' || task.status === 'retrying'" class="small" @click="pause(task)">{{ t('upload.pause') }}</button>
          <button v-if="task.status === 'paused'" class="small" @click="resume(task)">{{ t('upload.resume') }}</button>
          <button v-if="isActive(task)" class="small" @click="cancel(task)">{{ t('upload.cancel') }}</button>
          <button v-if="task.status === 'error' || task.status === 'canceled'" class="small" @click="retry(task)">{{ t('upload.retry') }}</button>
        </div>
        <div v-if="task.error" class="muted" style="color: var(--c-danger)">{{ task.error }}</div>
      </div>
      <div v-if="pending.length" class="stack" style="gap: 0.25rem">
        <span class="muted">{{ t('upload.pending') }}</span>
        <div v-for="p in pending" :key="p.fingerprint" class="row muted">
          <span class="mono" style="flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis">{{ p.path }} ({{ formatSize(p.size) }} · {{ p.uploadedParts.length }}/{{ p.totalParts }})</span>
          <button class="small" @click="reselect(p)">{{ t('upload.reselect') }}</button>
          <button class="ghost small" :title="t('common.delete')" @click="forget(p)">✕</button>
        </div>
      </div>
    </div>
  </div>
</template>
