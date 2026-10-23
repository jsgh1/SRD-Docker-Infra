import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const fixture = JSON.parse(readFileSync(process.env.SRD_BROWSER_FIXTURE, 'utf8'));
const mailpit = process.env.SRD_MAILPIT_URL || 'http://localhost:8025';

test('notification inbox and preferences recover independently', async ({ page }, testInfo) => {
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
  await expect(page.locator('.sidebar')).toBeVisible();
  let inboxFailed = false, preferencesFailed = false;
  await page.route('**/api/v1/notifications?page=*', async route => {
    if (!inboxFailed) {
      inboxFailed = true;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Avisos temporalmente no disponibles.' } }) });
    } else await route.continue();
  });
  await page.route('**/api/v1/notification-preferences', async route => {
    if (!preferencesFailed && route.request().method() === 'GET') {
      preferencesFailed = true;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Preferencias temporalmente no disponibles.' } }) });
    } else await route.continue();
  });
  await page.getByRole('button', { name: /^Notificaciones/ }).click();
  const inbox = page.getByRole('region', { name: 'Bandeja de notificaciones' });
  await expect(inbox).toContainText('Avisos temporalmente no disponibles.');
  await expect(inbox).toContainText('Preferencias temporalmente no disponibles.');
  await expect(inbox.getByText('No tienes avisos.')).toHaveCount(0);
  await expect(inbox.getByText('Cargando preferencias…')).toHaveCount(0);
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth), `Avisos a ${width}px`).toBeLessThanOrEqual(width + 2);
    await inbox.screenshot({ path: testInfo.outputPath(`notifications-error-${width}.png`) });
  }
  await inbox.getByRole('button', { name: 'Actualizar' }).click();
  await expect(inbox.getByText(/sin leer/)).toBeVisible();
  await inbox.getByRole('button', { name: 'Reintentar preferencias de avisos' }).click();
  await expect(inbox.getByRole('checkbox', { name: 'Avisos de mensajes de Chat' })).toBeVisible();
  await page.setViewportSize({ width: 320, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(322);
});
