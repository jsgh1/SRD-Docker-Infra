import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const fixture = JSON.parse(readFileSync(process.env.SRD_BROWSER_FIXTURE, 'utf8'));
const mailpit = process.env.SRD_MAILPIT_URL || 'http://localhost:8025';

test('chat conversation list recovers from a failed and stalled read', async ({ page }) => {
  test.setTimeout(115000);
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

  let fail = true;
  await page.route('**/api/v1/conversations?page=*', async route => {
    if (fail) {
      fail = false;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Chat no disponible.' } }) });
    } else await route.continue();
  });
  await page.locator('.sidebar').getByRole('button', { name: 'Chat', exact: true }).click();
  const sidebar = page.getByRole('region', { name: 'Conversaciones' });
  await expect(page.locator('.error')).toContainText('Chat no disponible.');
  await expect(sidebar.getByRole('button', { name: 'Reintentar conversaciones' })).toBeVisible();
  await expect(sidebar).not.toContainText('Sin conversaciones');
  await sidebar.getByRole('button', { name: 'Reintentar conversaciones' }).click();
  await expect(sidebar.getByRole('button', { name: 'Reintentar conversaciones' })).toHaveCount(0);
  await expect(page.locator('.error')).toHaveCount(0);
  await page.unroute('**/api/v1/conversations?page=*');

  await page.route('**/api/v1/conversations?page=*', async route => {
    await new Promise(resolve => setTimeout(resolve, 31000));
    await route.abort().catch(() => {});
  });
  await page.evaluate(() => document.dispatchEvent(new Event('srd-chat-change')));
  await expect(page.locator('.error')).toContainText('La conexión tardó demasiado.', { timeout: 34000 });
  await expect(sidebar.getByRole('button', { name: 'Reintentar conversaciones' })).toBeVisible();
  await expect(sidebar).not.toContainText('Sin conversaciones');
  await page.unroute('**/api/v1/conversations?page=*');
  await sidebar.getByRole('button', { name: 'Reintentar conversaciones' }).click();
  await expect(sidebar.getByRole('button', { name: 'Reintentar conversaciones' })).toHaveCount(0);
  await expect(page.locator('.error')).toHaveCount(0);
});
