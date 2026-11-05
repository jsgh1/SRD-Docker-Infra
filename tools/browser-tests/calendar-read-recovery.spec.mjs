import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const fixture = JSON.parse(readFileSync(process.env.SRD_BROWSER_FIXTURE, 'utf8'));
const mailpit = process.env.SRD_MAILPIT_URL || 'http://localhost:8025';

test('calendar does not show old or empty events after a failed read', async ({ page }) => {
  test.setTimeout(150000);
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
    message = list.messages?.find(item => !oldIds.has(item.ID)
      && item.To.some(to => to.Address === email));
    return Boolean(message);
  }, { timeout: 85000 }).toBe(true);
  const content = await (await page.request.get(`${mailpit}/api/v1/message/${message.ID}`)).json();
  await page.getByLabel('Código de verificación').fill(content.Text.match(/\b\d{6}\b/)[0]);
  await page.getByRole('button', { name: 'Confirmar código' }).click();

  await page.locator('.sidebar').getByRole('button', { name: 'Calendario', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Calendario de la junta' });
  await expect(panel.locator('.calendar-grid')).toBeVisible();

  let fail = true;
  await page.route('**/api/v1/calendar-events?*', async route => {
    if (fail) {
      fail = false;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Servicio temporalmente no disponible.' } }) });
    } else await route.continue();
  });
  await panel.getByRole('button', { name: 'Actualizar calendario' }).click();
  await expect(panel.locator('.error')).toContainText('Servicio temporalmente no disponible.');
  await expect(panel.locator('.calendar-grid')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Actualizar calendario' }).click();
  await expect(panel.locator('.calendar-grid')).toBeVisible();
  await expect(panel.locator('.error')).toHaveCount(0);
  await page.unroute('**/api/v1/calendar-events?*');

  await page.route('**/api/v1/calendar-events?*', async route => {
    await new Promise(resolve => setTimeout(resolve, 20000));
    await route.abort().catch(() => {});
  });
  await panel.getByRole('button', { name: 'Actualizar calendario' }).click();
  await expect(panel.locator('.error')).toContainText('La conexión tardó demasiado.', { timeout: 19000 });
  await expect(panel.locator('.calendar-grid')).toHaveCount(0);
  await page.unroute('**/api/v1/calendar-events?*');
  await panel.getByRole('button', { name: 'Actualizar calendario' }).click();
  await expect(panel.locator('.calendar-grid')).toBeVisible();
  await expect(panel.locator('.error')).toHaveCount(0);
});
