import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [
      vue(),
      VitePWA({
        registerType: 'autoUpdate',
        injectRegister: 'auto',
        includeAssets: ['favicon.svg', 'icons/*.png'],
        manifest: {
          name: 'EdgeDock',
          short_name: 'EdgeDock',
          description: 'Serverless 檔案管理與 Markdown 分享',
          lang: 'zh-Hant-TW',
          theme_color: '#0f766e',
          background_color: '#f8fafc',
          display: 'standalone',
          start_url: '/',
          scope: '/',
          icons: [
            { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
            { src: '/icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        workbox: {
          // offline app shell; API / raw / WebDAV are never cached by the SW
          navigateFallback: '/index.html',
          navigateFallbackDenylist: [/^\/api\//, /^\/raw\//, /^\/dav/],
          globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
          // heavy, lazily-loaded viewers/exporters are cached at runtime instead of precached
          globIgnores: ['**/pdf*', '**/xlsx*', '**/html2pdf*', '**/docx*', '**/es-*.js', '**/src-*.js', '**/marked*', 'vendor/**'],
          maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
          runtimeCaching: [
            {
              urlPattern: ({ url }) => url.pathname.startsWith('/assets/'),
              handler: 'CacheFirst',
              options: { cacheName: 'edgedock-assets', expiration: { maxEntries: 200 } },
            },
            {
              // self-hosted Vditor runtime (Lute, KaTeX, mermaid…)
              urlPattern: ({ url }) => url.pathname.startsWith('/vendor/'),
              handler: 'CacheFirst',
              options: { cacheName: 'edgedock-vendor', expiration: { maxEntries: 300, maxAgeSeconds: 60 * 86400 } },
            },
            {
              urlPattern: ({ url }) => /unpkg\.com|jsdelivr\.net/.test(url.hostname),
              handler: 'StaleWhileRevalidate',
              options: { cacheName: 'edgedock-cdn', expiration: { maxEntries: 300, maxAgeSeconds: 30 * 86400 } },
            },
          ],
        },
      }),
    ],
    build: {
      target: 'es2022',
      chunkSizeWarningLimit: 2500,
    },
    server: {
      port: 5173,
      proxy: {
        '/api': env.VITE_DEV_PROXY || 'http://127.0.0.1:8787',
        '/raw': env.VITE_DEV_PROXY || 'http://127.0.0.1:8787',
        '/dav': env.VITE_DEV_PROXY || 'http://127.0.0.1:8787',
      },
    },
  };
});
