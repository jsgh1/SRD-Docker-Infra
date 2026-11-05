#!/usr/bin/env python3
"""Print counts only for synthetic invitation delivery diagnostics."""

import email
import email.policy
import html
import imaplib
import re
import sys
from email.header import decode_header, make_header
from email.utils import getaddresses, parseaddr
from pathlib import Path


def main():
    if len(sys.argv) != 3 or not re.fullmatch(r'[0-9a-f-]{36}', sys.argv[1]):
        raise ValueError('Expected invitation id and exact recipient')
    invitation_id, recipient = sys.argv[1:]
    env = dict(line.split('=', 1) for line in Path('/opt/srd/.env.production').read_text().splitlines() if '=' in line)
    client = imaplib.IMAP4_SSL('imap.gmail.com', 993, timeout=12)
    try:
        client.login(env['SMTP_USERNAME'], env['SMTP_PASSWORD'])
        for mailbox in ('INBOX', '[Gmail]/All Mail'):
            status, _ = client.select(f'"{mailbox}"', readonly=True)
            if status != 'OK':
                print(f'{mailbox}:unavailable')
                continue
            status, matches = client.search(None, 'FROM', f'"{env["SMTP_USERNAME"]}"', 'SUBJECT', '"SRD"')
            if status != 'OK':
                print(f'{mailbox}:search_failed')
                continue
            counts = {'sender': 0, 'recipient': 0, 'invitation_subject': 0, 'link_id': 0}
            for number in reversed(matches[0].split()[-100:]):
                status, parts = client.fetch(number, '(BODY.PEEK[])')
                raw = next((part[1] for part in parts if isinstance(part, tuple)), None) if status == 'OK' else None
                if not raw:
                    continue
                message = email.message_from_bytes(raw, policy=email.policy.default)
                if parseaddr(message.get('From', ''))[1].lower() != env['SMTP_USERNAME'].lower():
                    continue
                counts['sender'] += 1
                destinations = {address.lower() for _, address in getaddresses(message.get_all('To', []))}
                if recipient.lower() not in destinations:
                    continue
                counts['recipient'] += 1
                subject = str(make_header(decode_header(message.get('Subject', '')))).lower()
                if 'invit' not in subject:
                    continue
                counts['invitation_subject'] += 1
                body = message.get_body(preferencelist=('html', 'plain'))
                content = html.unescape(body.get_content()) if body else ''
                if f'/invite#{invitation_id}.' in content:
                    counts['link_id'] += 1
                    exact = re.search(r'https://srd-jsgh1\.duckdns\.org/invite#' + re.escape(invitation_id) + r'\.[a-f0-9]{64}\.(?:es|en)', content)
                    counts['exact_pattern'] = int(bool(exact))
                    token = re.search(r'/invite#' + re.escape(invitation_id) + r'\.([^\.\s"<>]+)\.([a-z]{2})', content)
                    if token:
                        counts['token_length'] = len(token.group(1))
                        counts['language_es'] = int(token.group(2) == 'es')
            print(mailbox + ':' + ','.join(f'{key}={value}' for key, value in counts.items()))
    finally:
        client.logout()


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(f'IMAP_DIAGNOSTIC_ERROR:{type(exc).__name__}', file=sys.stderr)
        sys.exit(1)
