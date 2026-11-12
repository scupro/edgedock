import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runIndexInline } from '../src/jobs/tasks';
import { getSettings, saveSettings } from '../src/lib/settings';
import { setupWithLocal } from './helpers';

async function lastRun(env: any) {
  const r = await env.DB.prepare("SELECT detail FROM job_runs WHERE kind = 'index' ORDER BY started_at DESC, rowid DESC LIMIT 1").first();
  return JSON.parse(r.detail) as { indexed: number; written: number };
}

describe('incremental search index', () => {
  it('writes only new / changed / removed rows', async () => {
    const t = await setupWithLocal();
    writeFileSync(path.join(t.root, 'a.txt'), 'aaa');
    mkdirSync(path.join(t.root, 'sub'));
    writeFileSync(path.join(t.root, 'sub', 'beta.txt'), 'bbb');
    // a row from before the parent column existed
    await t.env.DB.prepare('INSERT INTO file_index (storage_id, path, name, is_dir, size, indexed_at) VALUES (?, ?, ?, 0, 1, 1)').bind(t.storageId, '/local/ghost.txt', 'ghost.txt').run();

    await runIndexInline(t.env);
    expect(await lastRun(t.env)).toMatchObject({ indexed: 3, written: 3 });
    expect((await t.json('/api/fs/search?q=ghost', { token: t.token })).body.items ?? []).toHaveLength(0);

    // nothing changed → nothing written
    await runIndexInline(t.env);
    expect(await lastRun(t.env)).toMatchObject({ indexed: 3, written: 0 });

    // one file changed
    writeFileSync(path.join(t.root, 'sub', 'beta.txt'), 'bbbbbbbb');
    await runIndexInline(t.env);
    expect((await lastRun(t.env)).written).toBe(1);

    // directory removed → it and its children leave the index
    rmSync(path.join(t.root, 'sub'), { recursive: true });
    await runIndexInline(t.env);
    expect((await lastRun(t.env)).indexed).toBe(1);
    const rows = await t.env.DB.prepare('SELECT path FROM file_index WHERE storage_id = ? ORDER BY path').bind(t.storageId).all<{ path: string }>();
    expect(rows.results.map((r) => r.path)).toEqual(['/local/a.txt']);
  });

  it('nightly rebuild is on by default and can be turned off', async () => {
    const t = await setupWithLocal();
    expect((await getSettings(t.env)).nightlyIndex).toBe(true);
    await saveSettings(t.env, { nightlyIndex: false });
    expect((await getSettings(t.env)).nightlyIndex).toBe(false);
  });
});
