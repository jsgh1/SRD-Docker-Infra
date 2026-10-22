// Public HTTPS smoke test for tenant separation; uses only synthetic records.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const origin = 'https://srd-jsgh1.duckdns.org';
const statePath = path.join(root, '.local/production/tenant-validation.json');
const state = (() => { try { return JSON.parse(readFileSync(statePath, 'utf8')); } catch { return {}; } })();
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2));
const fixture = JSON.parse(readFileSync(path.join(root, '.local/production/demo-fixture.json'), 'utf8'));
const credentialText = readFileSync(path.join(root, '.local/production/initial-admin-credentials.txt'), 'utf8');
const email = credentialText.match(/^Email: (.+)$/m)?.[1];
const password = credentialText.match(/^Password: (.+)$/m)?.[1];
if (!email || !password || !fixture.personId || !fixture.assetId || !fixture.documentId) throw new Error('Production fixtures or administrator credentials missing');

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

const original = (await call('organizations/srd-piloto')).data;
const requestTime = Math.floor(Date.now() / 1000);
const login = (await call('auth/login', { method: 'POST', body: {
  email, password, organization_code: 'srd-piloto', accepted: true, terms_version_id: original.terms.id,
} })).data;
if (!login.challenge_id) throw new Error('MFA challenge missing');
const mail = spawnSync('ssh', [
  '-i', path.join(root, '.local/deploy-ssh/srd_deploy_ed25519'),
  '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
  'srdadmin@144.91.126.25',
  `sudo -n python3 /opt/srd/scripts/read-production-mfa-imap.py ${requestTime}`,
], { encoding: 'utf8', timeout: 70000 });
if (mail.status !== 0 || !/^\d{6}$/.test(mail.stdout.trim())) throw new Error('Fresh administrator MFA code unavailable');
await call('auth/verify', { method: 'POST', body: { challenge_id: login.challenge_id, code: mail.stdout.trim() } });
if ((await call('me')).data.role !== 'superadmin') throw new Error('Unexpected administrator role');
process.stdout.write('ADMIN_MFA_OK\n');

const code = 'srd-aislamiento-20261021';
let second = await call(`organizations/${code}`, { expected: state.tenantId ? 200 : 404 });
if (!state.tenantId) {
  second = await call('platform/organizations', { method: 'POST', body: {
    code, name: 'SRD - Junta ficticia de aislamiento',
    terms: 'Uso exclusivo para pruebas técnicas con datos ficticios. No ingreses información personal real.',
    terms_en: 'Technical testing only with fictional data. Do not enter real personal information.',
  } });
  state.tenantId = second.data.id;
  state.tenantCode = code;
  save();
  second = await call(`organizations/${code}`);
}
if (second.data.id !== state.tenantId) throw new Error('Second council identity mismatch');
await call('auth/switchOrganization', { method: 'POST', body: {
  organization_code: code, accepted: true, terms_version_id: second.data.terms.id,
} });
if ((await call('me')).data.organization.code !== code) throw new Error('Failed to switch into second council');
const peopleB = (await call('persons')).data;
if (peopleB.total !== 0) throw new Error('Second council unexpectedly contains people');
await call(`persons/${fixture.personId}`, { expected: 404 });
await call(`assets/${fixture.assetId}`, { expected: 404 });
await call(`folder-documents/${fixture.documentId}/download`, { expected: 404 });
if ((await call('treasury')).data.opened) throw new Error('Second council inherited treasury account');
process.stdout.write('COUNCIL_A_DATA_HIDDEN_IN_B_OK\n');

if (!state.secondAssetId) {
  const existing = (await call('assets?q=SRD-ISOLATION-B-01')).data.items?.find(item => item.code === 'SRD-ISOLATION-B-01');
  const result = existing ? { data: { asset: existing } } : await call('assets', { method: 'POST', body: {
    code: 'SRD-ISOLATION-B-01', type: 'movable', name: 'Bien ficticio de junta B',
    category: 'Equipo de prueba', unit: 'unidad', location: 'Sede ficticia B',
    condition: 'Bueno', quantity: 1, idempotency_key: randomUUID(),
  } });
  state.secondAssetId = result.data.asset?.id;
  if (!state.secondAssetId) throw new Error('Second council asset response missing identifier');
  save();
}
if ((await call(`assets/${state.secondAssetId}`)).data.asset?.id !== state.secondAssetId) throw new Error('Second council asset read-back mismatch');
await call('auth/switchOrganization', { method: 'POST', body: {
  organization_code: 'srd-piloto', accepted: true, terms_version_id: original.terms.id,
} });
if ((await call('me')).data.organization.code !== 'srd-piloto') throw new Error('Failed to switch back');
await call(`assets/${state.secondAssetId}`, { expected: 404 });
if ((await call(`persons/${fixture.personId}`)).data.id !== fixture.personId) throw new Error('Original council data missing');
process.stdout.write('COUNCIL_B_DATA_HIDDEN_IN_A_OK\n');

state.invitations ??= {};
for (const role of ['admin', 'registrar', 'treasurer', 'auditor', 'viewer']) {
  if (state.invitations[role]) continue;
  const recipient = email.replace('@', `+qa-${role}@`);
  const invitation = (await call('invitations', { method: 'POST', body: { email: recipient, role } })).data;
  state.invitations[role] = { id: invitation.id, email: recipient };
  save();
}
const invitationList = (await call('invitations')).data.items;
for (const [role, invitation] of Object.entries(state.invitations)) {
  if (!invitationList.some(item => item.id === invitation.id && item.role === role)) throw new Error(`${role} invitation missing`);
}
process.stdout.write('FIVE_ROLE_INVITATIONS_CREATED_OK\n');
await call('auth/logout', { method: 'POST', body: {} });
await call('me', { expected: 401 });
process.stdout.write('TENANCY_AND_ADMIN_SESSION_OK\n');
