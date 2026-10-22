import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const fixture = JSON.parse(readFileSync(process.env.SRD_BROWSER_FIXTURE, 'utf8'));
const mailpit = process.env.SRD_MAILPIT_URL || 'http://localhost:8025';

test('a stalled save leaves the form editable and warns that the result is uncertain', async ({ page }) => {
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
    message = list.messages?.find(item => !oldIds.has(item.ID)
      && item.To.some(to => to.Address === email));
    return Boolean(message);
  }, { timeout: 85000 }).toBe(true);
  const content = await (await page.request.get(`${mailpit}/api/v1/message/${message.ID}`)).json();
  await page.getByLabel('Código de verificación').fill(content.Text.match(/\b\d{6}\b/)[0]);
  await page.getByRole('button', { name: 'Confirmar código' }).click();

  await page.locator('.sidebar').getByRole('button', { name: 'Carpeta', exact: true }).click();
  await page.getByRole('button', { name: 'Nueva carpeta', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Nueva carpeta' });
  await dialog.getByLabel('Nombre de carpeta (ES)').fill('Prueba de espera');
  await dialog.getByLabel('Nombre de carpeta (EN)').fill('Timeout test');
  await page.route('**/api/v1/folders', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    await new Promise(resolve => setTimeout(resolve, 31000));
    await route.abort().catch(() => {});
  });
  await dialog.getByRole('button', { name: 'Guardar carpeta' }).click();
  await expect(dialog.getByRole('alert')).toContainText('No se pudo confirmar la operación. Recarga para comprobar su estado.', { timeout: 34000 });
  await expect(dialog.getByRole('button', { name: 'Guardar carpeta' })).toBeEnabled();
  await expect(dialog.getByLabel('Nombre de carpeta (ES)')).toHaveValue('Prueba de espera');
  await page.unroute('**/api/v1/folders');
  const result = await (await page.request.get('/api/v1/folders')).json();
  expect(result.data.total).toBe(0);
});
