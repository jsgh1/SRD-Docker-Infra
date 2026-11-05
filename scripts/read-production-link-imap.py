#!/usr/bin/env python3
"""Read one fresh SRD invitation or recovery link from the dedicated test inbox."""

import email
import email.policy
import html
import imaplib
import re
import sys
import time
from email.header import decode_header, make_header
from email.utils import getaddresses, parsedate_to_datetime, parseaddr
from pathlib import Path


def main():
    if len(sys.argv) != 4 or sys.argv[1] not in ('invite', 'reset'):
        raise ValueError('Expected kind, invitation id or timestamp, and exact recipient')
    kind, key, recipient = sys.argv[1:]
    if kind == 'invite' and not re.fullmatch(r'[0-9a-f-]{36}', key):
        raise ValueError('Invalid invitation id')
    if kind == 'reset':
        since = float(key)
    else:
        since = 0
    env = dict(line.split('=', 1) for line in Path('/opt/srd/.env.production').read_text().splitlines() if '=' in line)
    client = imaplib.IMAP4_SSL('imap.gmail.com', 993, timeout=12)
    try:
        client.login(env['SMTP_USERNAME'], env['SMTP_PASSWORD'])
        client.select('INBOX', readonly=True)
        deadline = time.monotonic() + 75
        while time.monotonic() < deadline:
            status, matches = client.search(None, 'FROM', f'"{env["SMTP_USERNAME"]}"', 'SUBJECT', '"SRD"')
            if status != 'OK':
                raise RuntimeError('IMAP search failed')
            for number in reversed(matches[0].split()[-75:]):
                status, parts = client.fetch(number, '(BODY.PEEK[])')
                if status != 'OK':
                    continue
                raw = next((part[1] for part in parts if isinstance(part, tuple)), None)
                if not raw:
                    continue
                message = email.message_from_bytes(raw, policy=email.policy.default)
                if parseaddr(message.get('From', ''))[1].lower() != env['SMTP_USERNAME'].lower():
                    continue
                destinations = {address.lower() for _, address in getaddresses(message.get_all('To', []))}
                if recipient.lower() not in destinations:
                    continue
                try:
                    sent_at = parsedate_to_datetime(message.get('Date', '')).timestamp()
                except (TypeError, ValueError):
                    continue
                if sent_at < since - 5:
                    continue
                subject = str(make_header(decode_header(message.get('Subject', '')))).lower()
                if kind == 'invite' and 'invit' not in subject:
                    continue
                if kind == 'reset' and 'restablece' not in subject and 'reset' not in subject:
                    continue
                body = message.get_body(preferencelist=('html', 'plain'))
                if body is None:
                    continue
                content = html.unescape(body.get_content())
                pattern = (r'https://srd-jsgh1\.duckdns\.org/invite#' + re.escape(key) + r'\.[a-f0-9]{64}\.(?:es|en)'
                           if kind == 'invite' else
                           r'https://srd-jsgh1\.duckdns\.org/reset#[0-9a-f-]{36}\.[a-f0-9]{64}')
                link = re.search(pattern, content)
                if link:
                    print(link.group(0))
                    return
            time.sleep(3)
        raise RuntimeError('Fresh SRD link not found')
    finally:
        try:
            client.logout()
        except Exception:
            pass


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(f'IMAP_ERROR:{type(exc).__name__}', file=sys.stderr)
        sys.exit(1)
