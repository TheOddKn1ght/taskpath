#!/usr/bin/env python3
"""Capture an existing Docker deployment without guessing its storage or settings."""
import json
import os
import hashlib
import shutil
import subprocess
import tempfile
from pathlib import Path
import sys
import re
import urllib.request
import urllib.parse


def capture(container):
    config = container['Config']
    mounts = container['Mounts']
    if len(mounts) != 1 or mounts[0]['Type'] != 'volume' or mounts[0]['Destination'] != '/app/data' or not mounts[0]['RW']:
        raise ValueError('Expected exactly one writable named volume at /app/data; custom mounts need manual migration.')
    volume = mounts[0]['Name']
    env = dict(item.split('=', 1) for item in config['Env'])
    if env.get('DATABASE_PATH') != '/app/data/taskpath-accounts.sqlite':
        raise ValueError('Custom DATABASE_PATH needs manual migration.')
    if any(env.get(key) for key in ('TASKPATH_USERNAME', 'TASKPATH_PASSWORD', 'TASKPATH_PASSWORD_HASH')):
        raise ValueError('Legacy single-owner installation needs manual migration.')
    ports = container['HostConfig'].get('PortBindings') or {}
    if set(ports) != {'3000/tcp'} or len(ports['3000/tcp']) != 1:
        raise ValueError('Expected one published application port.')
    binding = ports['3000/tcp'][0]
    if binding['HostIp'] != '127.0.0.1' or not binding['HostPort'].isdigit():
        raise ValueError('Application port must already be bound to 127.0.0.1.')
    if not container['State']['Running']:
        raise ValueError('The existing container must be running.')
    if config.get('Labels', {}).get('com.docker.compose.service') != 'taskpath':
        raise ValueError('Select the existing Compose taskpath service container.')
    return {'container': container['Id'], 'volume': volume, 'environment': env,
            'port': binding['HostPort'], 'entrypoint': config.get('Entrypoint'),
            'command': config.get('Cmd'), 'user': config.get('User', '')}


def compose(settings, image, volume, private=False):
    environment = dict(settings['environment'])
    if private:
        environment.pop('TASKPATH_TELEGRAM_BOT_TOKEN', None)
        environment.pop('TASKPATH_TELEGRAM_ADMIN_ID', None)
    service = {'image': image, 'environment': environment,
               'entrypoint': settings['entrypoint'], 'command': settings['command'],
               'user': settings['user'], 'volumes': ['data:/app/data'],
               'init': True, 'restart': 'unless-stopped'}
    if private:
        service.update(network_mode='none', restart='no')
    else:
        service['ports'] = ['127.0.0.1:' + settings['port'] + ':3000']
    # Compose interpolates even JSON strings. Preserve literal dollars in secrets.
    def literal(value):
        if isinstance(value, str):
            return value.replace('$', '$$')
        if isinstance(value, dict):
            return {key: literal(item) for key, item in value.items()}
        if isinstance(value, list):
            return [literal(item) for item in value]
        return value
    return literal({'services': {'taskpath': service},
                    'volumes': {'data': {'external': True, 'name': volume}}})


def telegram_settings(settings, token=None, admin_id=None, api=None):
    """Return a copy; validate everything before the caller persists it."""
    environment = dict(settings['environment'])
    if token is None:
        environment.pop('TASKPATH_TELEGRAM_BOT_TOKEN', None)
        environment.pop('TASKPATH_TELEGRAM_ADMIN_ID', None)
    else:
        if not re.fullmatch(r'[0-9]+:[A-Za-z0-9_-]+', token):
            raise ValueError('Invalid Telegram bot token.')
        if not re.fullmatch(r'[1-9][0-9]*', admin_id or '') or int(admin_id) > 9007199254740991:
            raise ValueError('Use your positive numeric Telegram user ID.')
        origin = urllib.parse.urlsplit(environment.get('TASKPATH_ORIGIN', ''))
        if (origin.scheme != 'https' or not origin.hostname or origin.username is not None
                or origin.password is not None or origin.path not in ('', '/') or origin.query or origin.fragment):
            raise ValueError('Set a public HTTPS TASKPATH_ORIGIN before Telegram setup.')
        # Validate ports too, before making any network requests.
        _ = origin.port
        def request(method):
            try:
                req = urllib.request.Request('https://api.telegram.org/bot' + token + '/' + method,
                                             data=b'{}', headers={'Content-Type': 'application/json'})
                with urllib.request.urlopen(req, timeout=20) as response:
                    result = json.load(response)
                if not result.get('ok'):
                    raise ValueError()
                return result['result']
            except Exception:
                # urllib errors can contain the credential-bearing request URL.
                raise ValueError('Telegram validation failed. Check the token and outbound HTTPS access.') from None
        request_api = api or request
        request_api('getMe')
        if request_api('getWebhookInfo').get('url'):
            raise ValueError('Bot has a webhook. Remove it with Telegram deleteWebhook in the existing integration, or create a dedicated bot with BotFather.')
        environment['TASKPATH_TELEGRAM_BOT_TOKEN'] = token
        environment['TASKPATH_TELEGRAM_ADMIN_ID'] = admin_id
    return {**settings, 'environment': environment}


