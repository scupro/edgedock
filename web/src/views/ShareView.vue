<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import Preview from '../components/Preview.vue';
import { ApiError, api, apiUrl } from '../lib/api';
import { copyText, formatSize } from '../lib/format';
import { t } from '../lib/i18n';
import { renderMarkdown } from '../lib/markdown';
import { toast } from '../lib/store';

const route = useRoute();
const slug = route.params.slug as string;
const meta = ref<any>(null);
const content = ref<any>(null);
const error = ref('');
const password = ref('');
const token = ref(sessionStorage.getItem(`edgedock.share.${slug}`) || '');
const needPassword = ref(false);
const mdEl = ref<HTMLElement | null>(null);

const rawUrl = computed(() => apiUrl(`/raw/${slug}${meta.value?.fileName ? '/' + encodeURIComponent(meta.value.fileName) : ''}${token.value ? `?token=${encodeURIComponent(token.value)}` : ''}`));

async function loadContent() {
  if (meta.value.type === 'file') {
    content.value = { file: true };
    return;
  }
  content.value = await api(`/api/public/shares/${slug}/content${token.value ? `?token=${encodeURIComponent(token.value)}` : ''}`, { auth: false });
  if (meta.value.type === 'markdown') {
    await nextTick();
    await renderMarkdown(mdEl.value!, content.value.content);
  }
}

async function init() {
  try {
    meta.value = await api(`/api/public/shares/${slug}`, { auth: false });
    document.title = meta.value.title || meta.value.fileName || slug;
    if (meta.value.hasPassword && !token.value) {
      needPassword.value = true;
      return;
    }
    await loadContent();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      token.value = '';
      needPassword.value = true;
      return;
    }
    error.value = e instanceof ApiError && (e.status === 404 || e.status === 410) ? t('share.notFound') : (e as Error).message;
  }
}

async function unlock() {
  try {
    const r = await api<{ token: string }>(`/api/public/shares/${slug}/unlock`, { body: { password: password.value }, auth: false });
    token.value = r.token;
    sessionStorage.setItem(`edgedock.share.${slug}`, r.token);
    needPassword.value = false;
    error.value = '';
    await loadContent();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function copyRaw() {
  if (await copyText(new URL(rawUrl.value, location.href).toString())) toast(t('common.copied'));
}
onMounted(init);
</script>

<template>
  <div class="container stack" style="max-width: 980px">
    <div class="row">
      <a href="/" class="brand" style="color: inherit"><img src="/favicon.svg" width="24" height="24" alt="" /> EdgeDock</a>
      <span class="spacer" />
      <template v-if="content">
        <button class="small" @click="copyRaw">{{ t('share.raw') }}</button>
        <a class="btn small" :href="rawUrl + (rawUrl.includes('?') ? '&' : '?') + 'download=1'">{{ t('common.download') }}</a>
      </template>
    </div>

    <div v-if="error && !needPassword" class="card"><p>{{ error }}</p></div>

    <form v-if="needPassword" class="card stack" style="max-width: 420px; margin: 10vh auto 0" @submit.prevent="unlock">
      <h2>🔒 {{ t('share.locked') }}</h2>
      <input v-model="password" type="password" :placeholder="t('login.password')" autofocus />
      <p v-if="error" style="color: var(--c-danger); margin: 0">{{ error }}</p>
      <button class="primary" type="submit">{{ t('share.unlock') }}</button>
    </form>

    <div v-if="meta && content" class="card stack">
      <div class="row">
        <h1 style="margin: 0">{{ meta.title || meta.fileName || slug }}</h1>
        <span class="spacer" />
        <span class="muted">
          <template v-if="meta.size">{{ formatSize(meta.size) }} · </template>
          {{ t('share.views') }} {{ content.views ?? meta.views }}<template v-if="meta.maxViews"> / {{ meta.maxViews }}</template>
        </span>
      </div>
      <div v-if="meta.type === 'markdown'" ref="mdEl" class="vditor-reset md-body" />
      <pre v-else-if="meta.type === 'text'" class="mono" style="white-space: pre-wrap">{{ content.content }}</pre>
      <Preview v-else :name="meta.fileName" :url="rawUrl" :size="meta.size" />
    </div>
  </div>
</template>
