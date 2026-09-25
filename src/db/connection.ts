import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import * as schema from './schema';

// Schema changes are explicit, additive transactions. Never rewrite existing
// encrypted envelopes when adding synchronization metadata.
export function openDatabase(path: string, timezone: string) {
  new Intl.DateTimeFormat('en', { timeZone: timezone });
  // Inspect read-only BEFORE WAL, schema writes, or directory creation. Never migrate plaintext.
  if (path !== ':memory:' && existsSync(path) && statSync(path).size) {
    const old = new Database(path, { readonly: true });
    try {
      const tables = old.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(t => t.name);
      if (tables.length && (!tables.includes('encrypted_format') || old.query<{ version: number }, []>('SELECT version FROM encrypted_format').get()?.version !== 2 || tables.includes('tasks'))) {
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
  db.transaction(() => db.exec('CREATE TABLE IF NOT EXISTS encrypted_files (userId TEXT NOT NULL, fileId TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes >= 0), envelope TEXT, ciphertext BLOB, deleted INTEGER NOT NULL CHECK(deleted IN (0,1)), PRIMARY KEY(userId,fileId))'))();
  db.transaction(() => {
    const columns = db.query<{name:string}, []>('PRAGMA table_info(encrypted_tasks)').all();
    if (!columns.some(column => column.name === 'sequence')) {
      db.exec("ALTER TABLE encrypted_tasks ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0");
      db.exec("WITH ranked AS (SELECT userId, taskId, row_number() OVER (PARTITION BY userId ORDER BY taskId) AS seq FROM encrypted_tasks) UPDATE encrypted_tasks SET sequence=(SELECT seq FROM ranked WHERE ranked.userId=encrypted_tasks.userId AND ranked.taskId=encrypted_tasks.taskId)");
    }
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS task_sequence ON encrypted_tasks(userId, sequence)");
  })();
  return db;
}

export const connect = (db: Database) => drizzle(db, { schema, logger: false });
export type AppDatabase = ReturnType<typeof connect>;
