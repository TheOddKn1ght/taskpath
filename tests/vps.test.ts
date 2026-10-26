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
REAL_FETCH_RELEASE=$(declare -f fetch_release)
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

test('preflight removes Telegram credentials without mutating saved settings', () => {
  const settings = JSON.parse(python('capture', [existing()]).output);
  settings.environment.TASKPATH_TELEGRAM_BOT_TOKEN = '123:private';
  settings.environment.TASKPATH_TELEGRAM_ADMIN_ID = '42';
  const probe = JSON.parse(python('compose', settings, ['image', 'copy', 'private']).output);
  expect(probe.services.taskpath.environment.TASKPATH_TELEGRAM_BOT_TOKEN).toBeUndefined();
  expect(probe.services.taskpath.environment.TASKPATH_TELEGRAM_ADMIN_ID).toBeUndefined();
  const live = JSON.parse(python('compose', settings, ['image', 'same-volume']).output);
  expect(live.services.taskpath.environment.TASKPATH_TELEGRAM_BOT_TOKEN).toBe('123:private');
});

test('Telegram settings validate API and webhook before returning a modified copy', () => {
  const result = Bun.spawnSync([
    'python3',
    '-c',
    `
import runpy
m = runpy.run_path(${JSON.stringify(config)})
f = m['telegram_settings']
s = {'environment': {'TASKPATH_ORIGIN': 'https://tasks.example.com', 'KEEP': '$unchanged'}}
calls = []
def api(method):
    calls.append(method)
    return {'id': 123} if method == 'getMe' else {'url': ''}
r = f(s, '123:secret', '42', api)
assert calls == ['getMe', 'getWebhookInfo']
assert 'TASKPATH_TELEGRAM_BOT_TOKEN' not in s['environment']
assert r['environment']['TASKPATH_TELEGRAM_ADMIN_ID'] == '42'
assert r['environment']['KEEP'] == '$unchanged'
assert f(r) == s
for token, user in [('bad', '42'), ('123:secret', '-1'), ('123:secret', '9007199254740992')]:
    try:
        f(s, token, user, api)
        raise AssertionError('Accepted invalid config')
    except ValueError:
        pass
try:
    f(s, '123:secret', '42', lambda method: {'url': 'https://existing'})
    raise AssertionError('Accepted webhook')
except ValueError as e:
    assert 'deleteWebhook' in str(e)
assert 'TASKPATH_TELEGRAM_BOT_TOKEN' not in s['environment']
`,
  ]);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
});

