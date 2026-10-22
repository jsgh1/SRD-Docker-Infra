#!/usr/bin/env python3
"""Read only a fresh SRD MFA email from the dedicated Gmail inbox."""

import email
import email.policy
import imaplib
import re
import sys
import time
from email.header import decode_header, make_header
from email.utils import getaddresses, parsedate_to_datetime, parseaddr
from pathlib import Path


def main():
    if len(sys.argv) not in (2, 3):
        raise SystemExit('Expected request timestamp')
    inspect = sys.argv[1] == 'inspect'
    reset = len(sys.argv) == 3 and sys.argv[2] == 'reset'
    recipient = sys.argv[2].lower() if len(sys.argv) == 3 and not reset else None
    since = 0 if inspect else float(sys.argv[1])
    env = dict(line.split('=', 1) for line in Path('/opt/srd/.env.production').read_text().splitlines() if '=' in line)
    client = imaplib.IMAP4_SSL('imap.gmail.com', 993, timeout=12)
    try:
        client.login(env['SMTP_USERNAME'], env['SMTP_PASSWORD'])
        client.select('INBOX', readonly=True)
        if inspect:
            status, matches = client.search(None, 'FROM', f'"{env["SMTP_USERNAME"]}"', 'SUBJECT', '"SRD"')
            if status != 'OK':
                raise RuntimeError('IMAP search failed')
            counters = {'recent': 0, 'from_self': 0, 'srd_subject': 0, 'six_digits': 0, 'paragraph_match': 0}
            ages = []
            for number in reversed(matches[0].split()[-25:]):
                status, parts = client.fetch(number, '(BODY.PEEK[])')
                if status != 'OK':
                    continue
                raw = next((part[1] for part in parts if isinstance(part, tuple)), None)
                if not raw:
                    continue
                counters['recent'] += 1
                message = email.message_from_bytes(raw, policy=email.policy.default)
                if parseaddr(message.get('From', ''))[1].lower() != env['SMTP_USERNAME'].lower():
                    continue
                counters['from_self'] += 1
                subject = str(make_header(decode_header(message.get('Subject', ''))))
                if 'SRD' not in subject:
                    continue
                counters['srd_subject'] += 1
                try:
                    ages.append(round(time.time() - parsedate_to_datetime(message.get('Date', '')).timestamp()))
                except (TypeError, ValueError):
                    pass
                body = message.get_body(preferencelist=('html', 'plain'))
                if body is None:
                    continue
                content = body.get_content()
                if re.search(r'\b\d{6}\b', content):
                    counters['six_digits'] += 1
                if re.search(r'<p[^>]*>\s*(\d{6})\s*</p>', content, re.IGNORECASE | re.DOTALL):
                    counters['paragraph_match'] += 1
            print(' '.join(f'{key}={value}' for key, value in counters.items()) +
                  (f' newest_age_seconds={min(ages)}' if ages else ''))
            return
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            # Gmail's IMAP internal date can differ from the message Date clock.
            # Search only mail sent by SRD, then apply the message Date filter.
            status, matches = client.search(None, 'FROM', f'"{env["SMTP_USERNAME"]}"', 'SUBJECT', '"SRD"')
            if status != 'OK':
                raise RuntimeError('IMAP search failed')
            for number in reversed(matches[0].split()[-30:]):
                status, parts = client.fetch(number, '(BODY.PEEK[])')
                if status != 'OK':
                    continue
                raw = next((part[1] for part in parts if isinstance(part, tuple)), None)
                if not raw:
                    continue
                message = email.message_from_bytes(raw, policy=email.policy.default)
                if parseaddr(message.get('From', ''))[1].lower() != env['SMTP_USERNAME'].lower():
                    continue
                if recipient and recipient not in {address.lower() for _, address in getaddresses(message.get_all('To', []))}:
                    continue
                try:
                    date = parsedate_to_datetime(message.get('Date', ''))
                except (TypeError, ValueError):
                    continue
                if date.timestamp() < since - 5:
                    continue
                subject = str(make_header(decode_header(message.get('Subject', ''))))
                if 'SRD' not in subject:
                    continue
                if reset and not ('restablece' in subject.lower() or 'reset' in subject.lower()):
                    continue
                if not reset and not ('seguridad' in subject.lower() or 'security' in subject.lower()):
                    continue
                body = message.get_body(preferencelist=('html', 'plain'))
                if body is None:
                    continue
                content = body.get_content()
                if reset:
                    if 'https://srd-jsgh1.duckdns.org/reset#' in content:
                        print('RECOVERY_MAIL_FOUND')
                        return
                    continue
                code = re.search(r'<p[^>]*>\s*(\d{6})\s*</p>', content, re.IGNORECASE | re.DOTALL)
                if code:
                    print(code.group(1))
                    return
            time.sleep(2)
        raise RuntimeError('Fresh MFA email not found')
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
