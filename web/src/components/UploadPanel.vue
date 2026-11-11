<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { formatSize } from '../lib/format';
import { t } from '../lib/i18n';
import { cancel, clearFinished, pendingUploads, removePending, retry, uploads } from '../lib/upload';

const open = ref(true);
const visible = computed(() => uploads.tasks.length > 0);
const active = computed(() => uploads.tasks.filter((x) => x.status === 'uploading' || x.status === 'queued').length);
const pending = ref(pendingUploads());
// collapse automatically once everything has finished
watch(
  () => uploads.tasks.filter((x) => x.status === 'uploading' || x.status === 'queued').length,
  (n, prev) => {
    if (n > 0) open.value = true;
    else if (prev > 0) setTimeout(() => (open.value = false), 1500);
    pending.value = pendingUploads();
  },
);
const totalPct = computed(() => {
  const size = uploads.tasks.reduce((a, x) => a + x.size, 0);
  const loaded = uploads.tasks.reduce((a, x) => a + Math.min(x.loaded, x.size), 0);
  return size ? Math.round((loaded / size) * 100) : 0;
});
const pct = (l: number, s: number) => (s ? Math.min(100, Math.round((l / s) * 100)) : 100);
function forget(id: string) {
  removePending(id);
  pending.value = pendingUploads();
}
</script>

<template>
  <div v-if="visible" class="card upload-panel stack">
    <div class="row">
      <strong>{{ t('upload.title') }}</strong>
      <span class="muted">{{ active }} · {{ totalPct }}%</span>
      <span class="spacer" />
      <button class="small" @click="clearFinished">{{ t('upload.clear') }}</button>
      <button class="ghost small" @click="open = !open">{{ open ? '▾' : '▴' }}</button>
    </div>
    <div v-if="open" class="list stack">
      <div v-for="task in uploads.tasks" :key="task.id" class="stack" style="gap: 0.25rem">
        <div class="row">
          <span class="mono" style="flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap" :title="task.path">{{ task.path }}</span>
          <span class="badge" :class="{ danger: task.status === 'error', warn: task.status === 'canceled' }">{{ t(`upload.status.${task.status}` as any) }}</span>
        </div>
        <div class="progress"><div :style="{ width: pct(task.loaded, task.size) + '%' }" /></div>
        <div class="row muted">
          <span>{{ formatSize(task.loaded) }} / {{ formatSize(task.size) }}</span>
          <span v-if="task.speed && task.status === 'uploading'">· {{ formatSize(task.speed) }}/s</span>
          <span v-if="task.strategy">· {{ task.strategy }}</span>
          <span class="spacer" />
          <button v-if="task.status === 'uploading' || task.status === 'queued'" class="small" @click="cancel(task)">{{ t('upload.cancel') }}</button>
          <button v-if="task.status === 'error' || task.status === 'canceled'" class="small" @click="retry(task)">{{ t('upload.retry') }}</button>
        </div>
        <div v-if="task.error" class="muted" style="color: var(--c-danger)">{{ task.error }}</div>
      </div>
      <div v-if="pending.length" class="stack" style="gap: 0.25rem">
        <span class="muted">{{ t('upload.pending') }}</span>
        <div v-for="p in pending" :key="p.sessionId" class="row muted">
          <span class="mono" style="flex: 1">{{ p.path }} ({{ formatSize(p.size) }})</span>
          <button class="ghost small" @click="forget(p.sessionId)">✕</button>
        </div>
      </div>
    </div>
  </div>
</template>
