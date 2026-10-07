import { Database } from 'bun:sqlite';
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { getTableColumns, getTableName } from 'drizzle-orm';
import * as schema from './schema';

function exists(path: string) {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

function validate(db: Database) {
  const checks = db.query<{ quick_check: string }, []>('PRAGMA quick_check').all();
  if (checks.length !== 1 || checks[0]?.quick_check !== 'ok') throw new Error('Database integrity check failed.');
  const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
  if (!tables.includes('encrypted_format') || tables.includes('tasks')) throw new Error('Expected a Taskpath encrypted multi-user database.');
  const versions = db.query<{ version: number }, []>('SELECT version FROM encrypted_format').all();
  if (versions.length !== 1 || versions[0]?.version !== 2) throw new Error('Unsupported Taskpath database format.');
  for (const table of Object.values(schema)) {
    const name = getTableName(table);
    if (!tables.includes(name)) throw new Error(`Taskpath database is missing table ${name}.`);
    // Identifiers come only from the application schema, never from CLI input.
    const columns = db.query<{ name: string }, []>(`PRAGMA table_info("${name}")`).all().map(row => row.name);
    for (const column of Object.values(getTableColumns(table))) {
      if (!columns.includes(column.name)) throw new Error(`Taskpath database is missing column ${name}.${column.name}.`);
    }
  }
}

/** Publish a consistent SQLite snapshot without changing the source or replacing a destination. */
export function snapshotDatabase(sourcePath: string, destinationPath: string) {
  if (!sourcePath || !destinationPath || sourcePath === ':memory:' || destinationPath === ':memory:') throw new Error('Use file paths for database import/export.');
  const source = resolve(sourcePath), destination = resolve(destinationPath);
  if (source === destination) throw new Error('Source and destination must be different files.');
  if (!statSync(source).isFile()) throw new Error('Source must be an existing SQLite file.');
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    if (exists(destination + suffix)) throw new Error('Destination or SQLite sidecar already exists. Use a new path; import/export never overwrites data.');
  }
  const db = new Database(source, { readonly: true });
  let staging: string | undefined;
  try {
    db.exec('PRAGMA busy_timeout=5000');
    validate(db);
    mkdirSync(dirname(destination), { recursive: true });
    staging = mkdtempSync(join(dirname(destination), '.taskpath-backup-'));
    const snapshot = join(staging, 'snapshot.sqlite');
    db.query('VACUUM INTO ?').run(snapshot);
    chmodSync(snapshot, 0o600);
    const check = new Database(snapshot, { readonly: true });
    try { validate(check); } finally { check.close(); }
    // Same-filesystem hard link publishes only a complete snapshot and fails if
    // another process created the destination. No overwrite window or partial file.
    linkSync(snapshot, destination);
    return destination;
  } finally {
    db.close();
    if (staging) rmSync(staging, { recursive: true, force: true });
  }
}