# Token offsets let us edit one directive without reformatting host configuration.
_NGINX_TOKEN = re.compile(r"\s+|\#[^\n]*|\"(?:\\.|[^\"\\])*\"|'(?:\\.|[^'\\])*'|[{};]|(?:\\.|\$\{[^}]*\}|[^\s{};#\"'])+")


def nginx_nodes(text):
    tokens = []
    offset = 0
    for match in _NGINX_TOKEN.finditer(text):
        if match.start() != offset:
            raise ValueError('Unsupported Nginx syntax; update /api/files manually.')
        offset = match.end()
        word = match.group()
        if not word.isspace() and not word.startswith('#'):
            tokens.append((word, match.start(), match.end()))
    if offset != len(text):
        raise ValueError('Unsupported Nginx syntax; update /api/files manually.')

    def parse(index, nested=False):
        nodes = []
        while index < len(tokens):
            if tokens[index][0] == '}':
                if not nested:
                    raise ValueError('Unexpected Nginx block end.')
                return nodes, index + 1
            begin = index
            words = []
            while index < len(tokens) and tokens[index][0] not in ('{', '}', ';'):
                words.append(tokens[index][0].strip('\"\''))
                index += 1
            if not words or index == len(tokens) or tokens[index][0] == '}':
                raise ValueError('Unsupported Nginx directive.')
            opening = tokens[index][1]
            children = None
            if tokens[index][0] == '{':
                children, index = parse(index + 1, True)
            else:
                index += 1
            nodes.append(dict(words=words, start=tokens[begin][1], end=tokens[index - 1][2],
                              opening=opening, children=children))
        if nested:
            raise ValueError('Unclosed Nginx block.')
        return nodes, index
    return parse(0)[0]


def nginx_patch(text, hostname, port, public_port):
    nodes = nginx_nodes(text)
    matches = []
    def walk(items):
        for node in items:
            children = node['children']
            if node['words'] == ['server'] and children is not None:
                names = [w for child in children if child['words'][0] == 'server_name' for w in child['words'][1:]]
                listens = [child['words'][1] for child in children if child['words'][0] == 'listen' and len(child['words']) > 1]
                if hostname in names and any(value == str(public_port) or value.endswith(':' + str(public_port)) for value in listens):
                    matches.append(node)
            elif children is not None:
                walk(children)
    walk(nodes)
    if not matches:
        return None
    if len(matches) != 1:
        raise ValueError('Ambiguous Taskpath Nginx server; update /api/files manually.')
    server = matches[0]
    children = server['children']
    upstream = ['proxy_pass', 'http://127.0.0.1:' + str(port)]
    locations = [child for child in children if child['words'][0] == 'location']
    exact = [child for child in locations if child['words'] == ['location', '=', '/api/files']]
    roots = [child for child in locations if child['words'] == ['location', '/']]
    if len(exact) > 1 or len(roots) != 1 or any(child['words'][0] == 'include' for child in children):
        raise ValueError('Unsupported Taskpath Nginx layout; update /api/files manually.')
    root = roots[0]
    if root['children'] is None or [child['words'] for child in root['children'] if child['words'][0] == 'proxy_pass'] != [upstream]:
        raise ValueError('Taskpath Nginx upstream does not match the managed port; update manually.')
    target = exact[0] if exact else root
    if target['children'] is None or [child['words'] for child in target['children'] if child['words'][0] == 'proxy_pass'] != [upstream]:
        raise ValueError('Custom /api/files upstream; update Nginx manually.')
    if not exact and any(len(child['words']) > 1 and child['words'][1] in ('~', '~*') for child in locations):
        raise ValueError('Regex Nginx locations prevent safe /api/files insertion; update manually.')
    limits = [child for child in target['children'] if child['words'][0] == 'client_max_body_size']
    if len(limits) > 1:
        raise ValueError('Duplicate Nginx upload limit; update manually.')
    if exact and limits and limits[0]['words'] == ['client_max_body_size', '15g']:
        return text
    if exact:
        if limits:
            limit = limits[0]
            return text[:limit['start']] + 'client_max_body_size 15g;' + text[limit['end']:]
        at = target['opening'] + 1
        return text[:at] + '\n        client_max_body_size 15g;' + text[at:]
    # Clone local root policy, including authentication and proxy headers.
    body = text[root['opening'] + 1:root['end'] - 1]
    if limits:
        limit = limits[0]
        start = limit['start'] - root['opening'] - 1
        end = limit['end'] - root['opening'] - 1
        body = body[:start] + 'client_max_body_size 15g;' + body[end:]
    else:
        body = '\n        client_max_body_size 15g;' + body
    at = server['end'] - 1
    return text[:at] + '    location = /api/files {' + body + '}\n' + text[at:]


