#!/usr/bin/env python3
"""Capture an existing Docker deployment without guessing its storage or settings."""
import json
import sys


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
    service = {'image': image, 'environment': settings['environment'],
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


if __name__ == '__main__':
    try:
        mode = sys.argv[1]
        with open(sys.argv[2]) as source:
            data = json.load(source)
        if mode == 'capture':
            result = capture(data[0]) if len(data) == 1 else None
            if result is None:
                raise ValueError('Select exactly one existing container.')
        elif mode == 'compose':
            result = compose(data, sys.argv[3], sys.argv[4], len(sys.argv) > 5 and sys.argv[5] == 'private')
        elif mode == 'get':
            value = data
            for key in sys.argv[3].split('.'):
                value = value[key]
            print(value)
            sys.exit(0)
        else:
            raise ValueError('Unknown configuration operation.')
        print(json.dumps(result, indent=2))
    except (ValueError, KeyError, IndexError) as error:
        sys.exit(str(error))
