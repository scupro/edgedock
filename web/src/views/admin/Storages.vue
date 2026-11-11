<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import Modal from '../../components/Modal.vue';
import { api } from '../../lib/api';
import { locale, t } from '../../lib/i18n';
import { toast } from '../../lib/store';

interface Field { key: string; label: string; type: string; secret?: boolean; required?: boolean; default?: any; placeholder?: string; help?: string; options?: { value: string; label: string }[] }
interface DriverType { type: string; label: string; fields: Field[] }

const storages = ref<any[]>([]);
const types = ref<DriverType[]>([]);
const editing = ref<any>(null);
const form = reactive<{ name: string; type: string; mountPath: string; isDefault: boolean; enabled: boolean; config: Record<string, any> }>({
  name: '', type: 's3', mountPath: '/', isDefault: false, enabled: true, config: {},
});
const testing = ref(false);
const testResult = ref<{ ok: boolean; error?: string } | null>(null);

/** S3 provider presets: endpoint hints + addressing style */
const PRESETS: Record<string, { endpoint: string; region: string; pathStyle: boolean }> = {
  r2: { endpoint: 'https://<ACCOUNT_ID>.r2.cloudflarestorage.com', region: 'auto', pathStyle: true },
  b2: { endpoint: 'https://s3.us-west-004.backblazeb2.com', region: 'us-west-004', pathStyle: false },
  aws: { endpoint: 'https://s3.us-east-1.amazonaws.com', region: 'us-east-1', pathStyle: false },
  oss: { endpoint: 'https://oss-cn-hangzhou.aliyuncs.com', region: 'oss-cn-hangzhou', pathStyle: false },
  cos: { endpoint: 'https://cos.ap-guangzhou.myqcloud.com', region: 'ap-guangzhou', pathStyle: false },
  minio: { endpoint: 'http://minio:9000', region: 'us-east-1', pathStyle: true },
  other: { endpoint: '', region: 'us-east-1', pathStyle: true },
};

const currentType = computed(() => types.value.find((x) => x.type === form.type));

async function load() {
  [storages.value, types.value] = await Promise.all([api('/api/storages'), api('/api/storages/types')]);
}
onMounted(load);

function openNew() {
  editing.value = { isNew: true };
  testResult.value = null;
  Object.assign(form, { name: '', type: types.value[0]?.type ?? 's3', mountPath: '/', isDefault: storages.value.length === 0, enabled: true, config: {} });
  applyDefaults();
}

function openEdit(s: any) {
  editing.value = s;
  testResult.value = null;
  Object.assign(form, { name: s.name, type: s.type, mountPath: s.mountPath, isDefault: s.isDefault, enabled: s.enabled, config: { ...s.config } });
}

function applyDefaults() {
  const cfg: Record<string, any> = {};
  for (const f of currentType.value?.fields ?? []) if (f.default !== undefined) cfg[f.key] = f.default;
  form.config = cfg;
  if (form.type === 's3') applyPreset();
}

function applyPreset() {
  const p = PRESETS[form.config.provider ?? 'r2'];
  if (!p) return;
  const isPresetValue = !form.config.endpoint || Object.values(PRESETS).some((x) => x.endpoint === form.config.endpoint);
  // templated endpoints (with <ACCOUNT_ID>) are shown as placeholder only
  if (isPresetValue) form.config.endpoint = p.endpoint.includes('<') ? '' : p.endpoint;
  form.config.region = p.region;
  form.config.pathStyle = p.pathStyle;
}
const presetHint = computed(() => (form.type === 's3' ? PRESETS[form.config.provider ?? 'r2']?.endpoint : ''));

/** zh-TW labels for driver fields (server definitions are in English) */
const ZH_LABELS: Record<string, string> = {
  provider: '服務商預設', endpoint: 'Endpoint 端點', region: '區域 Region', bucket: 'Bucket 名稱', root: '根目錄前綴',
  pathStyle: 'Path-style 位址（MinIO / R2 / 自訂端點請勾選）', accessKeyId: 'Access Key ID', secretAccessKey: 'Secret Access Key',
  presignExpires: '預簽名有效秒數', directDownload: '下載時直接轉址到預簽名 URL（節省 Worker 流量）', url: 'WebDAV 網址', username: '使用者名稱', password: '密碼',
};
const fieldLabel = (f: Field) => (locale.value === 'zh-TW' && ZH_LABELS[f.key]) || f.label;

function payload() {
  const config: Record<string, any> = {};
  for (const f of currentType.value?.fields ?? []) {
    const v = form.config[f.key];
    if (f.secret && (v === undefined || v === '')) continue;
    config[f.key] = v;
  }
  return { name: form.name, type: form.type, mountPath: form.mountPath, isDefault: form.isDefault, enabled: form.enabled, config };
}

async function save() {
  try {
    if (editing.value.isNew) await api('/api/storages', { body: payload() });
    else await api(`/api/storages/${editing.value.id}`, { method: 'PUT', body: payload() });
    editing.value = null;
    await load();
  } catch (e) {
    toast((e as Error).message);
  }
}

