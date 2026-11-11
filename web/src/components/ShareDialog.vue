<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import Modal from './Modal.vue';
import { absoluteUrl, api } from '../lib/api';
import { copyText } from '../lib/format';
import { t } from '../lib/i18n';
import { toast } from '../lib/store';

const props = defineProps<{
  type: 'markdown' | 'text' | 'file';
  storagePath?: string;
  content?: string;
  title?: string;
  /** when set, edit this existing share */
  existing?: any;
}>();
const emit = defineEmits<{ close: []; saved: [share: any] }>();

const form = reactive({
  title: props.existing?.title ?? props.title ?? '',
  password: '',
  removePassword: false,
  expiry: props.existing?.expiresAt ? 'custom' : 'never',
  custom: props.existing?.expiresAt ? toLocalInput(props.existing.expiresAt) : '',
  maxViews: props.existing?.maxViews ?? (null as number | null),
  slug: '',
  content: props.content ?? '',
});
const result = ref<any>(null);
const busy = ref(false);
const err = ref('');

function toLocalInput(ms: number) {
  const d = new Date(ms - new Date().getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}

const expiresAt = computed<number | null>(() => {
  const h = 3600_000;
  switch (form.expiry) {
    case '1h': return Date.now() + h;
    case '1d': return Date.now() + 24 * h;
    case '7d': return Date.now() + 7 * 24 * h;
    case '30d': return Date.now() + 30 * 24 * h;
    case 'custom': return form.custom ? new Date(form.custom).getTime() : null;
    default: return null;
  }
});

const links = computed(() =>
  result.value
    ? {
        page: `${location.origin}/s/${result.value.slug}`,
        raw: absoluteUrl(`/raw/${result.value.slug}`),
      }
    : null,
);

async function submit() {
  busy.value = true;
  err.value = '';
  try {
    if (props.existing) {
      const patch: any = { title: form.title, expiresAt: expiresAt.value, maxViews: form.maxViews || null };
      if (form.removePassword) patch.password = null;
      else if (form.password) patch.password = form.password;
      result.value = await api(`/api/shares/${props.existing.id}`, { method: 'PATCH', body: patch });
    } else {
      result.value = await api('/api/shares', {
        body: {
          type: props.type,
          title: form.title || undefined,
          content: props.type === 'file' ? undefined : props.content ?? form.content,
          storagePath: props.storagePath,
          password: form.password || undefined,
          expiresAt: expiresAt.value,
          maxViews: form.maxViews || null,
          slug: form.slug || undefined,
        },
      });
    }
    emit('saved', result.value);
  } catch (e) {
    err.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

async function copy(s: string) {
  if (await copyText(s)) toast(t('common.copied'));
}
</script>

<template>
  <Modal :title="existing ? t('share.editTitle') : t('share.title')" @close="emit('close')">
    <div v-if="!result || existing" class="stack">
      <p v-if="storagePath" class="mono muted">{{ storagePath }}</p>
      <label class="field"><span>{{ t('editor.title') }}</span><input v-model="form.title" /></label>
      <label v-if="type === 'text' && content === undefined && !existing" class="field">
        <span>{{ t('share.type.text') }}</span><textarea v-model="form.content" rows="8" />
      </label>
      <label class="field">
        <span>{{ t('share.password') }}</span>
        <input v-model="form.password" type="password" autocomplete="new-password" :placeholder="existing?.hasPassword ? t('share.keepPassword') : t('share.passwordPlaceholder')" />
      </label>
      <label v-if="existing?.hasPassword" class="check"><input type="checkbox" v-model="form.removePassword" />{{ t('share.removePassword') }}</label>
      <div class="grid2">
        <label class="field">
          <span>{{ t('share.expiry') }}</span>
          <select v-model="form.expiry">
            <option value="never">{{ t('share.expiry.never') }}</option>
            <option value="1h">{{ t('share.expiry.1h') }}</option>
            <option value="1d">{{ t('share.expiry.1d') }}</option>
            <option value="7d">{{ t('share.expiry.7d') }}</option>
            <option value="30d">{{ t('share.expiry.30d') }}</option>
            <option value="custom">{{ t('share.expiry.custom') }}</option>
          </select>
        </label>
        <label v-if="form.expiry === 'custom'" class="field"><span>&nbsp;</span><input v-model="form.custom" type="datetime-local" /></label>
        <label class="field">
          <span>{{ t('share.maxViews') }}</span>
          <input v-model.number="form.maxViews" type="number" min="0" :placeholder="t('share.maxViewsHint')" />
        </label>
        <label v-if="!existing" class="field">
          <span>{{ t('share.slug') }}</span>
          <input v-model="form.slug" :placeholder="t('share.slugHint')" pattern="[A-Za-z0-9_-]{3,64}" />
        </label>
      </div>
      <p v-if="err" style="color: var(--c-danger)">{{ err }}</p>
      <div class="row">
        <span class="spacer" />
        <button @click="emit('close')">{{ t('common.cancel') }}</button>
        <button class="primary" :disabled="busy" @click="submit">{{ existing ? t('common.save') : t('common.create') }}</button>
      </div>
    </div>
    <div v-if="links" class="stack" :style="existing ? 'margin-top:1rem' : ''">
      <label class="field">
        <span>{{ t('share.link') }}</span>
        <div class="row"><input :value="links.page" readonly style="flex: 1" /><button @click="copy(links.page)">{{ t('common.copy') }}</button></div>
      </label>
      <label class="field">
        <span>{{ t('share.raw') }}</span>
        <div class="row"><input :value="links.raw" readonly style="flex: 1" /><button @click="copy(links.raw)">{{ t('common.copy') }}</button></div>
      </label>
      <p v-if="result.hasPassword" class="muted">Raw: <span class="mono">?password=…</span></p>
      <div class="row"><span class="spacer" /><button class="primary" @click="emit('close')">{{ t('common.close') }}</button></div>
    </div>
  </Modal>
</template>
