import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const fixture = JSON.parse(readFileSync(process.env.SRD_BROWSER_FIXTURE, 'utf8'));
const mailpit = process.env.SRD_MAILPIT_URL || 'http://localhost:8025';

test('sign-in sheet settings recover after a failed read', async ({ page }) => {
  test.setTimeout(120000);
  const email = fixture.users.admin.email;
  const before = await (await page.request.get(`${mailpit}/api/v1/messages`)).json();
  const oldIds = new Set(before.messages?.map(message => message.ID) || []);
  await page.goto(`/j/${fixture.codeA}/login`);
  await page.getByLabel('Correo electrónico', { exact: true }).fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: 'términos y condiciones', exact: true }).click();
  await page.getByRole('button', { name: 'Aceptar términos', exact: true }).click();
  await page.getByRole('button', { name: 'Ingresar', exact: true }).click();
  let message;
  await expect.poll(async () => {
    const list = await (await page.request.get(`${mailpit}/api/v1/messages`)).json();
    message = list.messages?.find(item => !oldIds.has(item.ID) && item.To.some(to => to.Address === email));
    return Boolean(message);
  }, { timeout: 85000 }).toBe(true);
  const content = await (await page.request.get(`${mailpit}/api/v1/message/${message.ID}`)).json();
  await page.getByLabel('Código de verificación').fill(content.Text.match(/\b\d{6}\b/)[0]);
  await page.getByRole('button', { name: 'Confirmar código' }).click();
  const nav = page.locator('.sidebar').getByRole('button', { name: 'Configuración', exact: true });
  await expect(nav).toBeVisible();
  let failed = false;
  await page.route('**/api/v1/planilla-settings', async route => {
    if (!failed && route.request().method() === 'GET') {
      failed = true;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Planilla temporalmente no disponible.' } }) });
    } else await route.continue();
  });
  await nav.click();
  const section = page.getByRole('region', { name: 'Configuración de planilla' });
  await expect(section.getByRole('button', { name: 'Reintentar configuración de planilla' })).toBeVisible();
  await expect(section).toContainText('Planilla temporalmente no disponible.');
  await section.getByRole('button', { name: 'Reintentar configuración de planilla' }).click();
  await expect(section.getByRole('group', { name: 'Composición y columnas disponibles' })).toBeVisible();
  await page.setViewportSize({ width: 320, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(322);
});
