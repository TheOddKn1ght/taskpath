import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store';

const installer = join(import.meta.dir, '../scripts/vps.sh');
const config = join(import.meta.dir, '../scripts/vps-config.py');
const sha = 'b'.repeat(40);

function shell(body: string) {
  const root = mkdtempSync(join(tmpdir(), 'taskpath-vps-'));
  try {
    const result = Bun.spawnSync(
      [
        'bash',
        '-c',
        `source "$1"
ROOT=$2
REAL_SNAPSHOT=$(declare -f snapshot)
record() { printf '%s\\n' "$*" >> "$ROOT/events"; }
docker() { die 'Unexpected Docker operation.'; }
git() { die 'Unexpected Git operation.'; }
systemctl() { die 'Unexpected systemd operation.'; }
fetch_release() { record fetch; SHA=${sha}; }
build_release() { record build; }
stop_current() { record stop; }
start_current() { if [[ -f "$ROOT/current" ]]; then record start-new; else record start-old; fi; }
current_volume() { printf old-volume; }
snapshot() { record backup; BACKUP="$ROOT/snapshot.tar"; }
clone_volume() { record clone; }
preflight() { record preflight; }
remove_probe() { record remove-probe; }
helper() { record config; printf '{}'; }
compose() { record validate; }
trap on_exit EXIT
${body}`,
        'test',
        installer,
        root,
      ],
      { timeout: 10_000 },
    );
    let events: string[] = [];
    try {
      events = readFileSync(join(root, 'events'), 'utf8').trim().split('\n');
    } catch {}
    return {
      code: result.exitCode,
      output: result.stdout.toString() + result.stderr.toString(),
      events,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('help and invalid commands never access the host', () => {
  expect(shell('main --help').output).toContain('sudo taskpath update');
  expect(shell('main --help').code).toBe(0);
  expect(shell('main nonsense').code).toBe(1);
  expect(shell('main update extra').code).toBe(1);
});

test('rejects unsafe branch names and credential-bearing repository URLs', () => {
  for (const assignment of [
    "BRANCH='../main'",
    "BRANCH='main;id'",
    "BRANCH='main.lock'",
    "BRANCH='main/'",
    "REPO='https://user:secret@example.com/repo.git'",
    "REPO='file:///tmp/repo'",
  ])
    expect(shell(`${assignment}\nvalidate_repository`).code, assignment).toBe(1);
  expect(shell('validate_repository').code).toBe(0);
});

test('build failure leaves the original service running', () => {
  const result = shell('build_release() { record build; return 1; }\nupdate');
  expect(result.code).toBe(1);
  expect(result.events).toEqual(['fetch', 'build']);
});

test('same revision does not build or stop the service', () => {
  const result = shell(`touch "$ROOT/current"\ncurrent_revision() { printf '${sha}'; }\nupdate`);
  expect(result.code, result.output).toBe(0);
  expect(result.events).toEqual(['fetch']);
});

for (const stage of ['snapshot', 'clone_volume', 'preflight'] as const) {
  test(`${stage} failure resumes original service without committing candidate`, () => {
    const result = shell(`${stage}() { record failed; return 1; }\nupdate`);
    expect(result.code).toBe(1);
    expect(result.events).toContain('failed');
    expect(result.events.at(-1)).toBe('start-old');
    expect(result.events).not.toContain('start-new');
    expect(result.events).not.toContain('config');
  });
}

test('configuration rejection resumes old service after candidate test', () => {
  const result = shell('compose() { record validate; return 1; }\nupdate');
  expect(result.code).toBe(1);
  expect(result.events.at(-1)).toBe('start-old');
  expect(result.events).not.toContain('start-new');
});

test('update backs up a stopped writer and tests copy before committing and publishing', () => {
  const result = shell(`start_current() {
[[ -f "$ROOT/current" && -f "$ROOT/pending" ]] || die 'Not committed.'
record start-new
}
update
[[ ! -f "$ROOT/pending" ]]`);
  expect(result.code, result.output).toBe(0);
  expect(result.events).toEqual([
    'fetch',
    'build',
    'stop',
    'backup',
    'clone',
    'preflight',
    'remove-probe',
    'config',
    'validate',
    'start-new',
  ]);
});

test('failure after commit resumes new data rather than rolling back public writes', () => {
  const result = shell(`attempt=0
start_current() {
attempt=$((attempt + 1))
[[ -f "$ROOT/current" ]] || die 'Lost committed deployment.'
record start-new
[[ $attempt -gt 1 ]]
}
update`);
  expect(result.code).toBe(1);
  expect(result.events.slice(-3)).toEqual(['start-new', 'remove-probe', 'start-new']);
  expect(result.events).not.toContain('start-old');
});

test('interrupted precommit operation recovers original service', () => {
  const result = shell('touch "$ROOT/pending"\nrecover\n[[ ! -f "$ROOT/pending" ]]');
  expect(result.code, result.output).toBe(0);
  expect(result.events).toEqual(['remove-probe', 'start-old']);
});

test('interrupted postcommit operation recovers candidate without a database restore', () => {
  const result = shell('touch "$ROOT/pending" "$ROOT/current"\nrecover');
  expect(result.code, result.output).toBe(0);
  expect(result.events).toEqual(['remove-probe', 'start-new']);
});

test('failed recovery retains pending marker for the next attempt', () => {
  const result = shell(`touch "$ROOT/pending"
start_current() { record failed-start; return 1; }
trap '[[ -f "$ROOT/pending" ]] && record pending-preserved' EXIT
recover`);
  expect(result.code).toBe(1);
  expect(result.events).toEqual(['remove-probe', 'failed-start', 'pending-preserved']);
});

test('conditional recovery failure keeps pending marker and does not pretend success', () => {
  const result = shell(`touch "$ROOT/pending"
start_current() { record failed-start; return 1; }
if recover; then die 'Recovery falsely succeeded.'; fi
[[ -f "$ROOT/pending" ]] || die 'Recovery marker was lost.'
rm "$ROOT/pending"`);
  expect(result.code, result.output).toBe(0);
  expect(result.events).toEqual(['remove-probe', 'failed-start']);
});

test('another update cannot proceed while recovery is pending', () => {
  const result = shell('touch "$ROOT/pending"\ntrap - EXIT\nupdate');
  expect(result.code).toBe(1);
  expect(result.events).toEqual([]);
});

const existing = () => ({
  Id: 'a'.repeat(64),
  State: { Running: true },
  Config: {
    Env: [
      'DATABASE_PATH=/app/data/taskpath-accounts.sqlite',
      'TASKPATH_ORIGIN=https://tasks.example.com',
      'TASKPATH_TIMEZONE=Europe/Moscow',
      'SECRET=literal$VAR${VALUE}=rest',
    ],
    Cmd: ['bun', 'run', 'start:smol'],
    Entrypoint: ['/usr/local/bin/docker-entrypoint.sh'],
    User: 'bun',
    Labels: { 'com.docker.compose.service': 'taskpath' },
  },
  Mounts: [
    {
      Type: 'volume',
      Name: 'customproject_taskpath-accounts-data',
      Destination: '/app/data',
      RW: true,
    },
  ],
  HostConfig: { PortBindings: { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '3123' }] } },
});

function python(mode: string, data: unknown, args: string[] = []) {
  const directory = mkdtempSync(join(tmpdir(), 'taskpath-config-'));
  try {
    const file = join(directory, 'input.json');
    writeFileSync(file, JSON.stringify(data));
    const result = Bun.spawnSync(['python3', config, mode, file, ...args]);
    return {
      code: result.exitCode,
      output: result.stdout.toString(),
      error: result.stderr.toString(),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('backup refuses a volume still mounted by another running container', () => {
  const result = shell(`eval "$REAL_SNAPSHOT"
docker() { record "docker $*"; printf other-writer; }
snapshot old-volume test-image`);
  expect(result.code).toBe(1);
  expect(result.output).toContain('refusing an inconsistent backup');
  expect(result.events).toEqual(['docker ps -q --filter volume=old-volume']);
});

test('adopts actual legacy project volume, port, command, origin, and literal environment', () => {
  const captured = python('capture', [existing()]);
  expect(captured.code, captured.error).toBe(0);
  const settings = JSON.parse(captured.output);
  expect(settings.volume).toBe('customproject_taskpath-accounts-data');
  const rendered = python('compose', settings, ['taskpath-managed:test', 'new-volume']);
  expect(rendered.code, rendered.error).toBe(0);
  const deployment = JSON.parse(rendered.output);
  expect(deployment.volumes.data).toEqual({ external: true, name: 'new-volume' });
  const service = deployment.services.taskpath;
  expect(service.ports).toEqual(['127.0.0.1:3123:3000']);
  expect(service.environment.TASKPATH_ORIGIN).toBe('https://tasks.example.com');
  expect(service.environment.TASKPATH_TIMEZONE).toBe('Europe/Moscow');
  expect(service.environment.SECRET).toBe('literal$$VAR$${VALUE}=rest');
  expect(service.command).toEqual(['bun', 'run', 'start:smol']);
  expect(service.user).toBe('bun');
});

test('candidate test has no network or public ports', () => {
  const settings = JSON.parse(python('capture', [existing()]).output);
  const service = JSON.parse(python('compose', settings, ['image', 'copy', 'private']).output)
    .services.taskpath;
  expect(service.network_mode).toBe('none');
  expect(service.ports).toBeUndefined();
  expect(service.restart).toBe('no');
});

test('adoption refuses unsupported storage, public bindings, stopped and legacy services', () => {
  const variants = [
    (c: ReturnType<typeof existing>) => {
      c.Mounts[0]!.Type = 'bind';
    },
    (c: ReturnType<typeof existing>) => {
      c.Mounts = [];
    },
    (c: ReturnType<typeof existing>) => {
      c.Mounts.push({ ...c.Mounts[0]! });
    },
    (c: ReturnType<typeof existing>) => {
      c.Mounts[0]!.RW = false;
    },
    (c: ReturnType<typeof existing>) => {
      c.HostConfig.PortBindings['3000/tcp'][0]!.HostIp = '0.0.0.0';
    },
    (c: ReturnType<typeof existing>) => {
      c.State.Running = false;
    },
    (c: ReturnType<typeof existing>) => {
      c.Config.Env[0] = 'DATABASE_PATH=/tmp/different.sqlite';
    },
    (c: ReturnType<typeof existing>) => {
      c.Config.Env.push('TASKPATH_PASSWORD=legacy');
    },
  ];
  for (const mutate of variants) {
    const container = existing();
    mutate(container);
    expect(python('capture', [container]).code).toBe(1);
  }
  expect(python('capture', []).code).toBe(1);
  expect(python('capture', [existing(), existing()]).code).toBe(1);
});

test('cloned-data gate accepts old multiuser schema and rejects empty, corrupt and plaintext data', () => {
  const source = readFileSync(installer, 'utf8');
  const validation = source.split('"$IMAGE" -e \'\n')[1]!.split("'\n}")[0]!;
  const directory = mkdtempSync(join(tmpdir(), 'taskpath-data-gate-'));
  try {
    const path = join(directory, 'vault.sqlite');
    const run = () =>
      Bun.spawnSync([
        process.execPath,
        '-e',
        validation.replace('/app/data/taskpath-accounts.sqlite', path),
      ]);
    expect(run().exitCode).not.toBe(0);
    writeFileSync(path, 'broken sqlite');
    expect(run().exitCode).not.toBe(0);
    rmSync(path);
    const db = new Database(path);
    db.exec(
      'CREATE TABLE encrypted_format(version INTEGER); INSERT INTO encrypted_format VALUES(2); CREATE TABLE accounts(userId TEXT); INSERT INTO accounts VALUES ("preserved")',
    );
    db.close();
    expect(run().exitCode).toBe(0);
    const plaintext = new Database(path);
    plaintext.exec('CREATE TABLE tasks(title TEXT)');
    plaintext.close();
    expect(run().exitCode).not.toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('clone validation recreates a missing WAL index without changing the original database', () => {
  const source = readFileSync(installer, 'utf8');
  const validation = source.split('"$IMAGE" -e \'\n')[1]!.split("'\n}")[0]!;
  const directory = mkdtempSync(join(tmpdir(), 'taskpath-wal-clone-'));
  const original = join(directory, 'original.sqlite');
  const cloneDirectory = join(directory, 'clone');
  const clone = join(cloneDirectory, 'taskpath-accounts.sqlite');
  const db = new Database(original);
  try {
    db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE encrypted_format(version INTEGER);
      INSERT INTO encrypted_format VALUES(2);
      CREATE TABLE accounts(userId TEXT);
      INSERT INTO accounts VALUES ('preserved-in-wal');`);
    const originalBytes = readFileSync(original);
    const walBytes = readFileSync(original + '-wal');
    mkdirSync(cloneDirectory);
    copyFileSync(original, clone);
    copyFileSync(original + '-wal', clone + '-wal');
    expect(existsSync(clone + '-shm')).toBe(false);
    const run = () =>
      Bun.spawnSync([
        process.execPath,
        '-e',
        validation.replace('/app/data/taskpath-accounts.sqlite', clone),
      ]);
    // Reproduce a read-only volume: SQLite cannot create its missing WAL index.
    chmodSync(cloneDirectory, 0o555);
    const blocked = run();
    expect(blocked.exitCode).not.toBe(0);
    expect(blocked.stderr.toString()).toContain('SQLITE_CANTOPEN');
    chmodSync(cloneDirectory, 0o700);
    const validated = run();
    expect(validated.exitCode, validated.stderr.toString()).toBe(0);
    expect(existsSync(clone + '-shm')).toBe(true);
    const restored = new Database(clone, { readonly: true });
    try {
      expect(restored.query('SELECT userId FROM accounts').get()).toEqual({
        userId: 'preserved-in-wal',
      });
    } finally {
      restored.close();
    }
    expect(readFileSync(original)).toEqual(originalBytes);
    expect(readFileSync(original + '-wal')).toEqual(walBytes);
    // The validator must receive a writable clone, while snapshots stay read-only.
    expect(source).toContain('--mount "type=volume,src=$VOLUME,dst=/app/data"');
    expect(source).toContain('--mount "type=volume,src=$volume,dst=/data,readonly"');
  } finally {
    chmodSync(cloneDirectory, 0o700);
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('stopped-volume archive preserves every database table, binary files and signing keys', () => {
  const directory = mkdtempSync(join(tmpdir(), 'taskpath-archive-'));
  try {
    const data = join(directory, 'data');
    const restored = join(directory, 'restored');
    const store = new Store(join(data, 'taskpath-accounts.sqlite'));
    store.db
      .exec(`INSERT INTO accounts VALUES ('alice','active',1,NULL,NULL,1,'wrapped-key','verifier');
      INSERT INTO encrypted_tasks VALUES ('alice','task','2026-10-26','change','ciphertext',1);
      INSERT INTO settings VALUES ('push-key','private-signing-key');
      INSERT INTO encrypted_files VALUES ('alice','file',4,'wrapped-file-key',X'0001FF80',0);`);
    const rows = (db: Database) =>
      db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        )
        .all()
        .map(({ name }) => [name, db.query(`SELECT * FROM "${name}"`).all()]);
    const before = rows(store.db);
    store.close();
    const result = Bun.spawnSync([
      'bash',
      '-c',
      `mkdir "$3"; tar -cf "$1/backup.tar" -C "$2" . && tar -xpf "$1/backup.tar" -C "$3"`,
      'test',
      directory,
      data,
      restored,
    ]);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const recovered = new Database(join(restored, 'taskpath-accounts.sqlite'), { readonly: true });
    try {
      expect(rows(recovered)).toEqual(before);
    } finally {
      recovered.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
