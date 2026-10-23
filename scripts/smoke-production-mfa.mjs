// End-to-end production MFA using only a fresh SRD test message in the dedicated inbox.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const credentials = readFileSync(path.resolve('.local/production/initial-admin-credentials.txt'), 'utf8');
const email = credentials.match(/^Email: (.+)$/m)?.[1];
const password = credentials.match(/^Password: (.+)$/m)?.[1];
if (!email || !password) throw new Error('Initial administrator credentials missing');

const origin = 'https://srd-jsgh1.duckdns.org';
const jar = new Map();
async function call(route, options = {}, expected = 200) {
  const response = await fetch(origin + route, {
    ...options,
    headers: {
      Accept: 'application/json',
      Cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; '),
      ...options.headers,
    },
  });
  for (const setCookie of response.headers.getSetCookie()) {
    const [pair] = setCookie.split(';');
    const index = pair.indexOf('=');
    if (index > 0) jar.set(pair.slice(0, index), pair.slice(index + 1));
  }
  if (response.status !== expected) throw new Error(`${route} returned HTTP ${response.status}, expected ${expected}`);
  return response.json();
}

const organization = (await call('/api/v1/organizations/srd-piloto')).data;
let csrf = (await call('/api/v1/csrf')).data.token;
const requestTime = Date.now() / 1000;
const challenge = (await call('/api/v1/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-CSRF-TOKEN': csrf },
  body: JSON.stringify({
    email, password, organization_code: 'srd-piloto',
    accepted: true, terms_version_id: organization.terms.id,
  }),
})).data;
if (!challenge.challenge_id) throw new Error('Login did not issue an MFA challenge');

const mail = spawnSync('ssh', [
  '-i', path.resolve('.local/deploy-ssh/srd_deploy_ed25519'),
  '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
  'srdadmin@144.91.126.25',
  `sudo -n python3 /opt/srd/scripts/read-production-mfa-imap.py ${Math.floor(requestTime)}`,
], { encoding: 'utf8', timeout: 70000 });
if (mail.status !== 0) throw new Error(`Fresh MFA email unavailable (${mail.stderr?.trim() || mail.error?.message || mail.status})`);
const code = mail.stdout.trim();
if (!/^\d{6}$/.test(code)) throw new Error('MFA email did not contain a valid code');

const principal = (await call('/api/v1/auth/verify', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-CSRF-TOKEN': csrf },
  body: JSON.stringify({ challenge_id: challenge.challenge_id, code }),
})).data;
if (principal.role !== 'superadmin' || principal.organization.code !== 'srd-piloto') {
  throw new Error('Verified principal has unexpected role or organization');
}
const me = (await call('/api/v1/me')).data;
if (me.user_id !== principal.user_id) throw new Error('Session did not persist');
await call('/api/v1/system/services');
await call('/api/v1/members');
const modules = [
  'dashboard', 'persons', 'folder-access', 'folder-quota', 'assets',
  'treasury', `calendar-events?${new URLSearchParams({
    from: new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10),
    to: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
  })}`, 'notifications', 'audit-events',
  'conversations', 'quick-links', 'system/schedulers', 'system/mail-deliveries',
];
const failures = [];
for (const module of modules) {
  try {
    await call(`/api/v1/${module}`);
    process.stdout.write(`MODULE_${module.split('?')[0].replaceAll('/', '_')}_OK\n`);
  } catch (error) {
    failures.push(`${module}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
csrf = (await call('/api/v1/csrf')).data.token;
await call('/api/v1/auth/logout', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-CSRF-TOKEN': csrf },
  body: '{}',
});
await call('/api/v1/me', {}, 401);
process.stdout.write('PRODUCTION_MFA_SESSION_LOGOUT_OK\n');
if (failures.length) throw new Error(`Module reads failed: ${failures.join('; ')}`);
