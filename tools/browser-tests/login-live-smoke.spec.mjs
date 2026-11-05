import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

test.use({ channel: 'chrome' });

const root = path.resolve(import.meta.dirname, '../..');
const fixture = JSON.parse(fs.readFileSync(process.env.SRD_BROWSER_FIXTURE || path.join(root, '.local/e2e-fixture.json')));
const mailUrl = process.env.SRD_MAILPIT_URL || 'http://127.0.0.1:8025';

test('real council login, MFA and logout honor the saved language', async ({ page, request, context }) => {
  test.setTimeout(90000);
  const inbox = async () => (await (await request.get(`${mailUrl}/api/v1/messages`)).json()).messages ?? [];
  const prior = new Set((await inbox()).map(message => message.ID));
  await page.goto(`/j/${fixture.codeA || 'srd-e2e-a'}/login`);
  await expect(page.getByRole('heading', { name: /Iniciar sesión|Sign in/ })).toBeVisible();
  await page.locator('input[name="email"]').fill(fixture.users.admin.email);
  await page.locator('input[name="password"]').fill(fixture.password);
  await page.getByRole('button', { name: /términos y condiciones|terms and conditions/i }).click();
  await page.getByRole('button', { name: /Aceptar términos|Accept terms/i }).click();
  await page.locator('.access-form form button.primary.full').click();
  await expect(page.locator('input[name="code"]')).toBeVisible();
  let messageId;
  await expect.poll(async () => {
    const found = (await inbox()).find(message => !prior.has(message.ID)
      && message.To.some(recipient => recipient.Address === fixture.users.admin.email));
    messageId = found?.ID;
    return Boolean(messageId);
  }, { timeout: 30000 }).toBe(true);
  const message = await (await request.get(`${mailUrl}/api/v1/message/${messageId}`)).json();
  const code = message.Text.match(/\b\d{6}\b/)?.[0];
  expect(code).toMatch(/^\d{6}$/);
  await page.locator('input[name="code"]').fill(code);
  await page.locator('.access-form form button.primary.full').click();
  await expect(page.locator('.app-shell')).toBeVisible();
  const principalResponse = await context.request.get('/api/v1/me');
  expect(principalResponse.status()).toBe(200);
  const principal = (await principalResponse.json()).data;
  expect(principal.organization.id).toBe(fixture.orgA);
  expect(principal.user_id).toBe(fixture.users.admin.id);
  await expect(page.locator('html')).toHaveAttribute('lang', principal.user.language);
  await page.locator('.profile-trigger').click();
  await page.getByRole('button', { name: /Cerrar sesión|Sign out/i }).click();
  await expect(page.getByRole('heading', { name: /Iniciar sesión|Sign in/ })).toBeVisible();
  expect((await context.request.get('/api/v1/me')).status()).toBe(401);
});

test('real council choice is stable when an earlier lookup finishes late', async ({ page, request }) => {
  const codeA = fixture.codeA || 'srd-e2e-a';
  const codeB = fixture.codeB || 'srd-e2e-b';
  const second = await request.get(`/api/v1/organizations/${codeB}`);
  expect(second.status()).toBe(200);
  const organizationB = (await second.json()).data;
  let releaseFirst;
  const firstReady = new Promise(resolve => { releaseFirst = resolve; });
  let lookupStarted;
  const firstStarted = new Promise(resolve => { lookupStarted = resolve; });
  await page.route(`**/api/v1/organizations/${codeA}`, async route => {
    lookupStarted();
    await firstReady;
    await route.continue();
  });
  await page.goto(`/j/${codeA}/login`, { waitUntil: 'domcontentloaded' });
  await firstStarted;
  await page.getByLabel(/Código de la junta|Council code/).fill(codeB);
  await page.locator('.access-form form button.primary.full').click();
  await expect(page.locator('.small-label')).toHaveText(organizationB.name);
  const firstResponse = page.waitForResponse(response => response.url().endsWith(`/organizations/${codeA}`));
  releaseFirst();
  await firstResponse;
  await expect(page.locator('.small-label')).toHaveText(organizationB.name);
  await expect(page.locator('.access-form form input[name="email"]')).toBeVisible();
});
