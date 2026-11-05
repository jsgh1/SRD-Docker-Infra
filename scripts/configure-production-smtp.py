#!/usr/bin/env python3
"""Set Gmail SMTP secrets on the VPS without placing them in shell arguments."""

import getpass
import os
import re
import tempfile
from pathlib import Path


ENV_PATH = Path('/opt/srd/.env.production')


def main():
    if os.geteuid() != 0:
        raise SystemExit('Run as root.')
    email = input('SMTP email: ').strip()
    if not re.fullmatch(r'[^\s@]+@gmail\.com', email, re.IGNORECASE):
        raise SystemExit('Expected a Gmail address.')
    password = re.sub(r'\s+', '', getpass.getpass('Gmail app password: '))
    if not re.fullmatch(r'[A-Za-z0-9]{16}', password):
        raise SystemExit('Expected a 16-character Gmail app password.')

    replacements = {
        'SMTP_HOST': 'smtp.gmail.com',
        'SMTP_PORT': '587',
        'SMTP_SCHEME': 'smtp',
        'SMTP_USERNAME': email,
        'SMTP_PASSWORD': password,
        'SMTP_FROM_ADDRESS': email,
    }
    lines = ENV_PATH.read_text(encoding='utf-8').splitlines()
    seen = set()
    updated = []
    for line in lines:
        key = line.split('=', 1)[0] if '=' in line else None
        if key in replacements:
            updated.append(f'{key}={replacements[key]}')
            seen.add(key)
        else:
            updated.append(line)
    updated.extend(f'{key}={value}' for key, value in replacements.items() if key not in seen)

    fd, temporary = tempfile.mkstemp(prefix='.env.production.', dir=ENV_PATH.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as handle:
            handle.write('\n'.join(updated) + '\n')
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, ENV_PATH)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    print('SMTP configurado.')


if __name__ == '__main__':
    main()
