import {test, expect} from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const fixture = JSON.parse(fs.readFileSync(process.env.SRD_BROWSER_FIXTURE || path.join(root, '.local/e2e-fixture.json'), 'utf8'));
const mailpit = process.env.SRD_MAILPIT_URL || 'http://localhost:8025';

test('API real para el recorrido de Expo Go', async ({request}) => {
  const account = fixture.users.admin.email;
  const inboxBefore = await (await request.get(`${mailpit}/api/v1/messages`)).json();
  const previousIds = new Set((inboxBefore.messages || []).map(message => message.ID));

  const organizationResponse = await request.get(`/api/v1/organizations/${fixture.codeA || 'srd-e2e-a'}`);
  expect(organizationResponse.ok()).toBeTruthy();
  const organization = (await organizationResponse.json()).data;
  expect(organization.terms.id).toBeTruthy();

  let token = (await (await request.get('/api/v1/csrf')).json()).data.token;
  const login = await request.post('/api/v1/auth/login', {
    headers: {'X-CSRF-TOKEN': token},
    data: {email: account, password: fixture.password, organization_code: organization.code,
      accepted: true, terms_version_id: organization.terms.id},
  });
  expect(login.status()).toBe(200);
  const challenge = (await login.json()).data.challenge_id;
  expect(challenge).toBeTruthy();

  let message;
  await expect.poll(async () => {
    const inbox = await (await request.get(`${mailpit}/api/v1/messages`)).json();
    message = (inbox.messages || []).find(item => !previousIds.has(item.ID) &&
      item.To.some(recipient => recipient.Address === account));
    return !!message;
  }, {timeout: 30000}).toBe(true);
  const mail = await (await request.get(`${mailpit}/api/v1/message/${message.ID}`)).json();
  const code = mail.Text.match(/\b\d{6}\b/)?.[0];
  expect(code).toBeTruthy();

  const verify = await request.post('/api/v1/auth/verify', {
    headers: {'X-CSRF-TOKEN': token}, data: {challenge_id: challenge, code},
  });
  expect(verify.status()).toBe(200);
  expect((await verify.json()).data.organization.code).toBe(organization.code);

  const me = await request.get('/api/v1/me');
  expect(me.status()).toBe(200);
  const dashboard = await request.get('/api/v1/dashboard');
  expect(dashboard.status()).toBe(200);
  expect(typeof (await dashboard.json()).data.total).toBe('number');
  const people = await request.get('/api/v1/persons?page=1&page_size=10');
  expect(people.status()).toBe(200);
  expect(Array.isArray((await people.json()).data.items)).toBe(true);
  const agenda = await request.get('/api/v1/calendar-events?from=2026-10-01&to=2026-10-31');
  expect(agenda.status()).toBe(200);
  expect(Array.isArray((await agenda.json()).data.items)).toBe(true);
  const notices = await request.get('/api/v1/notifications?page=1');
  expect(notices.status()).toBe(200);
  expect(Array.isArray((await notices.json()).data.items)).toBe(true);

  token = (await (await request.get('/api/v1/csrf')).json()).data.token;
  expect((await request.post('/api/v1/auth/logout', {headers: {'X-CSRF-TOKEN': token}, data: {}})).status()).toBe(200);
  expect((await request.get('/api/v1/me')).status()).toBe(401);
});
