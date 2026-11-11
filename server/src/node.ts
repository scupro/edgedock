/**
 * Node.js / Docker entry. Same Hono app as the Worker, with:
 *  - node:sqlite as a D1-compatible database
 *  - the local filesystem storage driver
 *  - setInterval-based "cron"
 *  - optional static hosting of the built frontend (STATIC_DIR)
 */
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { createApp } from './app';
import { SqliteD1 } from './db/sqlite-d1';
import { runCleanup, runIndexInline, runSyncInline } from './jobs/tasks';
import type { AppEnv, Env, Runtime } from './lib/types';
import { localDefinition } from './storage/local';
import { registerDriver } from './storage/registry';

registerDriver(localDefinition);

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR ?? path.resolve('data');
mkdirSync(dataDir, { recursive: true });

const migrationsDir = process.env.MIGRATIONS_DIR ?? [path.resolve(here, '../migrations'), path.resolve('migrations'), path.resolve('server/migrations')].find((d) => existsSync(d))!;
const db = new SqliteD1(process.env.DB_FILE ?? path.join(dataDir, 'edgedock.sqlite'));
const applied = db.migrate(migrationsDir);
if (applied.length) console.log('[edgedock] applied migrations:', applied.join(', '));

const env: Env = {
  DB: db,
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? '',
  JWT_SECRET: process.env.JWT_SECRET,
  ADMIN_USERNAME: process.env.ADMIN_USERNAME,
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
  CORS_ORIGINS: process.env.CORS_ORIGINS,
  JWT_TTL_HOURS: process.env.JWT_TTL_HOURS,
};
if (!env.ENCRYPTION_KEY) {
  console.error('[edgedock] ENCRYPTION_KEY is required (e.g. `openssl rand -base64 32`)');
  process.exit(1);
}

const running = new Set<string>();
function background(name: string, fn: () => Promise<unknown>): string {
  if (running.has(name)) return 'already-running';
  running.add(name);
  fn()
    .catch((e) => console.error(`[edgedock] ${name} failed`, e))
    .finally(() => running.delete(name));
  return 'inline';
}

const runtime: Runtime = {
  name: 'node',
  cache: () => null,
  triggerIndex: async (e) => background('index', () => runIndexInline(e)),
  triggerSync: async (e, jobId) => background('sync:' + jobId, () => runSyncInline(e, jobId)),
  waitUntil: (p) => void p.catch(() => {}),
};

const api = createApp(runtime);
const root = new Hono<AppEnv>();
const staticDir = process.env.STATIC_DIR;
if (staticDir && existsSync(staticDir)) {
  const indexHtml = readFileSync(path.join(staticDir, 'index.html'), 'utf8');
  root.route('/', api);
  root.use('*', serveStatic({ root: path.relative(process.cwd(), staticDir) || '.' }));
  root.get('*', (c) => c.html(indexHtml));
} else {
  root.route('/', api);
}

// "cron"
const cleanupMs = Number(process.env.CLEANUP_INTERVAL_MIN ?? 30) * 60_000;
const indexMs = Number(process.env.INDEX_INTERVAL_MIN ?? 24 * 60) * 60_000;
setInterval(() => background('cleanup', () => runCleanup(env)), cleanupMs).unref();
setInterval(() => {
  background('index', () => runIndexInline(env));
  db.prepare('SELECT id FROM sync_jobs WHERE enabled = 1')
    .all<{ id: string }>()
    .then(({ results }) => results.forEach((j) => background('sync:' + j.id, () => runSyncInline(env, j.id))));
}, indexMs).unref();

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: (req) => root.fetch(req, env), port, hostname: process.env.HOST ?? '0.0.0.0' }, (info) => {
  console.log(`[edgedock] listening on http://${info.address}:${info.port} (data: ${dataDir})`);
});
