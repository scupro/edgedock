import { reactive } from 'vue';
import { api, getToken, setToken } from './api';
import { applyDefaultLocale, type Locale } from './i18n';

export interface PublicSettings {
  siteTitle: string;
  defaultLanguage: Locale;
  externalPreviewTemplate: string;
  externalPreviewExts: string;
  uploadPartSizeMB: number;
  multipartThresholdMB: number;
}

export const store = reactive({
  loaded: false,
  needsSetup: false,
  runtime: 'workers' as 'workers' | 'node',
  settings: { siteTitle: 'EdgeDock', defaultLanguage: 'zh-TW', externalPreviewTemplate: '', externalPreviewExts: '', uploadPartSizeMB: 8, multipartThresholdMB: 50 } as PublicSettings,
  user: null as null | { kind: string; name: string; permission: string; pathPrefix: string },
  online: navigator.onLine,
  toast: '' as string,
});

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(msg: string) {
  store.toast = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (store.toast = ''), 3000);
}

export async function loadStatus() {
  try {
    const s = await api<any>('/api/auth/status', { auth: !!getToken() });
    store.needsSetup = s.needsSetup;
    store.runtime = s.runtime;
    store.settings = s.settings;
    store.user = s.user;
    applyDefaultLocale(s.settings.defaultLanguage);
    document.title = s.settings.siteTitle || 'EdgeDock';
    if (getToken() && !s.user) setToken(null);
  } catch {
    /* offline: keep cached shell usable */
  } finally {
    store.loaded = true;
  }
}

export function logout() {
  setToken(null);
  store.user = null;
}

export const isAdmin = () => store.user?.permission === 'admin';

window.addEventListener('online', () => (store.online = true));
window.addEventListener('offline', () => (store.online = false));
window.addEventListener('edgedock:unauthorized', () => logout());
