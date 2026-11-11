import { Hono } from 'hono';
import { principalMiddleware } from './lib/auth';
import { corsMiddleware } from './lib/cors';
import { HttpError, RetriableError } from './lib/errors';
import type { AppEnv, Runtime } from './lib/types';
import { adminRoutes } from './routes/admin';
import { authRoutes } from './routes/auth';
import { fileLinkRoutes, fsRoutes } from './routes/fs';
import { publicShareRoutes, rawRoutes, shareRoutes } from './routes/shares';
import { storageRoutes } from './routes/storages';
import { uploadRoutes } from './routes/upload';
import { davRoutes } from './webdav/server';

export const VERSION = '0.1.0';

export function createApp(runtime: Runtime) {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.set('runtime', runtime);
    if (!c.env.ENCRYPTION_KEY) {
      return c.json({ error: 'ENCRYPTION_KEY secret is not configured', code: 'misconfigured' }, 500);
    }
    await next();
  });

  // CORS (CORS_ORIGINS / CORS_CREDENTIALS / CORS_MAX_AGE). Preflights are answered before auth.
  const corsMw = corsMiddleware();
  app.use('/api/*', corsMw);
  app.use('/raw/*', corsMw);
  app.use('/dav', corsMw);
  app.use('/dav/*', corsMw);

  app.use('/api/*', principalMiddleware);
  app.use('/dav', principalMiddleware);
  app.use('/dav/*', principalMiddleware);

  app.get('/api/health', (c) => c.json({ ok: true, version: VERSION, runtime: runtime.name }));
  app.route('/api/auth', authRoutes);
  app.route('/api/storages', storageRoutes);
  app.route('/api/fs', fsRoutes);
  app.route('/api/file', fileLinkRoutes);
  app.route('/api/upload', uploadRoutes);
  app.route('/api/shares', shareRoutes);
  app.route('/api/public/shares', publicShareRoutes);
  app.route('/api/admin', adminRoutes);
  app.route('/raw', rawRoutes);
  app.route('/dav', davRoutes);

  app.onError((err, c) => {
    if (err instanceof RetriableError) {
      c.header('X-EdgeDock-Retriable', '1');
      if (err.retryAfter) c.header('Retry-After', String(err.retryAfter));
      return c.json({ error: err.message, code: err.code, retriable: true }, err.status as 503);
    }
    if (err instanceof HttpError) return c.json({ error: err.message, code: err.code }, err.status as 400);
    const status = (err as { status?: number }).status;
    if (status && status >= 400 && status < 600) return c.json({ error: err.message, code: 'upstream' }, (status === 404 ? 404 : 502) as 502);
    console.error('[edgedock]', err);
    return c.json({ error: err.message || 'Internal error', code: 'internal' }, 500);
  });

  app.notFound(async (c) => {
    if (c.req.path.startsWith('/api/')) return c.json({ error: 'Not found', code: 'not_found' }, 404);
    // integrated deploy: hand everything else to the static assets (SPA)
    if (c.env.ASSETS) return c.env.ASSETS.fetch(c.req.raw);
    return c.text('Not found', 404);
  });

  return app;
}
