/**
 * Runtime-agnostic types. Shared code must only depend on these (not on
 * @cloudflare/workers-types or node types) so it compiles for both the
 * Workers entry and the Node/Docker entry.
 */

/** Minimal subset of the Cloudflare D1 API that EdgeDock uses. */
export interface DBResult<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: { changes?: number; last_row_id?: number; [k: string]: unknown };
}
export interface DBPreparedStatement {
  bind(...values: unknown[]): DBPreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<DBResult<T>>;
  run(): Promise<DBResult>;
}
export interface DB {
  prepare(sql: string): DBPreparedStatement;
  batch(statements: DBPreparedStatement[]): Promise<DBResult[]>;
  exec(sql: string): Promise<unknown>;
}

/** Minimal Workflow binding shape (Cloudflare Workflows). */
export interface WorkflowBinding {
  create(options?: { id?: string; params?: unknown }): Promise<{ id: string }>;
}

export interface Env {
  DB: DB;
  /** Required. Used for AES-GCM encryption of storage secrets (and to derive JWT key if JWT_SECRET missing). */
  ENCRYPTION_KEY: string;
  JWT_SECRET?: string;
  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD?: string;
  /** Comma separated list of allowed origins for CORS, or "*" */
  CORS_ORIGINS?: string;
  /** Token lifetime in hours (default 24*7) */
  JWT_TTL_HOURS?: string;
  ASSETS?: { fetch(req: Request): Promise<Response> };
  INDEX_WORKFLOW?: WorkflowBinding;
  SYNC_WORKFLOW?: WorkflowBinding;
}

/** Hooks that differ between the Workers and Node runtimes. */
export interface Runtime {
  name: 'workers' | 'node';
  /** Cache API (caches.default) when available. */
  cache(): Cache | null;
  /** Start the search index rebuild in the background. */
  triggerIndex(env: Env): Promise<string>;
  /** Start a sync job in the background. */
  triggerSync(env: Env, jobId: string): Promise<string>;
  /** Keep a promise alive after the response is returned. */
  waitUntil?(p: Promise<unknown>): void;
}

export interface Principal {
  kind: 'admin' | 'apikey' | 'anonymous';
  id: string;
  name: string;
  permission: 'read' | 'readwrite' | 'admin';
  /** Virtual path prefix the principal is confined to. */
  pathPrefix: string;
}

export type AppVars = { principal: Principal; runtime: Runtime };
export type AppEnv = { Bindings: Env; Variables: AppVars };
