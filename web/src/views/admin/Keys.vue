<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import Modal from '../../components/Modal.vue';
import { absoluteUrl, api } from '../../lib/api';
import { copyText, formatDate } from '../../lib/format';
import { locale, t } from '../../lib/i18n';
import { toast } from '../../lib/store';

const keys = ref<any[]>([]);
const creating = ref(false);
const created = ref<any>(null);
const form = reactive({ name: '', permission: 'read', pathPrefix: '/', expiresInDays: null as number | null });
const davUrl = absoluteUrl('/dav/');

async function load() {
  keys.value = await api('/api/admin/keys');
}
onMounted(load);

async function create() {
  try {
    created.value = await api('/api/admin/keys', { body: { ...form, expiresInDays: form.expiresInDays || undefined } });
    creating.value = false;
    Object.assign(form, { name: '', permission: 'read', pathPrefix: '/', expiresInDays: null });
    load();
  } catch (e) {
    toast((e as Error).message);
  }
}
async function revoke(k: any) {
  await api(`/api/admin/keys/${k.id}/revoke`, { method: 'POST' });
  load();
}
async function remove(k: any) {
  if (!confirm(t('common.confirmDelete'))) return;
  await api(`/api/admin/keys/${k.id}`, { method: 'DELETE' });
  load();
}
async function copy(s: string) {
  if (await copyText(s)) toast(t('common.copied'));
}
function status(k: any) {
  if (k.revokedAt) return ['danger', t('keys.revoked')];
  if (k.expiresAt && k.expiresAt < Date.now()) return ['warn', t('keys.expired')];
  return ['', t('keys.active')];
}
</script>

<template>
  <div class="container stack">
    <div class="row">
      <h1 style="margin: 0">{{ t('nav.keys') }}</h1>
      <span class="spacer" />
      <button class="primary" @click="creating = true">＋ {{ t('keys.create') }}</button>
    </div>
    <p class="muted">{{ t('keys.webdavHint', { url: davUrl }) }}</p>
    <div v-if="created" class="card stack" style="border-color: var(--c-primary)">
      <strong>{{ t('keys.showOnce') }}</strong>
      <div class="row"><input :value="created.key" readonly class="mono" style="flex: 1" /><button @click="copy(created.key)">{{ t('common.copy') }}</button><button class="ghost" @click="created = null">✕</button></div>
    </div>
    <div class="card">
      <p v-if="!keys.length" class="muted">{{ t('keys.empty') }}</p>
      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{{ t('common.name') }}</th><th>{{ t('keys.permission') }}</th><th>{{ t('keys.pathPrefix') }}</th>
              <th class="hide-sm">{{ t('share.expires') }}</th><th class="hide-sm">{{ t('keys.lastUsed') }}</th><th></th><th style="text-align: right">{{ t('common.actions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="k in keys" :key="k.id">
              <td>{{ k.name }}<div class="muted mono">{{ k.prefix }}…</div></td>
              <td>{{ k.permission === 'read' ? t('keys.read') : t('keys.readwrite') }}</td>
              <td class="mono">{{ k.pathPrefix }}</td>
              <td class="hide-sm muted">{{ k.expiresAt ? formatDate(k.expiresAt, locale) : t('common.never') }}</td>
              <td class="hide-sm muted">{{ formatDate(k.lastUsedAt, locale) }}</td>
              <td><span class="badge" :class="status(k)[0]">{{ status(k)[1] }}</span></td>
              <td style="text-align: right; white-space: nowrap">
                <button v-if="!k.revokedAt" class="small" @click="revoke(k)">{{ t('keys.revoke') }}</button>
                <button class="ghost small" @click="remove(k)">🗑</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
    <Modal v-if="creating" :title="t('keys.create')" @close="creating = false">
      <form class="stack" @submit.prevent="create">
        <label class="field"><span>{{ t('common.name') }}</span><input v-model="form.name" required /></label>
        <label class="field">
          <span>{{ t('keys.permission') }}</span>
          <select v-model="form.permission"><option value="read">{{ t('keys.read') }}</option><option value="readwrite">{{ t('keys.readwrite') }}</option></select>
        </label>
        <label class="field"><span>{{ t('keys.pathPrefix') }}</span><input v-model="form.pathPrefix" class="mono" /></label>
        <label class="field"><span>{{ t('keys.expiresInDays') }} ({{ t('common.optional') }})</span><input v-model.number="form.expiresInDays" type="number" min="1" /></label>
        <div class="row"><span class="spacer" /><button type="button" @click="creating = false">{{ t('common.cancel') }}</button><button class="primary" type="submit">{{ t('common.create') }}</button></div>
      </form>
    </Modal>
  </div>
</template>
