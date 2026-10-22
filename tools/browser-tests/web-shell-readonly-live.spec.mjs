import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

test.use({ channel: 'chrome' });
const root = path.resolve(import.meta.dirname, '../..');
const fixture = JSON.parse(readFileSync(path.join(root, '.local/e2e-fixture.json'), 'utf8'));
const account = fixture.users.superadmin;

test('all administrator sections remain usable at mobile and desktop widths with real services', async ({ page, request }) => {
  test.setTimeout(180000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const mailpit = process.env.SRD_MAILPIT_URL || 'http://127.0.0.1:8025';
  const inbox = async () => (await (await request.get(`${mailpit}/api/v1/messages`)).json()).messages ?? [];
  const previous = new Set((await inbox()).map(message => message.ID));
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(`/j/${fixture.codeA || 'srd-e2e-a'}/login`);
  await page.getByLabel(/^(Correo electrónico|Email address)$/).fill(account.email);
  await page.getByLabel(/^(Contraseña|Password)$/).fill(fixture.password);
  await page.getByRole('button', { name: /^(términos y condiciones|terms and conditions)$/i }).click();
  await page.getByRole('button', { name: /^(Aceptar términos|Accept terms)$/ }).click();
  await page.getByRole('button', { name: /^(Ingresar|Sign in)$/ }).click();
  let mailId;
  await expect.poll(async () => {
    mailId = (await inbox()).find(message => !previous.has(message.ID)
      && message.To.some(to => to.Address === account.email))?.ID;
    return Boolean(mailId);
  }, { timeout: 30000 }).toBe(true);
  const mail = await (await request.get(`${mailpit}/api/v1/message/${mailId}`)).json();
  await page.getByLabel(/^(Código de verificación|Verification code)$/).fill(mail.Text.match(/\b\d{6}\b/)[0]);
  await page.getByRole('button', { name: /^(Confirmar código|Confirm code)$/ }).click();
  await expect(page.locator('.profile-trigger')).toBeVisible();
  const language = await page.locator('html').getAttribute('lang');
  expect(['es', 'en']).toContain(language);

  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    if (width === 320) await page.getByRole('button', { name: /^(Abrir menú|Open menu)$/ }).click();
    const labels = await page.locator('.sidebar nav button').allTextContents();
    if (width === 320) await page.locator('.hamburger').click();
    expect(labels.length).toBeGreaterThanOrEqual(12);
    for (let index = 0; index < labels.length; index++) {
      if (width === 320) await page.getByRole('button', { name: /^(Abrir menú|Open menu)$/ }).click();
      await page.locator('.sidebar nav button').nth(index).click();
      await expect(page.locator('.sidebar nav button').nth(index)).toHaveClass(/active/);
      await expect(page.locator('.workspace')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        `${width}px, ${labels[index].trim()}: document overflow`).toBe(true);
      expect(await page.locator('.workspace .error').count(), `${labels[index].trim()}: UI error`).toBe(0);
    }
  }
  expect(errors).toEqual([]);
});