async function test() {
  testing.value = true;
  testResult.value = null;
  try {
    testResult.value = await api('/api/storages/test', { body: { id: editing.value.isNew ? undefined : editing.value.id, type: form.type, config: payload().config } });
  } catch (e) {
    testResult.value = { ok: false, error: (e as Error).message };
  } finally {
    testing.value = false;
  }
}

async function setDefault(s: any) {
  await api(`/api/storages/${s.id}/default`, { method: 'POST' });
  load();
}
async function remove(s: any) {
  if (!confirm(t('common.confirmDelete'))) return;
  await api(`/api/storages/${s.id}`, { method: 'DELETE' });
  load();
}
const secretSaved = (f: Field) => !editing.value?.isNew && editing.value?.secretFields?.includes(f.key) && editing.value?.hasSecret;
</script>

<template>
  <div class="container stack">
    <div class="row">
      <h1 style="margin: 0">{{ t('nav.storages') }}</h1>
      <span class="spacer" />
      <button class="primary" @click="openNew">＋ {{ t('storage.add') }}</button>
    </div>
    <div class="card">
      <p v-if="!storages.length" class="muted">{{ t('storage.empty') }}</p>
      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr><th>{{ t('common.name') }}</th><th>{{ t('storage.type') }}</th><th>{{ t('storage.mountPath') }}</th><th></th><th style="text-align: right">{{ t('common.actions') }}</th></tr>
          </thead>
          <tbody>
            <tr v-for="s in storages" :key="s.id">
              <td>{{ s.name }}</td>
              <td>{{ s.type }}<span v-if="s.config.provider" class="muted"> · {{ s.config.provider }}</span></td>
              <td class="mono">{{ s.mountPath }}</td>
              <td>
                <span v-if="s.isDefault" class="badge">{{ t('common.default') }}</span>
                <span v-if="!s.enabled" class="badge warn">off</span>
              </td>
              <td style="text-align: right; white-space: nowrap">
                <button v-if="!s.isDefault" class="small" @click="setDefault(s)">{{ t('storage.setDefault') }}</button>
                <button class="ghost small" @click="openEdit(s)">✎</button>
                <button class="ghost small" @click="remove(s)">🗑</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="muted" style="margin-bottom: 0">{{ t('storage.corsHint') }}</p>
    </div>

    <Modal v-if="editing" :title="editing.isNew ? t('storage.add') : t('storage.edit')" @close="editing = null">
      <form class="stack" @submit.prevent="save">
        <div class="grid2">
          <label class="field"><span>{{ t('common.name') }}</span><input v-model="form.name" required /></label>
          <label class="field">
            <span>{{ t('storage.type') }}</span>
            <select v-model="form.type" :disabled="!editing.isNew" @change="applyDefaults">
              <option v-for="d in types" :key="d.type" :value="d.type">{{ d.label }}</option>
            </select>
          </label>
          <label class="field"><span>{{ t('storage.mountPath') }}</span><input v-model="form.mountPath" required class="mono" :placeholder="t('storage.mountHint')" /></label>
        </div>
        <template v-for="f in currentType?.fields ?? []" :key="f.key">
          <label v-if="f.type === 'boolean'" class="check"><input type="checkbox" v-model="form.config[f.key]" />{{ fieldLabel(f) }}</label>
          <label v-else class="field">
            <span>{{ fieldLabel(f) }}<template v-if="!f.required"> ({{ t('common.optional') }})</template></span>
            <select v-if="f.type === 'select'" v-model="form.config[f.key]" @change="f.key === 'provider' && applyPreset()">
              <option v-for="o in f.options" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
            <input
              v-else
              v-model="form.config[f.key]"
              :type="f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : 'text'"
              :required="f.required && !secretSaved(f)"
              :placeholder="secretSaved(f) ? t('storage.secretKept') : f.key === 'endpoint' && presetHint ? presetHint : f.placeholder"
              autocomplete="off"
            />
          </label>
        </template>
        <div class="row">
          <label class="check"><input type="checkbox" v-model="form.enabled" />{{ t('common.enabled') }}</label>
          <label class="check"><input type="checkbox" v-model="form.isDefault" />{{ t('common.default') }}</label>
        </div>
        <p v-if="testResult" :style="{ color: testResult.ok ? 'var(--c-primary)' : 'var(--c-danger)' }">
          {{ testResult.ok ? t('storage.testOk') : t('storage.testFail') + ': ' + testResult.error }}
        </p>
        <div class="row">
          <button type="button" :disabled="testing" @click="test">{{ t('common.test') }}</button>
          <span class="spacer" />
          <button type="button" @click="editing = null">{{ t('common.cancel') }}</button>
          <button class="primary" type="submit">{{ t('common.save') }}</button>
        </div>
      </form>
    </Modal>
  </div>
</template>
