import { createRouter, createWebHistory } from 'vue-router';
import { store, loadStatus } from './lib/store';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/files' },
    { path: '/login', component: () => import('./views/Login.vue'), meta: { public: true } },
    { path: '/files', component: () => import('./views/Files.vue') },
    { path: '/editor', component: () => import('./views/Editor.vue') },
    { path: '/shares', component: () => import('./views/Shares.vue') },
    { path: '/s/:slug', component: () => import('./views/ShareView.vue'), meta: { public: true, bare: true } },
    { path: '/admin/storages', component: () => import('./views/admin/Storages.vue'), meta: { admin: true } },
    { path: '/admin/keys', component: () => import('./views/admin/Keys.vue'), meta: { admin: true } },
    { path: '/admin/settings', component: () => import('./views/admin/Settings.vue'), meta: { admin: true } },
    { path: '/:pathMatch(.*)*', redirect: '/files' },
  ],
});

router.beforeEach(async (to) => {
  if (!store.loaded) await loadStatus();
  if (to.meta.public) return true;
  if (!store.user) return { path: '/login', query: { next: to.fullPath } };
  if (to.meta.admin && store.user.permission !== 'admin') return '/files';
  return true;
});
