/**
 * D1-compatible adapter over Node's built-in `node:sqlite` (Node >= 22.5).
 * Used by the Docker/Node runtime and by the test-suite. No native addon needed.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { DB, DBPreparedStatement, DBResult } from '../lib/types';

type SqlValue = null | number | bigint | string | Uint8Array;

function normalize(v: unknown): SqlValue {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'string') return v;
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  return JSON.stringify(v);
}

class Stmt implements DBPreparedStatement {
  constructor(
    private db: DatabaseSync,
    private sql: string,
    private params: SqlValue[] = [],
  ) {}

  private prepared(): StatementSync {
    return this.db.prepare(this.sql);
  }

  bind(...values: unknown[]): DBPreparedStatement {
    return new Stmt(this.db, this.sql, values.map(normalize));
  }

  async first<T>(): Promise<T | null> {
    const row = this.prepared().get(...this.params) as T | undefined;
    return row ?? null;
  }

  async all<T>(): Promise<DBResult<T>> {
    const rows = this.prepared().all(...this.params) as T[];
    return { results: rows, success: true, meta: {} };
  }

  async run(): Promise<DBResult> {
    const r = this.prepared().run(...this.params);
    return { results: [], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }

  /** synchronous execution used by batch() */
  runSync(): DBResult {
    const st = this.prepared();
    if (/^\s*(select|with|pragma)/i.test(this.sql)) {
      return { results: st.all(...this.params) as Record<string, unknown>[], success: true, meta: {} };
    }
    const r = st.run(...this.params);
    return { results: [], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
}

export class SqliteD1 implements DB {
  readonly db: DatabaseSync;

  constructor(file = ':memory:') {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  }

  prepare(sql: string): DBPreparedStatement {
    return new Stmt(this.db, sql);
  }

  /** Like D1: statements run in a single transaction. */
  async batch(statements: DBPreparedStatement[]): Promise<DBResult[]> {
    this.db.exec('BEGIN');
    try {
      const out = statements.map((s) => (s as Stmt).runSync());
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  async exec(sql: string): Promise<unknown> {
    this.db.exec(sql);
    return { count: 1 };
  }

  /** Apply ./migrations/*.sql in order, tracking them like wrangler's d1_migrations table. */
  migrate(dir: string): string[] {
    this.db.exec('CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT DEFAULT CURRENT_TIMESTAMP)');
    const done = new Set((this.db.prepare('SELECT name FROM d1_migrations').all() as { name: string }[]).map((r) => r.name));
    const applied: string[] = [];
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(f)) continue;
      this.db.exec('BEGIN');
      try {
        this.db.exec(readFileSync(path.join(dir, f), 'utf8'));
        this.db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(f);
        this.db.exec('COMMIT');
        applied.push(f);
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    }
    return applied;
  }
}
