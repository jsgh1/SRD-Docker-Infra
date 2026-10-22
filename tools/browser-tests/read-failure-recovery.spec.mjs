import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const fixture = JSON.parse(readFileSync(process.env.SRD_BROWSER_FIXTURE, 'utf8'));
const mailpit = process.env.SRD_MAILPIT_URL || 'http://localhost:8025';

test('failed reads remove stale finance and inventory data, then retry successfully', async ({ page }) => {
  test.setTimeout(180000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const email = fixture.users.treasurer.email;
  const old = await (await page.request.get(`${mailpit}/api/v1/messages`)).json();
  const oldIds = new Set(old.messages?.map(message => message.ID) || []);
  await page.goto(`/j/${fixture.codeA}/login`);
  await page.getByLabel('Correo electrónico', { exact: true }).fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: 'términos y condiciones', exact: true }).click();
  await page.getByRole('button', { name: 'Aceptar términos' }).click();
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

  await page.locator('.sidebar').getByRole('button', { name: 'Inventario' }).click();
  await page.getByRole('button', { name: 'Registrar bien' }).click();
  const dialog = page.getByRole('dialog', { name: 'Registrar bien' });
  await dialog.getByLabel('Código').fill('RECOVERY-E2E');
  await dialog.getByLabel('Nombre (ES)').fill('Bien de recuperación');
  await dialog.getByLabel('Nombre (EN)').fill('Recovery asset');
  await dialog.getByLabel('Categoría (ES)').fill('Equipo');
  await dialog.getByLabel('Categoría (EN)').fill('Equipment');
  await dialog.getByLabel('Ubicación (ES)').fill('Salón de prueba');
  await dialog.getByLabel('Ubicación (EN)').fill('Test hall');
  await dialog.getByLabel('Condición (ES)').fill('Bueno');
  await dialog.getByLabel('Condición (EN)').fill('Good');
  await dialog.getByLabel('Cantidad inicial').fill('2');
  await dialog.getByRole('button', { name: 'Guardar bien' }).click();
  const detail = page.getByRole('dialog', { name: 'RECOVERY-E2E · Bien de recuperación' });
  await expect(detail).toBeVisible();
  await detail.getByRole('button', { name: 'Cerrar' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const asset = page.getByRole('row').filter({ hasText: 'RECOVERY-E2E' });
  await expect(asset).toBeVisible();

  let failedAssets = false;
  await page.route('**/api/v1/assets?*', async route => {
    if (!failedAssets) {
      failedAssets = true;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Un servicio necesario no está disponible. Intenta más tarde.' } }) });
    } else await route.continue();
  });
  const inventory = page.getByRole('region', { name: 'Bienes de inventario' });
  await inventory.getByRole('button', { name: 'Actualizar' }).click();
  await expect(page.locator('main .error')).toBeVisible();
  await expect(asset).toHaveCount(0);
  await expect(page.getByText('Sin bienes')).toHaveCount(0);
  await inventory.getByRole('button', { name: 'Actualizar' }).click();
  await expect(asset).toBeVisible();
  await expect(page.locator('main .error')).toHaveCount(0);
  await page.unroute('**/api/v1/assets?*');

  await page.route('**/api/v1/assets?*', async route => {
    await new Promise(resolve => setTimeout(resolve, 20000));
    await route.abort().catch(() => {});
  });
  await inventory.getByRole('button', { name: 'Actualizar' }).click();
  await expect(page.locator('main .error')).toContainText('La conexión tardó demasiado.', { timeout: 19000 });
  await expect(asset).toHaveCount(0);
  await page.unroute('**/api/v1/assets?*');
  await inventory.getByRole('button', { name: 'Actualizar' }).click();
  await expect(asset).toBeVisible();
  await expect(page.locator('main .error')).toHaveCount(0);

  await page.locator('.sidebar').getByRole('button', { name: 'Tesorería' }).click();
  await expect(page.locator('.treasury-summary')).toBeVisible();
  let failedTreasury = false;
  await page.route('**/api/v1/treasury?*', async route => {
    if (!failedTreasury) {
      failedTreasury = true;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Un servicio necesario no está disponible. Intenta más tarde.' } }) });
    } else await route.continue();
  });
  await page.getByRole('region', { name: 'Historial de tesorería' }).getByRole('button', { name: 'Actualizar' }).click();
  await expect(page.locator('main .error')).toBeVisible();
  await expect(page.locator('.treasury-summary')).toHaveCount(0);
  await page.getByRole('button', { name: 'Reintentar tesorería' }).click();
  await expect(page.locator('.treasury-summary')).toBeVisible();
  await expect(page.locator('main .error')).toHaveCount(0);
  expect(errors).toEqual([]);
});
