import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app';
import { SqliteD1 } from '../src/db/sqlite-d1';
import { runIndexInline, runSyncInline } from '../src/jobs/tasks';
import type { Env, Runtime } from '../src/lib/types';
import { localDefinition } from '../src/storage/local';
import { invalidateMounts } from '../src/storage/mounts';
import { registerDriver } from '../src/storage/registry';

registerDriver(localDefinition);

export const MIGRATIONS = path.resolve(__dirname, '../migrations');

export function tmpDir(prefix = 'edgedock-'): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function makeEnv(extra: Partial<Env> = {}): Env {
  invalidateMounts();
  const db = new SqliteD1(':memory:');
  db.migrate(MIGRATIONS);
  return { DB: db, ENCRYPTION_KEY: 'test-encryption-key-0123456789', ...extra };
}

export const testRuntime: Runtime = {
  name: 'node',
  cache: () => null,
  triggerIndex: async (env) => {
    await runIndexInline(env);
    return 'inline';
  },
  triggerSync: async (env, id) => {
    await runSyncInline(env, id);
    return 'inline';
  },
};

export function makeApp(env: Env) {
  const app = createApp(testRuntime);
  const req = (p: string, init: RequestInit & { token?: string } = {}) => {
    const headers = new Headers(init.headers);
    if (init.token) headers.set('authorization', `Bearer ${init.token}`);
    return app.request(p, { ...init, headers }, env);
  };
  const json = async <T = any>(p: string, init: Omit<RequestInit, 'body'> & { token?: string; body?: any } = {}): Promise<{ status: number; body: T }> => {
    const headers = new Headers(init.headers);
    let body = init.body;
    if (body !== undefined && typeof body !== 'string' && !(body instanceof Uint8Array)) {
      body = JSON.stringify(body);
      headers.set('content-type', 'application/json');
    }
    const res = await req(p, { ...init, headers, body });
    const text = await res.text();
    let parsed: any = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: res.status, body: parsed };
  };
  return { app, req, json };
}

/** Env + app with an admin and a local storage mounted at /local. */
export async function setupWithLocal() {
  const env = makeEnv();
  const t = makeApp(env);
  const setup = await t.json('/api/auth/setup', { method: 'POST', body: { username: 'admin', password: 'password123' } });
  const token = setup.body.token as string;
  const root = tmpDir();
  const st = await t.json('/api/storages', {
    method: 'POST',
    token,
    body: { name: 'Local', type: 'local', mountPath: '/local', config: { root } },
  });
  if (st.status !== 201) throw new Error('storage create failed: ' + JSON.stringify(st.body));
  return { env, ...t, token, root, storageId: st.body.id as string };
}
