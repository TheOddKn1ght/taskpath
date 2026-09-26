import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

const plain = <T>(row: T): T => {
  if (Array.isArray(row)) return row.map(plain) as T;
  if (row && typeof row === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) out[k] = v;
    return out as T;
  }
  return row;
};

// Synchronous SQLite handle. Normalizes null-prototype rows from node:sqlite
// to plain objects for strict equality in tests.
export class Database {
  private inner: DatabaseSync;
  constructor(path: string, options?: { readOnly?: boolean }) {
    this.inner = new DatabaseSync(path, options ?? {});
  }
  exec(sql: string): void {
    this.inner.exec(sql);
  }
  prepare(sql: string): { get(...params: unknown[]): any; all(...params: unknown[]): any[]; run(...params: unknown[]): { changes: unknown } } {
    const stmt = this.inner.prepare(sql);
    return {
      // node:sqlite returns undefined (not null) when no row matches.
      get: (...params: unknown[]) => { const row = stmt.get(...(params as [])); return row === undefined ? null : plain(row); },
      all: (...params: unknown[]) => plain(stmt.all(...(params as [])) as unknown[]),
      run: (...params: unknown[]) => stmt.run(...(params as [])) as unknown as { changes: unknown },
    };
  }
  close(): void {
    this.inner.close();
  }
}

const depths = new WeakMap<Database, number>();

// Nested transactions use savepoints so push fan-out (repository transaction
// wrapping store.claim's workspace transaction) stays atomic.
export function transaction<T>(db: Database, work: () => T): T {
  const depth = depths.get(db) ?? 0;
  if (depth > 0) {
    const name = `taskpath_${depth}`;
    depths.set(db, depth + 1);
    db.exec(`SAVEPOINT ${name}`);
    try {
      const result = work();
      db.exec(`RELEASE ${name}`);
      depths.set(db, depth);
      return result;
    } catch (error) {
      try { db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); } catch { /* preserve original error */ }
      depths.set(db, depth);
      throw error;
    }
  }
  depths.set(db, 1);
  db.exec('BEGIN');
  try {
    const result = work();
    db.exec('COMMIT');
    depths.set(db, 0);
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve original error */ }
    depths.set(db, 0);
    throw error;
  }
}

// Schema changes are explicit, additive transactions. Never rewrite existing
// encrypted envelopes when adding synchronization metadata.
export function openDatabase(path: string, timezone: string): Database {
  new Intl.DateTimeFormat('en', { timeZone: timezone });
  // Inspect read-only BEFORE WAL, schema writes, or directory creation. Never migrate plaintext.
  if (path !== ':memory:' && existsSync(path) && statSync(path).size) {
    const old = new Database(path, { readOnly: true });
    try {
      const tables = old.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((t: { name: string }) => t.name);
      if (tables.length && (!tables.includes('encrypted_format') || (old.prepare('SELECT version FROM encrypted_format').get() as { version: number } | undefined)?.version !== 2 || tables.includes('tasks'))) {
        throw new Error('Legacy or unsupported database. Nothing was changed. Use a fresh multi-user database or Docker volume. Existing data was left untouched.');
      }
    } finally { old.close(); }
  }
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS encrypted_format (version INTEGER NOT NULL);
    INSERT INTO encrypted_format SELECT 2 WHERE NOT EXISTS (SELECT 1 FROM encrypted_format);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS accounts (userId TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status IN ('pending','active','disabled')), createdAt INTEGER NOT NULL, tokenHash TEXT, expiresAt INTEGER, revision INTEGER, config TEXT, verifier TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS invitation_hash ON accounts(tokenHash) WHERE tokenHash IS NOT NULL;
    CREATE TABLE IF NOT EXISTS encrypted_tasks (userId TEXT NOT NULL, taskId TEXT NOT NULL, editedAt TEXT NOT NULL, changeId TEXT NOT NULL, envelope TEXT NOT NULL, PRIMARY KEY(userId, taskId));
    CREATE TABLE IF NOT EXISTS reminder_claims (userId TEXT NOT NULL, token TEXT NOT NULL, PRIMARY KEY(userId, token));
    CREATE TABLE IF NOT EXISTS push_subscriptions (id TEXT PRIMARY KEY, userId TEXT NOT NULL, subscription TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS push_reminders (userId TEXT NOT NULL, taskId TEXT NOT NULL, changeId TEXT NOT NULL, token TEXT NOT NULL, dueAt INTEGER NOT NULL, PRIMARY KEY(userId, taskId));
    CREATE TABLE IF NOT EXISTS push_deliveries (userId TEXT NOT NULL, taskId TEXT NOT NULL, token TEXT NOT NULL, subscriptionId TEXT NOT NULL, nextAt INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(userId, token, subscriptionId));
    CREATE INDEX IF NOT EXISTS push_due ON push_reminders(dueAt);
  `);
  db.exec('CREATE TABLE IF NOT EXISTS auth_sessions (tokenHash TEXT PRIMARY KEY, userId TEXT NOT NULL, revision INTEGER NOT NULL, expiresAt INTEGER NOT NULL)');
  transaction(db, () => db.exec('CREATE TABLE IF NOT EXISTS encrypted_files (userId TEXT NOT NULL, fileId TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes >= 0), envelope TEXT, ciphertext BLOB, deleted INTEGER NOT NULL CHECK(deleted IN (0,1)), PRIMARY KEY(userId,fileId))'));
  transaction(db, () => {
    const columns = db.prepare('PRAGMA table_info(encrypted_tasks)').all() as { name: string }[];
    if (!columns.some(column => column.name === 'sequence')) {
      db.exec("ALTER TABLE encrypted_tasks ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0");
      db.exec("WITH ranked AS (SELECT userId, taskId, row_number() OVER (PARTITION BY userId ORDER BY taskId) AS seq FROM encrypted_tasks) UPDATE encrypted_tasks SET sequence=(SELECT seq FROM ranked WHERE ranked.userId=encrypted_tasks.userId AND ranked.taskId=encrypted_tasks.taskId)");
    }
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS task_sequence ON encrypted_tasks(userId, sequence)");
  });
  return db;
}
