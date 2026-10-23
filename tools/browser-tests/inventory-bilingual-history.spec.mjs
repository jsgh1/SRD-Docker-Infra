import { test, expect } from '@playwright/test';
import fs from 'node:fs';

const fixture = JSON.parse(fs.readFileSync(process.env.SRD_BROWSER_FIXTURE));
const mailUrl = process.env.SRD_MAILPIT_URL || 'http://localhost:8025';

test('inventory history Excel uses the juntas saved English text', async ({ page }) => {
  test.setTimeout(180000);
  await page.goto(`/j/${fixture.codeA}/login`);
  await page.getByLabel('Correo electrónico', { exact: true }).fill(fixture.users.admin.email);
  await page.getByLabel('Contraseña', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: 'términos y condiciones', exact: true }).click();
  await page.getByRole('button', { name: 'Aceptar términos', exact: true }).click();
  await page.getByRole('button', { name: 'Ingresar', exact: true }).click();
  let message;
  await expect.poll(async () => {
    const list = await (await page.request.get(`${mailUrl}/api/v1/messages`)).json();
    message = list.messages?.find(item => item.Subject === 'Tu código de seguridad de SRD' && item.To.some(to => to.Address === fixture.users.admin.email));
    return Boolean(message);
  }, { timeout: 85000 }).toBe(true);
  const content = await (await page.request.get(`${mailUrl}/api/v1/message/${message.ID}`)).json();
  await page.getByLabel('Código de verificación').fill(content.Text.match(/\b\d{6}\b/)[0]);
  await page.getByRole('button', { name: 'Confirmar código' }).click();
  await expect(page.locator('.sidebar').getByRole('button', { name: 'Home', exact: true })).toBeVisible();
  const token = (await (await page.request.get('/api/v1/csrf')).json()).data.token;
  const code = `BI-${String(Date.now()).slice(-8)}`;
  const created = await page.request.post('/api/v1/assets', { headers: { 'X-CSRF-TOKEN': token }, data: {
    code, type: 'movable', name: 'Sillas de prueba', name_en: 'Test chairs',
    category: 'Muebles', category_en: 'Furniture', unit: 'unidad', unit_en: 'chair',
    location: 'Salón', location_en: 'Hall', condition: 'Bueno', condition_en: 'Good',
    quantity: 1, idempotency_key: crypto.randomUUID(),
  } });
  expect(created.status()).toBe(200);
  const id = (await created.json()).data.asset.id;
  const movement = await page.request.post(`/api/v1/assets/${id}/movements`, { headers: { 'X-CSRF-TOKEN': token }, data: {
    type: 'out', quantity: 1, reason: 'Entrega para evento', reason_en: 'Delivery for event',
    idempotency_key: crypto.randomUUID(),
  } });
  expect(movement.status()).toBe(200);
  await page.locator('.profile-trigger').click();
  await page.getByLabel('Idioma', { exact: true }).selectOption('en');
  await page.locator('.sidebar').getByRole('button', { name: 'Inventory', exact: true }).click();
  await page.getByLabel('Search by code or name').fill(code);
  await page.getByRole('row').filter({ hasText: code }).getByRole('button', { name: 'View asset' }).click();
  const dialog = page.getByRole('dialog', { name: `${code} · Test chairs` });
  await expect(dialog.getByText('Delivery for event')).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Export history to Excel' }).click();
  const download = await downloadPromise;
  const xml = fs.readFileSync(await download.path()).toString('utf8');
  expect(xml).toContain('Previous quantity');
  expect(xml).toContain('Stock out');
  expect(xml).toContain('Test chairs');
  expect(xml).toContain('Delivery for event');
  expect(xml).toContain('Initial record');
  expect(xml).not.toContain('Entrega para evento');
  expect(xml).not.toContain('Existencia anterior');
});
