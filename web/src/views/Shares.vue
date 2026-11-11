<script setup lang="ts">
import { onMounted, ref } from 'vue';
import ShareDialog from '../components/ShareDialog.vue';
import { absoluteUrl, api } from '../lib/api';
import { copyText, formatDate } from '../lib/format';
import { locale, t } from '../lib/i18n';
import { toast } from '../lib/store';

const shares = ref<any[]>([]);
const editing = ref<any>(null);
const creatingText = ref(false);
const loading = ref(true);

async function load() {
  loading.value = true;
  try {
    shares.value = await api('/api/shares');
  } finally {
    loading.value = false;
  }
}
onMounted(load);

const pageUrl = (s: any) => `${location.origin}/s/${s.slug}`;
const rawUrl = (s: any) => absoluteUrl(`/raw/${s.slug}`);

async function copy(text: string) {
  if (await copyText(text)) toast(t('common.copied'));
}
async function remove(s: any) {
  if (!confirm(t('common.confirmDelete'))) return;
  await api(`/api/shares/${s.id}`, { method: 'DELETE' });
  load();
}
async function resetViews(s: any) {
  await api(`/api/shares/${s.id}/reset-views`, { method: 'POST' });
  load();
}
const stateClass = (st: string) => (st === 'ok' ? '' : st === 'expired' ? 'danger' : 'warn');
</script>

<template>
  <div class="container stack">
    <div class="row">
      <h1 style="margin: 0">{{ t('nav.shares') }}</h1>
      <span class="spacer" />
      <router-link class="btn" to="/editor">📝 {{ t('nav.editor') }}</router-link>
      <button class="primary" @click="creatingText = true">＋ {{ t('share.newText') }}</button>
    </div>
    <div class="card">
      <p v-if="loading" class="muted">{{ t('common.loading') }}</p>
      <p v-else-if="!shares.length" class="muted">{{ t('share.empty') }}</p>
      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{{ t('common.name') }}</th>
              <th>{{ t('storage.type') }}</th>
              <th>{{ t('share.views') }}</th>
              <th class="hide-sm">{{ t('share.expires') }}</th>
              <th></th>
              <th style="text-align: right">{{ t('common.actions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="s in shares" :key="s.id">
              <td>
                <a :href="pageUrl(s)" target="_blank">{{ s.title || s.slug }}</a>
                <span v-if="s.hasPassword" title="password"> 🔒</span>
                <div class="muted mono">/s/{{ s.slug }}<template v-if="s.storagePath"> · {{ s.storagePath }}</template></div>
              </td>
              <td>{{ t(`share.type.${s.type}` as any) }}</td>
              <td>{{ s.views }}<template v-if="s.maxViews"> / {{ s.maxViews }}</template></td>
              <td class="hide-sm muted">{{ s.expiresAt ? formatDate(s.expiresAt, locale) : t('common.never') }}</td>
              <td><span class="badge" :class="stateClass(s.state)">{{ t(`share.state.${s.state}` as any) }}</span></td>
              <td style="text-align: right; white-space: nowrap">
                <button class="ghost small" @click="copy(pageUrl(s))">🔗</button>
                <button class="ghost small" title="Raw" @click="copy(rawUrl(s))">RAW</button>
                <button class="ghost small" @click="editing = s">✎</button>
                <button v-if="s.maxViews" class="ghost small" :title="t('share.resetViews')" @click="resetViews(s)">↺</button>
                <button class="ghost small" @click="remove(s)">🗑</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
    <ShareDialog v-if="editing" :type="editing.type" :existing="editing" @saved="load" @close="editing = null" />
    <ShareDialog v-if="creatingText" type="text" @saved="load" @close="creatingText = false" />
  </div>
</template>
