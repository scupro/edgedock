<script setup lang="ts">
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, setToken } from '../lib/api';
import { t } from '../lib/i18n';
import { loadStatus, store } from '../lib/store';

const route = useRoute();
const router = useRouter();
const username = ref('');
const password = ref('');
const err = ref('');
const busy = ref(false);

async function submit() {
  busy.value = true;
  err.value = '';
  try {
    const r = await api<{ token: string }>(store.needsSetup ? '/api/auth/setup' : '/api/auth/login', {
      body: { username: username.value, password: password.value },
      auth: false,
    });
    setToken(r.token);
    await loadStatus();
    router.replace((route.query.next as string) || '/files');
  } catch (e) {
    err.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="container" style="max-width: 420px; padding-top: 10vh">
    <form class="card stack" @submit.prevent="submit">
      <div class="row"><img src="/favicon.svg" width="36" height="36" alt="" /><h1 style="margin: 0">{{ store.settings.siteTitle || 'EdgeDock' }}</h1></div>
      <h2>{{ store.needsSetup ? t('login.setupTitle') : t('login.title') }}</h2>
      <p v-if="store.needsSetup" class="muted">{{ t('login.setupHint') }}</p>
      <label class="field"><span>{{ t('login.username') }}</span><input v-model="username" autocomplete="username" required /></label>
      <label class="field"><span>{{ t('login.password') }}</span><input v-model="password" type="password" :autocomplete="store.needsSetup ? 'new-password' : 'current-password'" required :minlength="store.needsSetup ? 8 : undefined" /></label>
      <p v-if="err" style="color: var(--c-danger); margin: 0">{{ err }}</p>
      <button class="primary" type="submit" :disabled="busy">{{ store.needsSetup ? t('login.setup') : t('login.submit') }}</button>
    </form>
  </div>
</template>
