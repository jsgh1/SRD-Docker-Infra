// Exercises production login through HTTPS without disclosing credentials or MFA codes.
import { readFileSync } from 'node:fs';
import path from 'node:path';

const credentials = readFileSync(path.resolve('.local/production/initial-admin-credentials.txt'), 'utf8');
const email = credentials.match(/^Email: (.+)$/m)?.[1];
const password = credentials.match(/^Password: (.+)$/m)?.[1];
if (!email || !password) throw new Error('Initial administrator credentials missing');

const origin = 'https://srd-jsgh1.duckdns.org';
const jar = new Map();
async function call(route, options = {}) {
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
  const result = await response.json();
  if (!response.ok) throw new Error(`${route} returned HTTP ${response.status}: ${result.message ?? ''}`);
  return result.data;
}

const organization = await call('/api/v1/organizations/srd-piloto');
const { token } = await call('/api/v1/csrf');
const challenge = await call('/api/v1/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-CSRF-TOKEN': token },
  body: JSON.stringify({
    email,
    password,
    organization_code: 'srd-piloto',
    accepted: true,
    terms_version_id: organization.terms.id,
  }),
});
if (!challenge.challenge_id) throw new Error('Login did not issue an MFA challenge');
process.stdout.write('PRODUCTION_LOGIN_MFA_ISSUED\n');
