<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { api } from '../../lib/api';
import { formatDate } from '../../lib/format';
import { locale, t } from '../../lib/i18n';
import { loadStatus, store, toast } from '../../lib/store';

const s = reactive<Record<string, any>>({});
const runs = ref<any[]>([]);
const syncJobs = ref<any[]>([]);
const sync = reactive({ name: '', sourcePath: '', targetPath: '', overwrite: false });
const pw = reactive({ oldPassword: '', newPassword: '' });

async function load() {
  Object.assign(s, await api('/api/admin/settings'));
  runs.value = await api('/api/admin/jobs/runs');
  syncJobs.value = await api('/api/admin/sync');
}
onMounted(load);

async function save() {
  Object.assign(s, await api('/api/admin/settings', { method: 'PUT', body: s }));
  await loadStatus();
  toast(t('settings.saved'));
}
async function rebuild() {
  await api('/api/admin/jobs/index', { method: 'POST' });
  toast(t('settings.started'));
  setTimeout(load, 2000);
}
async function addSync() {
  await api('/api/admin/sync', { body: sync });
  Object.assign(sync, { name: '', sourcePath: '', targetPath: '', overwrite: false });
  load();
}
async function runSync(j: any) {
  await api(`/api/admin/sync/${j.id}/run`, { method: 'POST' });
  toast(t('settings.started'));
  setTimeout(load, 2000);
}
async function delSync(j: any) {
  if (!confirm(t('common.confirmDelete'))) return;
  await api(`/api/admin/sync/${j.id}`, { method: 'DELETE' });
  load();
}
async function changePassword() {
  try {
    await api('/api/auth/password', { body: pw });
    Object.assign(pw, { oldPassword: '', newPassword: '' });
    toast(t('settings.saved'));
  } catch (e) {
    toast((e as Error).message);
  }
}
</script>

<template>
  <div class="container stack">
    <h1>{{ t('nav.settings') }}</h1>
    <form class="card stack" @submit.prevent="save">
      <h2>{{ t('settings.general') }}</h2>
      <div class="grid2">
        <label class="field"><span>{{ t('settings.siteTitle') }}</span><input v-model="s.siteTitle" /></label>
        <label class="field">
          <span>{{ t('settings.defaultLanguage') }}</span>
          <select v-model="s.defaultLanguage"><option value="zh-TW">正體中文</option><option value="en">English</option></select>
        </label>
        <label class="field"><span>{{ t('settings.webdavCacheTtl') }}</span><input v-model.number="s.webdavCacheTtl" type="number" min="0" /></label>
        <label class="field"><span>{{ t('settings.uploadPartSizeMB') }}</span><input v-model.number="s.uploadPartSizeMB" type="number" min="5" /></label>
        <label class="field"><span>{{ t('settings.multipartThresholdMB') }}</span><input v-model.number="s.multipartThresholdMB" type="number" min="5" /></label>
        <label class="field"><span>{{ t('settings.maxShareContentKB') }}</span><input v-model.number="s.maxShareContentKB" type="number" min="1" max="1800" /></label>
        <label class="field"><span>{{ t('settings.uploadSessionTtlHours') }}</span><input v-model.number="s.uploadSessionTtlHours" type="number" min="1" /></label>
        <label class="field"><span>{{ t('settings.uploadConcurrency') }}</span><input v-model.number="s.uploadConcurrency" type="number" min="1" max="8" /></label>
        <label class="field"><span>{{ t('settings.uploadRetries') }}</span><input v-model.number="s.uploadRetries" type="number" min="1" max="10" /></label>
        <label class="field"><span>{{ t('settings.uploadChunkTimeoutSec') }}</span><input v-model.number="s.uploadChunkTimeoutSec" type="number" min="10" /></label>
        <label class="field"><span>{{ t('settings.proxyMaxChunkMB') }}</span><input v-model.number="s.proxyMaxChunkMB" type="number" min="5" max="95" /></label>
        <label class="field"><span>{{ t('settings.externalPreviewExts') }}</span><input v-model="s.externalPreviewExts" class="mono" /></label>
      </div>
      <label class="field">
        <span>{{ t('settings.externalPreviewTemplate') }}</span>
        <input v-model="s.externalPreviewTemplate" class="mono" placeholder="https://kkfileview.example.com/onlinePreview?url={base64}" />
        <small class="muted">{{ t('settings.externalPreviewHint') }}</small>
      </label>
      <div class="row"><span class="muted">runtime: {{ store.runtime }}</span><span class="spacer" /><button class="primary" type="submit">{{ t('common.save') }}</button></div>
    </form>

    <div class="card stack">
      <div class="row"><h2 style="margin: 0">{{ t('settings.jobs') }}</h2><span class="spacer" /><button @click="rebuild">🔎 {{ t('settings.rebuildIndex') }}</button><button class="ghost" @click="load">⟳</button></div>
      <h3 class="muted" style="font-size: 0.9rem">{{ t('settings.sync') }}</h3>
      <form class="row" @submit.prevent="addSync">
        <input v-model="sync.name" :placeholder="t('common.name')" style="max-width: 160px" />
        <input v-model="sync.sourcePath" :placeholder="t('settings.syncSource')" class="mono" style="max-width: 220px" required />
        <span>→</span>
        <input v-model="sync.targetPath" :placeholder="t('settings.syncTarget')" class="mono" style="max-width: 220px" required />
        <label class="check"><input type="checkbox" v-model="sync.overwrite" />{{ t('settings.syncOverwrite') }}</label>
        <button type="submit">＋</button>
      </form>
      <table v-if="syncJobs.length">
        <tbody>
          <tr v-for="j in syncJobs" :key="j.id">
            <td>{{ j.name }}</td>
            <td class="mono">{{ j.source_path }} → {{ j.target_path }}</td>
            <td class="muted">{{ j.last_status || '—' }}</td>
            <td style="text-align: right; white-space: nowrap"><button class="small" @click="runSync(j)">{{ t('settings.syncRun') }}</button><button class="ghost small" @click="delSync(j)">🗑</button></td>
          </tr>
        </tbody>
      </table>
      <h3 class="muted" style="font-size: 0.9rem">{{ t('settings.runs') }}</h3>
      <table v-if="runs.length">
        <tbody>
          <tr v-for="r in runs" :key="r.id">
            <td>{{ r.kind }}</td>
            <td><span class="badge" :class="{ danger: r.status === 'failed', warn: r.status === 'running' }">{{ r.status }}</span></td>
            <td class="muted">{{ formatDate(r.started_at, locale) }}</td>
            <td class="muted mono" style="max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">{{ r.detail }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <form class="card stack" style="max-width: 480px" @submit.prevent="changePassword">
      <h2>{{ t('settings.password') }}</h2>
      <label class="field"><span>{{ t('settings.oldPassword') }}</span><input v-model="pw.oldPassword" type="password" autocomplete="current-password" required /></label>
      <label class="field"><span>{{ t('settings.newPassword') }}</span><input v-model="pw.newPassword" type="password" autocomplete="new-password" minlength="8" required /></label>
      <div class="row"><span class="spacer" /><button class="primary" type="submit">{{ t('common.save') }}</button></div>
    </form>
  </div>
</template>
