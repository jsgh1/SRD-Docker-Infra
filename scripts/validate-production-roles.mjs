// Accepts invitations to the dedicated test inbox and validates RBAC over public HTTPS.
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const origin = 'https://srd-jsgh1.duckdns.org';
const invitations = JSON.parse(readFileSync(path.join(root, '.local/production/tenant-validation.json'), 'utf8')).invitations;
const accountPath = path.join(root, '.local/production/qa-accounts.json');
const accounts = (() => { try { return JSON.parse(readFileSync(accountPath, 'utf8')); } catch { return {}; } })();
const save = () => writeFileSync(accountPath, JSON.stringify(accounts, null, 2));
const ssh = (command) => {
  const response = spawnSync('ssh', [
    '-i', path.join(root, '.local/deploy-ssh/srd_deploy_ed25519'),
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    'srdadmin@144.91.126.25', command,
  ], { encoding: 'utf8', timeout: 95000 });
  if (response.status !== 0) throw new Error(`SRD test inbox unavailable: ${response.stderr?.trim() || response.error?.message || response.status}`);
  return response.stdout.trim();
};

function client() {
  const jar = new Map();
  async function call(route, { method = 'GET', body, expected = 200 } = {}) {
    const csrf = method === 'GET' ? null : (await call('csrf')).data.token;
    const response = await fetch(origin + '/api/v1/' + route, {
      method,
      headers: {
        Accept: 'application/json',
        Cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; '),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(csrf ? { 'X-CSRF-TOKEN': csrf } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const index = pair.indexOf('=');
      if (index > 0) jar.set(pair.slice(0, index), pair.slice(index + 1));
    }
    const json = await response.json();
    if (response.status !== expected) throw new Error(`${route} ${method}: HTTP ${response.status}, expected ${expected} (${json?.error?.message ?? ''})`);
    return json;
  }
  call.cookies = () => [...jar].map(([name, value]) => ({ name, value, domain: 'srd-jsgh1.duckdns.org', path: '/', secure: true }));
  return call;
}

const roles = ['admin', 'registrar', 'treasurer', 'auditor', 'viewer'];
const selected = process.argv[2];
if (selected && !roles.includes(selected)) throw new Error('Unknown QA role');
for (const role of selected ? [selected] : roles) {
  const invitation = invitations?.[role];
  if (!invitation) throw new Error(`Invitation for ${role} missing`);
  const account = accounts[role] ?? { email: invitation.email, password: randomBytes(24).toString('base64url'), accepted: false };
  accounts[role] = account;
  save();
  if (!account.accepted) {
    const link = ssh(`sudo -n python3 /opt/srd/scripts/read-production-link-imap.py invite ${invitation.id} ${invitation.email}`);
    const match = link.match(/^https:\/\/srd-jsgh1\.duckdns\.org\/invite#([0-9a-f-]{36})\.([a-f0-9]{64})\.(?:es|en)$/);
    if (!match || match[1] !== invitation.id) throw new Error(`${role} invitation link invalid`);
    const call = client();
    const inspected = (await call('invitations/inspect', { method: 'POST', body: { invitation_id: match[1], secret: match[2] } })).data;
    if (inspected.role !== role || inspected.email !== invitation.email || inspected.organization.code !== 'srd-piloto') throw new Error(`${role} invitation mismatch`);
    await call('invitations/accept', { method: 'POST', body: {
      invitation_id: match[1], secret: match[2], name: `SRD QA ${role}`,
      password: account.password, password_confirmation: account.password,
      terms_version_id: inspected.organization.terms.id, accepted: true, language: 'es',
    } });
    account.accepted = true;
    save();
    process.stdout.write(`INVITATION_${role.toUpperCase()}_ACCEPTED_OK\n`);
  }

  if (account.checked) continue;
  const call = client();
  const org = (await call('organizations/srd-piloto')).data;
  const requestTime = Math.floor(Date.now() / 1000);
  const challenge = (await call('auth/login', { method: 'POST', body: {
    email: account.email, password: account.password, organization_code: 'srd-piloto',
    accepted: true, terms_version_id: org.terms.id,
  } })).data;
  const code = ssh(`sudo -n python3 /opt/srd/scripts/read-production-mfa-imap.py ${requestTime} ${account.email}`);
  if (!/^\d{6}$/.test(code)) throw new Error(`${role} MFA code invalid`);
  await call('auth/verify', { method: 'POST', body: { challenge_id: challenge.challenge_id, code } });
  if ((await call('me')).data.role !== role) throw new Error(`${role} session role mismatch`);
  await call('persons');
  await call('dashboard');
  await call('treasury', { expected: ['admin', 'treasurer'].includes(role) ? 200 : 403 });
  await call('assets', { expected: ['admin', 'treasurer'].includes(role) ? 200 : 403 });
  await call('audit-events', { expected: ['admin', 'auditor'].includes(role) ? 200 : 403 });
  await call('members', { expected: role === 'admin' ? 200 : 403 });
  await call('platform/organizations', { expected: 403 });
  await call('persons', { method: 'POST', body: {}, expected: ['admin', 'registrar'].includes(role) ? 422 : 403 });
  await call('assets', { method: 'POST', body: {}, expected: ['admin', 'treasurer'].includes(role) ? 422 : 403 });
  const second = (await call('organizations/srd-aislamiento-20261021')).data;
  await call('auth/switchOrganization', { method: 'POST', body: {
    organization_code: second.code, accepted: true, terms_version_id: second.terms.id,
  }, expected: 403 });
  if ((await call('me')).data.organization.code !== 'srd-piloto') throw new Error(`${role} switched without membership`);
  if (['admin', 'viewer'].includes(role)) {
    account.cookies = call.cookies();
  } else {
    await call('auth/logout', { method: 'POST', body: {} });
    await call('me', { expected: 401 });
  }
  account.checked = true;
  save();
  process.stdout.write(`ROLE_${role.toUpperCase()}_BOUNDARIES_OK\n`);
}
if (roles.every(role => accounts[role]?.checked)) process.stdout.write('FIVE_PRODUCTION_ROLES_OK\n');
