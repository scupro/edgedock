/**
 * Cloudflare Workers entry: HTTP (Hono), Cron Triggers, and Workflows.
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { createApp } from './app';
import { indexChunk, indexInit, finishRun, finishSync, runCleanup, runIndexInline, runSyncInline, startRun, syncChunk, syncInit, type IndexState, type SyncState } from './jobs/tasks';
import { getSettings } from './lib/settings';
import type { Env, Runtime } from './lib/types';

type WorkerEnv = Env & { INDEX_WORKFLOW?: Workflow; SYNC_WORKFLOW?: Workflow };

let currentCtx: ExecutionContext | null = null;

const runtime: Runtime = {
  name: 'workers',
  cache: () => (typeof caches !== 'undefined' ? (caches as unknown as { default: Cache }).default : null),
  async triggerIndex(env) {
    const wf = (env as WorkerEnv).INDEX_WORKFLOW;
    if (wf) return (await wf.create({ params: {} })).id;
    // no Workflows binding -> best effort inline in waitUntil
    const p = runIndexInline(env);
    currentCtx?.waitUntil(p);
    return 'inline';
  },
  async triggerSync(env, jobId) {
    const wf = (env as WorkerEnv).SYNC_WORKFLOW;
    if (wf) return (await wf.create({ params: { jobId } })).id;
    const p = runSyncInline(env, jobId);
    currentCtx?.waitUntil(p);
    return 'inline';
  },
  waitUntil: (p) => currentCtx?.waitUntil(p),
};

const app = createApp(runtime);

export default {
  fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext) {
    currentCtx = ctx;
    return app.fetch(request, env, ctx);
  },

  /**
   * Cron Triggers (see wrangler.toml):
   *  - "*\/30 * * * *": clean expired upload sessions & shares
   *  - "17 3 * * *":   rebuild search index + run enabled sync jobs
   */
  async scheduled(event: ScheduledController, env: WorkerEnv, ctx: ExecutionContext) {
    currentCtx = ctx;
    if (event.cron.startsWith('*/')) {
      ctx.waitUntil(runCleanup(env).then((r) => console.log('[edgedock] cleanup', JSON.stringify(r))));
      return;
    }
    ctx.waitUntil(
      (async () => {
        if ((await getSettings(env)).nightlyIndex) await runtime.triggerIndex(env);
        else console.log('[edgedock] nightly index rebuild disabled in settings');
        const { results } = await env.DB.prepare('SELECT id FROM sync_jobs WHERE enabled = 1').all<{ id: string }>();
        for (const j of results) await runtime.triggerSync(env, j.id);
      })(),
    );
  },
};

const RETRY = { retries: { limit: 3, delay: '10 seconds' as const, backoff: 'exponential' as const } };

/** Search index rebuild as a durable Workflow: each chunk of directories is one retriable step. */
export class IndexWorkflow extends WorkflowEntrypoint<WorkerEnv, Record<string, never>> {
  async run(_event: WorkflowEvent<Record<string, never>>, step: WorkflowStep) {
    const runId = await step.do('start', async () => startRun(this.env, 'index', 'workflow'));
    // step results must be serializable: pass JSON strings between steps
    let state: IndexState = JSON.parse(await step.do('init', async () => JSON.stringify(await indexInit(this.env))));
    for (let i = 0; i < 10_000; i++) {
      const r: { state: IndexState; done: boolean } = JSON.parse(
        await step.do(`chunk-${i}`, RETRY, async () => JSON.stringify(await indexChunk(this.env, state, 25))),
      );
      state = r.state;
      if (r.done) break;
    }
    await step.do('finish', async () => {
      await this.env.DB.prepare('DELETE FROM file_index WHERE storage_id NOT IN (SELECT id FROM storages)').run();
      await finishRun(this.env, runId, 'success', { indexed: state.indexed, written: state.written ?? 0 });
      return { indexed: state.indexed };
    });
  }
}

/** One-way storage sync as a durable Workflow. */
export class SyncWorkflow extends WorkflowEntrypoint<WorkerEnv, { jobId: string }> {
  async run(event: WorkflowEvent<{ jobId: string }>, step: WorkflowStep) {
    const jobId = event.payload.jobId;
    const runId = await step.do('start', async () => startRun(this.env, 'sync', jobId));
    let state: SyncState = JSON.parse(await step.do('init', async () => JSON.stringify(await syncInit(this.env, jobId))));
    for (let i = 0; i < 10_000; i++) {
      const r: { state: SyncState; done: boolean } = JSON.parse(
        await step.do(`chunk-${i}`, RETRY, async () => JSON.stringify(await syncChunk(this.env, state, 10))),
      );
      state = r.state;
      if (r.done) break;
    }
    await step.do('finish', async () => {
      await finishSync(this.env, state);
      await finishRun(this.env, runId, state.errors.length ? 'failed' : 'success', state);
      return { copied: state.copied };
    });
  }
}
