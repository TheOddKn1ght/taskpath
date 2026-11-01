import { expect, test } from 'bun:test';
import { join } from 'node:path';

const helper = join(import.meta.dir, '../scripts/vps-config.py');
const template = join(import.meta.dir, '../deploy/nginx/taskpath.conf.example');
function scenario(body: string) {
  const result = Bun.spawnSync([
    'python3',
    '-c',
    `
import importlib.util, pathlib, tempfile, json, os, sys
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('vps', sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
source = pathlib.Path(sys.argv[2]).read_text().replace('15g;', '11m;')
settings = {'environment': {'TASKPATH_ORIGIN': 'https://tasks.example.com'}, 'port': '3000'}
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    conf = root / 'taskpath.conf'
    conf.write_text(source)
    conf.chmod(0o640)
    events = []
    def run(*args):
        events.append(args)
        if args == ('nginx', '-T'):
            return '# configuration file ' + str(conf) + ':\\n' + conf.read_text()
        return ''
    m.nginx_run = run
    m.shutil.which = lambda name: '/usr/sbin/nginx'
${body
  .split('\n')
  .map((line) => '    ' + line)
  .join('\n')}
`,
    helper,
    template,
  ]);
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
}

test('Nginx detection changes only the file allowance and is idempotent', () => {
  scenario(`m.nginx_update(settings, root)
assert conf.read_text() == source.replace('11m;', '15g;')
assert conf.stat().st_mode & 0o777 == 0o640
assert events == [('nginx', '-T'), ('nginx', '-t'), ('systemctl', 'reload', 'nginx')]
assert not (root / 'nginx-pending').exists()
assert next(root.glob('nginx-*/previous.conf')).read_text() == source
events.clear()
m.nginx_update(settings, root)
assert events == [('nginx', '-T')]`);
});

test('missing file location copies root policy while retaining the rest of the host', () => {
  scenario(`start = source.index('    location = /api/files {')
end = source.index('\\n    }', start) + len('\\n    }')
text = source[:start] + source[end:]
text = text.replace('location / {\\n        proxy_pass', 'location / {\\n        auth_basic "Private";\\n        proxy_set_header X-Custom "a;{b}"; # comment }\\n        client_max_body_size 32k;\\n        proxy_pass')
updated = m.nginx_patch(text, 'tasks.example.com', '3000', 443)
nodes = m.nginx_nodes(updated)
server = [n for n in nodes if n['words'] == ['server']][-1]
files = [n for n in server['children'] if n['words'] == ['location', '=', '/api/files']][0]
assert ['auth_basic', 'Private'] in [n['words'] for n in files['children']]
assert ['client_max_body_size', '15g'] in [n['words'] for n in files['children']]
assert 'ssl_certificate /etc/letsencrypt/live/tasks.example.com/fullchain.pem;' in updated
assert 'client_max_body_size 2m;' in updated`);
});

test('symlink detection updates its target without replacing the enabled-site link', () => {
  scenario(`link = root / 'enabled.conf'
link.symlink_to(conf)
original = m.nginx_run
def run(*args):
    if args == ('nginx', '-T'):
        events.append(args)
        return '# configuration file ' + str(link) + ':\\n' + conf.read_text()
    return original(*args)
m.nginx_run = run
m.nginx_update(settings, root)
assert link.is_symlink()
assert 'client_max_body_size 15g;' in conf.read_text()`);
});

for (const stage of ['validation', 'reload']) {
  test(`Nginx ${stage} failure restores the previous file and reloads it`, () => {
    scenario(`original = m.nginx_run
failed = False
def fail(*args):
    global failed
    if not failed and args == ${stage === 'validation' ? "('nginx', '-t')" : "('systemctl', 'reload', 'nginx')"}:
        failed = True
        raise ValueError('simulated failure')
    return original(*args)
m.nginx_run = fail
try:
    m.nginx_update(settings, root)
    raise AssertionError('failure was ignored')
except ValueError:
    pass
assert conf.read_text() == source
assert not (root / 'nginx-pending').exists()
assert events[-2:] == [('nginx', '-t'), ('systemctl', 'reload', 'nginx')]`);
  });
}

test('failed restoration keeps a durable marker and recover completes after restart', () => {
  scenario(`original = m.nginx_run
def fail(*args):
    if args == ('nginx', '-t'):
        raise ValueError('simulated failure')
    return original(*args)
m.nginx_run = fail
try:
    m.nginx_update(settings, root)
except ValueError:
    pass
assert (root / 'nginx-pending').exists()
assert conf.read_text() == source
m.nginx_run = original
m.nginx_recover(root)
assert not (root / 'nginx-pending').exists()
assert conf.read_text() == source`);
});

test('interrupted replacement recovers and protects subsequent host edits', () => {
  scenario(`backup = root / 'previous.conf'
backup.write_text(source)
updated = source.replace('11m;', '15g;')
pending = dict(path=str(conf), backup=str(backup), before=m.hashlib.sha256(source.encode()).hexdigest(), after=m.hashlib.sha256(updated.encode()).hexdigest())
marker = root / 'nginx-pending'
marker.write_text(json.dumps(pending))
conf.write_text(updated + '# operator edit\\n')
try:
    m.nginx_recover(root)
    raise AssertionError('external edit was overwritten')
except ValueError:
    pass
assert marker.exists()
conf.write_text(updated)
m.nginx_recover(root)
assert conf.read_text() == source
assert not marker.exists()`);
});

test('ambiguous hosts, upstream mismatch and missing host fail without writes', () => {
  scenario(`for text in [source + source, source.replace(':3000;', ':3123;'), source.replace('server_name tasks.example.com;', 'server_name other.example.com;')]:
    conf.write_text(text)
    try:
        m.nginx_update(settings, root)
        raise AssertionError('unsafe match accepted')
    except ValueError:
        pass
    assert conf.read_text() == text
    assert not (root / 'nginx-pending').exists()
assert not any(event[0] == 'systemctl' for event in events)`);
});

test('missing Nginx is skipped and unsafe inferred locations are rejected', () => {
  scenario(`m.shutil.which = lambda name: None
m.nginx_update(settings, root)
assert events == []
start = source.index('    location = /api/files {')
end = source.index('\\n    }', start) + len('\\n    }')
text = source[:start] + source[end:]
for directive in ['include custom.conf;', 'location ~ /api/ { deny all; }']:
    unsafe = text.replace('    listen 443 ssl;', '    listen 443 ssl;\\n' + directive)
    try:
        m.nginx_patch(unsafe, 'tasks.example.com', '3000', 443)
        raise AssertionError('unsafe layout accepted')
    except ValueError:
        pass`);
});
