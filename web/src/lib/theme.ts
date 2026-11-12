/**
 * Light / dark theme: "system" follows prefers-color-scheme, "light" / "dark" are forced.
 * The choice is kept in localStorage; index.html applies it before first paint (no flash).
 */
import { ref } from 'vue';

export type ThemeMode = 'system' | 'light' | 'dark';
const KEY = 'edgedock.theme';
const mq = typeof window !== 'undefined' ? window.matchMedia?.('(prefers-color-scheme: dark)') : undefined;

function stored(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export const themeMode = ref<ThemeMode>(stored());
export const darkActive = ref(false);

function apply() {
  const dark = themeMode.value === 'dark' || (themeMode.value === 'system' && !!mq?.matches);
  darkActive.value = dark;
  const root = document.documentElement;
  root.dataset.theme = dark ? 'dark' : 'light';
  root.style.colorScheme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0d0b1f' : '#4f46e5');
}

export function setTheme(m: ThemeMode) {
  themeMode.value = m;
  try {
    if (m === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, m);
  } catch {
    /* private mode */
  }
  apply();
}

/** system → light → dark → system */
export function cycleTheme() {
  setTheme(themeMode.value === 'system' ? 'light' : themeMode.value === 'light' ? 'dark' : 'system');
}

export function initTheme() {
  apply();
  mq?.addEventListener?.('change', apply);
}
