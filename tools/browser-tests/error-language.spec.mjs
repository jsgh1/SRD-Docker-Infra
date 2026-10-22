import { test, expect } from '@playwright/test';
import fs from 'node:fs';

const fixture = JSON.parse(fs.readFileSync(process.env.SRD_BROWSER_FIXTURE));
const mailUrl = process.env.SRD_MAILPIT_URL || 'http://localhost:8025';

test('API errors and field validation follow the saved language', async ({ page }) => {
  await page.goto(`/j/${fixture.codeA}/login`);
  await page.getByLabel('Correo electrónico', { exact: true }).fill(fixture.users.treasurer.email);
  await page.getByLabel('Contraseña', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: 'términos y condiciones' }).click();
  await page.getByRole('button', { name: 'Aceptar términos' }).click();
  await page.getByRole('button', { name: 'Ingresar', exact: true }).click();
  let message;
  await expect.poll(async () => {
    const list = await (await page.request.get(`${mailUrl}/api/v1/messages`)).json();
    message = list.messages?.find(item => item.Subject === 'Tu código de seguridad de SRD' && item.To.some(to => to.Address === fixture.users.treasurer.email));
    return Boolean(message);
  }, { timeout: 85000 }).toBe(true);
  const content = await (await page.request.get(`${mailUrl}/api/v1/message/${message.ID}`)).json();
  await page.getByLabel('Código de verificación').fill(content.Text.match(/\b\d{6}\b/)[0]);
  await page.getByRole('button', { name: 'Confirmar código' }).click();
  await expect(page.locator('.sidebar').getByRole('button', { name: 'Home', exact: true })).toBeVisible();

  await page.locator('.profile-trigger').click();
  await page.getByLabel('Idioma', { exact: true }).selectOption('en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  let serverMessage = 'Revisa los datos del formulario.';
  await page.route('**/api/v1/assets?*', route => route.fulfill({
    status: 422,
    contentType: 'application/json',
    body: JSON.stringify({ error: {
      message: serverMessage,
      fields: { name: ['El nombre contiene un valor no permitido.'] },
    } }),
  }));
  await page.locator('.sidebar').getByRole('button', { name: 'Inventory', exact: true }).click();
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('Check the form fields.');
  await expect(alert).toContainText('Check this field.');
  await expect(alert).not.toContainText('Revisa');
  await page.locator('.profile-trigger').click();
  await page.getByLabel('Language', { exact: true }).selectOption('es');
  await expect(alert).toContainText('Revisa los datos del formulario.');
  await expect(alert).toContainText('El nombre contiene un valor no permitido.');
  await page.getByLabel('Idioma', { exact: true }).selectOption('en');
  serverMessage = 'The export format is invalid.';
  await page.locator('.profile-trigger').click();
  await page.getByRole('region', { name: 'Inventory assets' }).getByRole('button', { name: 'Refresh' }).click();
  await expect(alert).toContainText('The export format is invalid.');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});