function telegramShell(body: string, setup = false) {
  return shell(`
helper() { python3 '${config}' "$@"; }
cat > "$ROOT/settings.json" <<'JSON'
{"environment":{"TASKPATH_ORIGIN":"https://tasks.example.com","KEEP":"preserved","TASKPATH_TELEGRAM_BOT_TOKEN":"123:old","TASKPATH_TELEGRAM_ADMIN_ID":"42"},"port":"3123","entrypoint":null,"command":["bun","run","start:smol"],"user":"bun"}
JSON
printf '%s\\n' "$ROOT/original.json" > "$ROOT/current"
helper compose "$ROOT/settings.json" existing-image same-volume > "$ROOT/original.json"
docker() { record capability; }
compose() {
  if [[ $2 == stop ]]; then record rollback-stop; else record validate; fi
}
start_current() { record start; }
${
  setup
    ? `
telegram_credentials() { token='123:private'; admin_id=42; }
helper() {
  if [[ $1 == telegram-setup ]]; then
    [[ $# == 2 ]] || die 'Secrets passed as arguments.'
    python3 -c 'import json,sys; s=json.load(open(sys.argv[1])); s["environment"]["TASKPATH_TELEGRAM_BOT_TOKEN"]=sys.stdin.readline().strip(); s["environment"]["TASKPATH_TELEGRAM_ADMIN_ID"]=sys.stdin.readline().strip(); print(json.dumps(s))' "$2"
  else python3 '${config}' "$@"; fi
}
`
    : ''
}
${body}
`);
}

for (const mode of ['telegram-setup', 'telegram-disable']) {
  test(`${mode} updates saved and current configuration using existing image and volume`, () => {
    const result = telegramShell(
      `
telegram_configure ${mode}
[[ ! -f "$ROOT/telegram-pending" ]]
python3 - "$ROOT/settings.json" "$(current)" <<'PY'
import json,sys
s=json.load(open(sys.argv[1])); d=json.load(open(sys.argv[2])); e=s['environment']
assert e['KEEP'] == 'preserved'
assert d['services']['taskpath']['image'] == 'existing-image'
assert d['volumes']['data']['name'] == 'same-volume'
assert d['services']['taskpath']['command'] == ['bun','run','start:smol']
${mode === 'telegram-setup' ? "assert e['TASKPATH_TELEGRAM_BOT_TOKEN'] == '123:private'\nassert e['TASKPATH_TELEGRAM_ADMIN_ID'] == '42'" : "assert 'TASKPATH_TELEGRAM_BOT_TOKEN' not in e\nassert 'TASKPATH_TELEGRAM_ADMIN_ID' not in e"}
PY
`,
      mode === 'telegram-setup',
    );
    expect(result.code, result.output).toBe(0);
    expect(result.events).toEqual(['capability', 'validate', 'stop', 'start']);
    expect(result.output).not.toContain('123:private');
    expect(result.events.join()).not.toContain('123:private');
  });
}

test('Telegram validation failure leaves deployment and saved settings unchanged', () => {
  const result = telegramShell(
    `
helper() { if [[ $1 == telegram-setup ]]; then return 1; else python3 '${config}' "$@"; fi; }
trap '[[ $(current) == "$ROOT/original.json" ]] && record unchanged' EXIT
telegram_configure telegram-setup
`,
    true,
  );
  expect(result.code).toBe(1);
  expect(result.events).toEqual(['capability', 'unchanged']);
});

test('Telegram restart failure automatically restores configuration on the same volume', () => {
  const result = telegramShell(`
attempt=0
start_current() {
  attempt=$((attempt + 1)); record start
  if [[ $attempt == 1 ]]; then return 1; fi
  [[ $(current) == "$ROOT/original.json" ]] || die 'Pointer was not restored.'
  [[ $(get "$ROOT/settings.json" environment.TASKPATH_TELEGRAM_BOT_TOKEN) == '123:old' ]] || die 'Settings were not restored.'
}
telegram_configure telegram-disable
`);
  expect(result.code, result.output).toBe(1);
  expect(result.events).toEqual([
    'capability',
    'validate',
    'stop',
    'start',
    'rollback-stop',
    'start',
    'start',
  ]);
  expect(result.output).toContain('Previous Telegram configuration restored');
});

test('interrupted Telegram configuration can recover and keeps journal if restart fails', () => {
  const result = telegramShell(`
start_current() { record failed-start; return 1; }
trap - EXIT
# Simulate interruption after publishing candidate configuration.
if telegram_configure telegram-disable; then die 'Unexpected successful restart.'; fi
[[ -f "$ROOT/telegram-pending" ]]
if recover; then die 'Unexpected successful recovery.'; fi
[[ -f "$ROOT/telegram-pending" ]]
start_current() { record recovered; }
recover
[[ ! -f "$ROOT/telegram-pending" ]]
[[ $(current) == "$ROOT/original.json" ]]
`);
  expect(result.code, result.output).toBe(0);
  expect(result.events).toContain('recovered');
});

test('Telegram configuration requires a managed capable deployment and hidden terminal input', () => {
  const missing = telegramShell('rm "$ROOT/current"\ntelegram_configure telegram-setup');
  expect(missing.code).toBe(1);
  expect(missing.events).toEqual([]);
  const unsupported = telegramShell('docker() { return 1; }\ntelegram_configure telegram-disable');
  expect(unsupported.code).toBe(1);
  expect(unsupported.events).toEqual([]);
  const source = readFileSync(installer, 'utf8');
  expect(source).toContain('read -r -s token < /dev/tty');
  expect(source).toContain('unset token admin_id');
});

function selfUpdateShell(body: string) {
  return shell(`
PROGRAM="$ROOT/taskpath"
cp '${installer}' "$PROGRAM"
mkdir -p "$ROOT/release/scripts"
cp '${installer}' "$ROOT/release/scripts/vps.sh"
cp '${config}' "$ROOT/release/scripts/vps-config.py"
fetch_release() { record fetch; SHA=${sha}; RELEASE="$ROOT/release"; }
printf '%s\\n' private-settings > "$ROOT/settings.json"
printf '%s\\n' original-deployment > "$ROOT/current"
current_revision() { printf '${sha}'; }
${body}
`);
}

test('self-update atomically installs a matching script/helper pair without touching the deployment', () => {
  const result = selfUpdateShell(`
self_update
bash "$PROGRAM" --help > "$ROOT/help"
[[ $(cat "$ROOT/settings.json") == private-settings ]]
[[ $(cat "$ROOT/current") == original-deployment ]]
[[ -f "$ROOT/updaters/${sha}/vps.sh" && -f "$ROOT/updaters/${sha}/vps-config.py" ]]
python3 -c 'import os,stat,sys; assert stat.S_IMODE(os.stat(sys.argv[1]).st_mode) == 0o700' "$ROOT/updaters/${sha}"
# The installed launcher selects its bundle, not a stale legacy helper.
printf 'raise Exception("stale helper")\\n' > "$ROOT/vps-config.py"
bash -c 'source "$1"; helper get "$2" mode' test "$ROOT/updaters/${sha}/vps.sh" <(printf '{"mode":"paired"}') > "$ROOT/paired"
[[ $(cat "$ROOT/paired") == paired ]]
self_update
`);
  expect(result.code, result.output).toBe(0);
  expect(result.events).toEqual(['fetch', 'fetch']);
  expect(result.output).toContain('Updater refreshed');
});

for (const kind of ['shell', 'python', 'missing', 'fetch']) {
  test(`self-update ${kind} failure preserves the installed command`, () => {
    const result = selfUpdateShell(`
cp "$PROGRAM" "$ROOT/original-command"
${kind === 'shell' ? 'printf \'if broken\\n\' > "$ROOT/release/scripts/vps.sh"' : ''}
${kind === 'python' ? 'printf \'def broken(\\n\' > "$ROOT/release/scripts/vps-config.py"' : ''}
${kind === 'missing' ? 'rm "$ROOT/release/scripts/vps-config.py"' : ''}
${kind === 'fetch' ? 'fetch_release() { record fetch; return 1; }' : ''}
if self_update; then die 'Invalid update succeeded.'; fi
cmp "$PROGRAM" "$ROOT/original-command"
[[ $(cat "$ROOT/settings.json") == private-settings ]]
record preserved
`);
    expect(result.code, result.output).toBe(0);
    expect(result.events).toEqual(['fetch', 'preserved']);
  });
}

test('self-update failure publishing launcher leaves old command usable', () => {
  const result = selfUpdateShell(`
cp "$PROGRAM" "$ROOT/original-command"
mv() { if [[ $* == *"$PROGRAM" ]]; then return 1; else command mv "$@"; fi; }
if self_update; then die 'Publication unexpectedly succeeded.'; fi
cmp "$PROGRAM" "$ROOT/original-command"
bash "$PROGRAM" --help >/dev/null
record preserved
`);
  expect(result.code, result.output).toBe(0);
  expect(result.events).toEqual(['fetch', 'preserved']);
});

test('self-update refuses to run during pending deployment recovery', () => {
  const result = selfUpdateShell('touch "$ROOT/pending"\ntrap - EXIT\nself_update');
  expect(result.code).toBe(1);
  expect(result.events).toEqual([]);
});

test('self-update never publishes a cached release when the actual fetch fails', () => {
  const result = selfUpdateShell(`
eval "$REAL_FETCH_RELEASE"
printf '%s\\n' https://github.com/TheOddKn1ght/taskpath.git > "$ROOT/repo"
printf '%s\\n' main > "$ROOT/branch"
mkdir "$ROOT/repository.git"
cp "$PROGRAM" "$ROOT/original-command"
git() { if [[ $2 == fetch ]]; then record fetch-failed; return 1; fi; die 'Used a stale cached revision.'; }
if self_update; then die 'Failed fetch was ignored.'; fi
cmp "$PROGRAM" "$ROOT/original-command"
record preserved
`);
  expect(result.code, result.output).toBe(0);
  expect(result.events).toEqual(['fetch-failed', 'preserved']);
});

test('self-update refuses releases without bundle-aware updater support', () => {
  const result = selfUpdateShell(`
printf '#!/usr/bin/env bash\\necho legacy-updater\\n' > "$ROOT/release/scripts/vps.sh"
trap 'cmp "$PROGRAM" "${installer}" && record preserved' EXIT
self_update
`);
  expect(result.code).toBe(1);
  expect(result.events).toEqual(['fetch', 'preserved']);
});
