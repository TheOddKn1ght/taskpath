import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store';
import { snapshotDatabase } from '../src/db/backup';

const cli = (database: string, ...args: string[]) => Bun.spawnSync([process.execPath, 'run', 'src/admin.ts', ...args], {
  cwd: join(import.meta.dir, '..'), env: { ...process.env, DATABASE_PATH: database },
});

function rows(db: Database) {
  return db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(({ name }) => ({ name, rows: db.query(`SELECT * FROM "${name}" ORDER BY rowid`).all() }));
}

test('CLI exports live WAL state and imports all tables and binary attachments without changing source', () => {
  const directory = mkdtempSync(join(tmpdir(), 'taskpath-backup-'));
  const source = join(directory, 'source.sqlite'), backup = join(directory, "backup's.sqlite"), target = join(directory, 'restored.sqlite');
  const store = new Store(source);
  try {
    store.db.exec(`INSERT INTO accounts VALUES ('alice','active',1,NULL,NULL,1,'encrypted config','verifier');
      INSERT INTO auth_sessions VALUES ('session','alice',1,123);
      INSERT INTO encrypted_tasks VALUES ('alice','task','2026-10-07','change','encrypted task',1);
      INSERT INTO reminder_claims VALUES ('alice','claimed');
      INSERT INTO push_subscriptions VALUES ('subscription','alice','subscription data');
      INSERT INTO push_reminders VALUES ('alice','task','change','token',123);
      INSERT INTO push_deliveries VALUES ('alice','task','token','subscription',123,2);
      INSERT INTO encrypted_files VALUES ('alice','file',4,'encrypted envelope',X'0001FF80',0);`);
    expect(statSync(source + '-wal').size).toBeGreaterThan(0);
    const before = rows(store.db);
    const exported = cli(source, 'export', backup);
    expect(exported.exitCode, exported.stderr.toString()).toBe(0);
    expect(rows(store.db)).toEqual(before);
    expect(statSync(backup).mode & 0o777).toBe(0o600);
    store.db.exec("DELETE FROM encrypted_tasks");
    const imported = cli(target, 'import', backup);
    expect(imported.exitCode, imported.stderr.toString()).toBe(0);
    const restored = new Store(target);
    try { expect(rows(restored.db)).toEqual(before); } finally { restored.close(); }
    expect(readdirSync(directory).some(name => name.startsWith('.taskpath-backup-'))).toBe(false);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('import refuses existing destinations and sidecars, preserving their bytes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'taskpath-backup-'));
  const source = join(directory, 'source.sqlite'), target = join(directory, 'target.sqlite');
  const store = new Store(source); store.close();
  try {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      writeFileSync(target + suffix, 'keep this');
      const result = cli(target, 'import', source);
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain('never overwrites');
      expect(readFileSync(target + suffix, 'utf8')).toBe('keep this');
      if (suffix) expect(existsSync(target)).toBe(false);
      rmSync(target + suffix);
    }
    symlinkSync(join(directory, 'absent'), target);
    expect(() => snapshotDatabase(source, target)).toThrow('already exists');
    expect(() => snapshotDatabase(source, source)).toThrow('different files');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('invalid, legacy, incomplete, and unsupported backups fail before creating a destination', () => {
  const directory = mkdtempSync(join(tmpdir(), 'taskpath-backup-'));
  const source = join(directory, 'invalid.sqlite'), target = join(directory, 'new', 'restored.sqlite');
  try {
    expect(() => snapshotDatabase(source, target)).toThrow();
    writeFileSync(source, 'not sqlite');
    expect(() => snapshotDatabase(source, target)).toThrow();
    rmSync(source);
    for (const sql of [
      'CREATE TABLE tasks (title TEXT)',
      'CREATE TABLE encrypted_format (version INTEGER); INSERT INTO encrypted_format VALUES (99)',
      'CREATE TABLE encrypted_format (version INTEGER); INSERT INTO encrypted_format VALUES (2)',
    ]) {
      const db = new Database(source); db.exec(sql); db.close();
      const bytes = readFileSync(source);
      expect(() => snapshotDatabase(source, target)).toThrow();
      expect(readFileSync(source)).toEqual(bytes);
      rmSync(source);
    }
    expect(existsSync(join(directory, 'new'))).toBe(false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('invalid CLI arguments and help do not initialize a database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'taskpath-backup-'));
  const path = join(directory, 'new.sqlite');
  try {
    for (const args of [[], ['export'], ['import'], ['export', 'file', 'extra'], ['list', 'unexpected']]) {
      expect(cli(path, ...args).exitCode).toBe(1);
    }
    const help = cli(path, '--help');
    expect(help.exitCode).toBe(0);
    expect(help.stdout.toString()).toContain('admin export');
    expect(existsSync(path)).toBe(false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
