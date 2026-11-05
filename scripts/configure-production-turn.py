#!/usr/bin/env python3
"""Prepare the private Coturn config and matching short-lived SRD credentials."""

import ipaddress
import os
import re
import secrets
import sys
import tempfile
from pathlib import Path


ROOT = Path('/opt/srd')
ENV = ROOT / '.env.production'
TURN = ROOT / '.turnserver.conf'


def atomic_private_write(path: Path, content: str, owner: tuple[int, int] | None = None) -> None:
    descriptor, temporary = tempfile.mkstemp(prefix='.srd-turn-', dir=path.parent)
    try:
        os.fchmod(descriptor, 0o600)
        if owner is not None:
            os.fchown(descriptor, *owner)
        with os.fdopen(descriptor, 'w', encoding='utf-8', newline='\n') as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main() -> None:
    if os.geteuid() != 0 or len(sys.argv) != 2:
        raise RuntimeError('Run as root with the VPS public IPv4 argument')
    address = ipaddress.IPv4Address(sys.argv[1])
    lines = ENV.read_text(encoding='utf-8').splitlines()
    values = {}
    for line in lines:
        if '=' not in line or line.lstrip().startswith('#'):
            continue
        key, value = line.split('=', 1)
        if key in values:
            raise RuntimeError('Duplicate environment key')
        values[key] = value
    domain = values.get('SRD_DOMAIN', '')
    if not re.fullmatch(r'[a-z0-9.-]{4,240}', domain):
        raise RuntimeError('Invalid SRD_DOMAIN')
    secret = values.get('WEBRTC_TURN_SECRET') or secrets.token_hex(32)
    if not re.fullmatch(r'[a-f0-9]{64}', secret):
        raise RuntimeError('TURN secret must contain 64 lowercase hex characters')
    wanted = {
        'WEBRTC_STUN_URL': f'stun:{domain}:3478',
        'WEBRTC_TURN_URL': f'turn:{domain}:3478?transport=udp',
        'WEBRTC_TURN_SECRET': secret,
    }
    for key, value in wanted.items():
        if key in values and values[key] not in ('', value):
            raise RuntimeError(f'{key} already has another value; no automatic overwrite')
    updated = []
    for line in lines:
        if '=' in line:
            key, current = line.split('=', 1)
            if key in wanted and current == '':
                line = f'{key}={wanted[key]}'
        updated.append(line)
    updated.extend(f'{key}={value}' for key, value in wanted.items() if key not in values)
    if updated != lines:
        atomic_private_write(ENV, '\n'.join(updated) + '\n')

    config = '\n'.join([
        f'listening-ip={address}',
        f'relay-ip={address}',
        'listening-port=3478',
        'min-port=49160',
        'max-port=49200',
        f'realm={domain}',
        'fingerprint',
        'use-auth-secret',
        f'static-auth-secret={secret}',
        'no-tcp',
        'no-tls',
        'no-multicast-peers',
        'denied-peer-ip=10.0.0.0-10.255.255.255',
        'denied-peer-ip=172.16.0.0-172.31.255.255',
        'denied-peer-ip=192.168.0.0-192.168.255.255',
        'denied-peer-ip=169.254.0.0-169.254.255.255',
        'user-quota=8',
        'total-quota=96',
        'max-bps=1000000',
        'stale-nonce=600',
        'log-file=stdout',
        '',
    ])
    # The pinned Coturn image runs as UID 65534/GID 65533 before reading config.
    atomic_private_write(TURN, config, owner=(65534, 65533))
    print('TURN_CONFIG_READY')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'TURN_CONFIG_ERROR:{type(error).__name__}', file=sys.stderr)
        sys.exit(1)
