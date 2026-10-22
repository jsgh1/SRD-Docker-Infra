import { test, expect } from '@playwright/test';
import fs from 'node:fs';

const fixture = JSON.parse(fs.readFileSync(process.env.SRD_BROWSER_FIXTURE));
const mailUrl = process.env.SRD_MAILPIT_URL || 'http://localhost:8025';

test('empty council sections remain clear at mobile and desktop widths', async ({ page }, testInfo) => {
  test.setTimeout(180000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const email = fixture.users.admin.email;
  const before = await (await page.request.get(`${mailUrl}/api/v1/messages`)).json();
  const oldIds = new Set(before.messages?.map(message => message.ID) || []);
  await page.goto(`/j/${fixture.codeA}/login`);
  await page.getByLabel('Correo electrónico', { exact: true }).fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: 'términos y condiciones', exact: true }).click();
  await page.getByRole('button', { name: 'Aceptar términos', exact: true }).click();
  await page.getByRole('button', { name: 'Ingresar', exact: true }).click();
  let message;
  await expect.poll(async () => {
    const list = await (await page.request.get(`${mailUrl}/api/v1/messages`)).json();
    message = list.messages?.find(item => !oldIds.has(item.ID)
      && ['Tu código de seguridad de SRD', 'Your SRD security code'].includes(item.Subject)
      && item.To.some(to => to.Address === email));
    return Boolean(message);
  }, { timeout: 85000 }).toBe(true);
  const content = await (await page.request.get(`${mailUrl}/api/v1/message/${message.ID}`)).json();
  await page.getByLabel('Código de verificación').fill(content.Text.match(/\b\d{6}\b/)[0]);
  await page.getByRole('button', { name: 'Confirmar código' }).click();
  await expect(page.locator('.profile-trigger')).toBeVisible();

  const sections = (await page.locator('.sidebar nav button').allTextContents())
    .map(text => text.trim()).filter(Boolean);
  expect(sections).toHaveLength(14);
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [index, section] of sections.entries()) {
      if (width < 700) await page.getByRole('button', { name: 'Abrir menú' }).click();
      await page.locator('.sidebar nav').getByRole('button', { name: section, exact: true }).click();
      await expect(page.locator('.workspace .loading'), `${section}: carga permanente`).toHaveCount(0, { timeout: 20000 });
      await expect(page.locator('.workspace .error'), `${section}: lectura fallida`).toHaveCount(0);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      expect(overflow, `${section}: desborde horizontal`).toBeLessThanOrEqual(2);
      await page.screenshot({ path: testInfo.outputPath(`${String(index + 1).padStart(2, '0')}-${section}-${width}.png`),
        fullPage: width === 320, animations: 'disabled' });
    }
  }
  expect(errors).toEqual([]);
});
