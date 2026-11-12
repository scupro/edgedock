<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import UploadPanel from './components/UploadPanel.vue';
import { locale, setLocale, t, type Locale } from './lib/i18n';
import { isAdmin, logout, store } from './lib/store';
import { cycleTheme, themeMode } from './lib/theme';

const themeIcon = computed(() => ({ system: '🖥', light: '☀️', dark: '🌙' })[themeMode.value]);
const themeLabel = computed(() => `${t('theme.label')}: ${t(`theme.${themeMode.value}`)}`);

const route = useRoute();
const router = useRouter();
const bare = computed(() => !!route.meta.bare || route.path === '/login');

// PWA install prompt
const installEvt = ref<any>(null);
onMounted(() => {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installEvt.value = e;
  });
});
async function install() {
  installEvt.value?.prompt();
  installEvt.value = null;
}
function doLogout() {
  logout();
  router.push('/login');
}
function changeLocale(e: Event) {
  setLocale((e.target as HTMLSelectElement).value as Locale);
}
</script>

<template>
  <div v-if="!store.online" class="offline">{{ t('pwa.offline') }}</div>
  <header v-if="!bare" class="topbar">
    <div class="inner">
      <router-link to="/files" class="brand"><img src="/favicon.svg" alt="" />{{ store.settings.siteTitle || 'EdgeDock' }}</router-link>
      <nav class="nav row" v-if="store.user">
        <router-link to="/files">{{ t('nav.files') }}</router-link>
        <router-link to="/editor">{{ t('nav.editor') }}</router-link>
        <router-link to="/shares">{{ t('nav.shares') }}</router-link>
        <template v-if="isAdmin()">
          <router-link to="/admin/storages">{{ t('nav.storages') }}</router-link>
          <router-link to="/admin/keys">{{ t('nav.keys') }}</router-link>
          <router-link to="/admin/settings">{{ t('nav.settings') }}</router-link>
        </template>
      </nav>
      <span class="spacer" />
      <button v-if="installEvt" class="small" @click="install">⬇ {{ t('pwa.install') }}</button>
      <button class="small theme-toggle" :title="themeLabel" :aria-label="themeLabel" @click="cycleTheme">{{ themeIcon }}</button>
      <select :value="locale" @change="changeLocale" style="width: auto" aria-label="Language">
        <option value="zh-TW">正體中文</option>
        <option value="en">English</option>
      </select>
      <span v-if="store.user" class="muted hide-sm">{{ store.user.name }}</span>
      <button v-if="store.user" class="small" @click="doLogout">{{ t('nav.logout') }}</button>
    </div>
  </header>
  <main>
    <router-view />
  </main>
  <UploadPanel v-if="store.user" />
  <div v-if="store.toast" class="toast">{{ store.toast }}</div>
</template>