def nginx_atomic(path, content, metadata=None):
    path = Path(path)
    fd, temporary = tempfile.mkstemp(prefix='.taskpath-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        if metadata:
            shutil.copystat(metadata, temporary)
            stat = Path(metadata).stat()
            if os.geteuid() == 0:
                os.chown(temporary, stat.st_uid, stat.st_gid)
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def nginx_run(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout


def nginx_recover(root):
    marker = Path(root) / 'nginx-pending'
    if not marker.exists():
        return
    pending = json.loads(marker.read_text())
    path, backup = Path(pending['path']), Path(pending['backup'])
    current = hashlib.sha256(path.read_bytes()).hexdigest()
    if current not in (pending['before'], pending['after']):
        raise ValueError('Nginx changed during pending recovery; restore the saved backup manually before retrying.')
    nginx_atomic(path, backup.read_bytes(), backup)
    nginx_run('nginx', '-t')
    nginx_run('systemctl', 'reload', 'nginx')
    marker.unlink()
    print('Previous Nginx configuration restored and reloaded.')


def nginx_update(settings, root):
    marker = Path(root) / 'nginx-pending'
    if marker.exists():
        raise ValueError('Run sudo taskpath recover before updating Nginx.')
    if not shutil.which('nginx'):
        print('Nginx is not installed; skipping host upload configuration.')
        return
    origin = urllib.parse.urlsplit(settings['environment'].get('TASKPATH_ORIGIN', ''))
    if not origin.hostname or origin.scheme not in ('http', 'https'):
        raise ValueError('Set TASKPATH_ORIGIN to detect the Taskpath Nginx host, or update Nginx manually.')
    dump = nginx_run('nginx', '-T')
    paths = set(Path(name).resolve() for name in re.findall(r'^# configuration file (.+):$', dump, re.M))
    candidates = []
    for path in sorted(paths):
        text = path.read_bytes().decode('utf-8')
        updated = nginx_patch(text, origin.hostname, settings['port'], origin.port or (443 if origin.scheme == 'https' else 80))
        if updated is not None:
            candidates.append((path, text, updated))
    if len(candidates) != 1:
        raise ValueError('Could not uniquely detect the Taskpath Nginx configuration; update /api/files manually.')
    path, before, after = candidates[0]
    if before == after:
        print('Nginx upload allowance is already 15g.')
        return
    directory = Path(tempfile.mkdtemp(prefix='nginx-', dir=root))
    backup = directory / 'previous.conf'
    nginx_atomic(backup, before.encode(), path)
    pending = dict(path=str(path), backup=str(backup), before=hashlib.sha256(before.encode()).hexdigest(),
                   after=hashlib.sha256(after.encode()).hexdigest())
    nginx_atomic(marker, json.dumps(pending).encode())
    try:
        nginx_atomic(path, after.encode(), path)
        nginx_run('nginx', '-t')
        nginx_run('systemctl', 'reload', 'nginx')
        marker.unlink()
    except Exception:
        nginx_recover(root)
        raise
    print('Nginx upload allowance updated to 15g; backup: ' + str(backup))


if __name__ == '__main__':
    try:
        mode = sys.argv[1]
        if mode == 'nginx-recover':
            nginx_recover(sys.argv[2])
            sys.exit(0)
        with open(sys.argv[2]) as source:
            data = json.load(source)
        if mode == 'nginx-update':
            nginx_update(data, sys.argv[3])
            sys.exit(0)
        if mode == 'capture':
            result = capture(data[0]) if len(data) == 1 else None
            if result is None:
                raise ValueError('Select exactly one existing container.')
        elif mode == 'compose':
            result = compose(data, sys.argv[3], sys.argv[4], len(sys.argv) > 5 and sys.argv[5] == 'private')
        elif mode == 'telegram-setup':
            result = telegram_settings(data, sys.stdin.readline().rstrip('\n'), sys.stdin.readline().rstrip('\n'))
        elif mode == 'telegram-disable':
            result = telegram_settings(data)
        elif mode == 'get':
            value = data
            for key in sys.argv[3].split('.'):
                value = value[key]
            print(value)
            sys.exit(0)
        else:
            raise ValueError('Unknown configuration operation.')
        print(json.dumps(result, indent=2))
    except (ValueError, KeyError, IndexError, OSError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
