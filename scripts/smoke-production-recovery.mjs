// Checks that the public recovery request delivers a fresh Gmail message.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const credentials = readFileSync(path.resolve('.local/production/initial-admin-credentials.txt'), 'utf8');
const address = credentials.match(/^Email: (.+)$/m)?.[1];
if (!address) throw new Error('Initial administrator email missing');
const origin = 'https://srd-jsgh1.duckdns.org';
const csrfResponse = await fetch(`${origin}/api/v1/csrf`, { headers: { Accept: 'application/json' } });
if (csrfResponse.status !== 200) throw new Error(`CSRF HTTP ${csrfResponse.status}`);
const token = (await csrfResponse.json()).data.token;
const cookies = csrfResponse.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
const requestTime = Date.now() / 1000;
const response = await fetch(`${origin}/api/v1/auth/recover`, {
  method: 'POST',
  headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-TOKEN': token, Cookie: cookies },
  body: JSON.stringify({ email: address, organization_code: 'srd-piloto' }),
});
if (response.status !== 200) throw new Error(`Recovery HTTP ${response.status}`);
const message = (await response.json()).data?.message;
if (!message) throw new Error('Recovery acknowledgement missing');

const mail = spawnSync('ssh', [
  '-i', path.resolve('.local/deploy-ssh/srd_deploy_ed25519'),
  '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
  'srdadmin@144.91.126.25',
  `sudo -n python3 /opt/srd/scripts/read-production-mfa-imap.py ${Math.floor(requestTime)} reset`,
], { encoding: 'utf8', timeout: 70000 });
if (mail.status !== 0 || mail.stdout.trim() !== 'RECOVERY_MAIL_FOUND') {
  throw new Error(`Fresh recovery email unavailable (${mail.stderr?.trim() || mail.error?.message || mail.status})`);
}
process.stdout.write('PRODUCTION_RECOVERY_DELIVERY_OK\n');
