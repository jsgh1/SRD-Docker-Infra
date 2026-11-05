import { test, expect } from '@playwright/test';
import fs from 'node:fs';

const fixture = JSON.parse(fs.readFileSync(process.env.SRD_BROWSER_FIXTURE));
const mailUrl = process.env.SRD_MAILPIT_URL || 'http://localhost:8025';

async function login(page) {
  await page.goto(`/j/${fixture.codeA}/login`);
  await page.getByLabel('Correo electrónico', { exact: true }).fill(fixture.users.admin.email);
  await page.getByLabel('Contraseña', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: 'términos y condiciones', exact: true }).click();
  await page.getByRole('button', { name: 'Aceptar términos', exact: true }).click();
  await page.getByRole('button', { name: 'Ingresar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ingresa tu código' })).toBeVisible();
  let message;
  await expect.poll(async () => {
    const list = await (await page.request.get(`${mailUrl}/api/v1/messages`)).json();
    message = list.messages?.find(item => item.Subject === 'Tu código de seguridad de SRD' && item.To.some(to => to.Address === fixture.users.admin.email));
    return !!message;
  }, { timeout: 85000 }).toBe(true);
  const content = await (await page.request.get(`${mailUrl}/api/v1/message/${message.ID}`)).json();
  await page.getByLabel('Código de verificación').fill(content.Text.match(/\b\d{6}\b/)[0]);
  await page.getByRole('button', { name: 'Confirmar código' }).click();
  await expect(page.locator('.sidebar').getByRole('button', { name: 'Home', exact: true })).toBeVisible();
}

test('inventory history filters preserve stock and pagination; search keeps older movements', async ({ page }) => {
  test.setTimeout(240000);
  await login(page);
  const marker = String(Date.now()).slice(-8);
  const code = `HIST-${marker}`;
  const token = (await (await page.request.get('/api/v1/csrf')).json()).data.token;
  const created = await page.request.post('/api/v1/assets', { headers: { 'X-CSRF-TOKEN': token }, data: {
    code, type: 'movable', name: `Bien histórico ${marker}`, category: 'Prueba', unit: 'unidad',
    location: 'Sede de prueba', condition: 'Bueno', quantity: 0, idempotency_key: crypto.randomUUID(),
  } });
  expect(created.status()).toBe(200);
  const id = (await created.json()).data.asset.id;
  for (let i = 1; i <= 26; i++) {
    const response = await page.request.post(`/api/v1/assets/${id}/movements`, { headers: { 'X-CSRF-TOKEN': token }, data: {
      type: 'in', quantity: 1, reason: `Entrada de prueba ${i} 50%_!`, idempotency_key: crypto.randomUUID(),
    } });
    expect(response.status()).toBe(200);
  }
  await page.locator('.sidebar').getByRole('button', { name: 'Inventario' }).click();
  await page.getByLabel('Buscar por código o nombre').fill(code);
  await page.getByRole('row').filter({ hasText: code }).getByRole('button', { name: 'Ver bien' }).click();
  let dialog = page.getByRole('dialog', { name: new RegExp(code) });
  await expect(dialog.getByText('27 movimientos')).toBeVisible();
  await expect(dialog.getByRole('row').filter({ hasText: 'Entrada de prueba 26' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Movimientos más antiguos' }).click();
  await expect(dialog.getByText('Página 2')).toBeVisible();
  await expect(dialog.getByRole('row').filter({ hasText: 'Registro inicial' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Movimientos más recientes' }).click();
  await expect(dialog.getByText('Página 1')).toBeVisible();
  const filters = dialog.getByRole('form', { name: 'Filtros del historial de inventario' });
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  await filters.getByLabel('Operación del historial').selectOption('in');
  await filters.getByLabel('Motivo del movimiento').fill('50%_!');
  await filters.getByLabel('Movimientos desde').fill(today);
  await filters.getByLabel('Movimientos hasta').fill(today);
  await filters.getByRole('button', { name: 'Aplicar filtros' }).click();
  await expect(dialog.getByText('26 movimientos coincidentes', { exact: true })).toBeVisible();
  await filters.getByLabel('Motivo del movimiento').fill('sin coincidencia');
  await dialog.getByRole('button', { name: 'Movimientos más antiguos' }).click();
  await expect(dialog.getByText('Página 2')).toBeVisible();
  await expect(dialog.getByRole('row').filter({ hasText: 'Entrada de prueba 1 50%_!' })).toBeVisible();
  await expect(dialog.getByRole('row').filter({ hasText: 'Registro inicial' })).toHaveCount(0);
  await expect(dialog.getByText('26 movimientos coincidentes', { exact: true })).toBeVisible();
  await filters.getByRole('button', { name: 'Aplicar filtros' }).click();
  await expect(dialog.getByText('0 movimientos coincidentes', { exact: true })).toBeVisible();
  await expect(dialog.getByText('No hay movimientos que coincidan con los filtros aplicados.')).toBeVisible();
  await expect(dialog.getByText('26 unidad', { exact: true })).toBeVisible();
  await filters.getByRole('button', { name: 'Limpiar filtros' }).click();
  await expect(dialog.getByText('27 movimientos coincidentes', { exact: true })).toBeVisible();
  await expect(filters.getByLabel('Motivo del movimiento')).toHaveValue('');
  await expect(filters.getByLabel('Movimientos desde')).toHaveValue('');
  await filters.scrollIntoViewIfNeeded();
  await page.screenshot({ path: '.local/inventory-history-filters-desktop.png' });
  await page.setViewportSize({ width: 360, height: 800 });
  await filters.scrollIntoViewIfNeeded();
  for (const field of ['Operación del historial', 'Motivo del movimiento', 'Movimientos desde', 'Movimientos hasta']) {
    const bounds = await filters.getByLabel(field).boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(360);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: '.local/inventory-history-filters-mobile.png' });
  await page.setViewportSize({ width: 1280, height: 720 });
  await dialog.getByRole('button', { name: 'Cerrar' }).click();

  await page.getByRole('button', { name: 'Buscar en la junta', exact: true }).click();
  const form = page.getByRole('form', { name: 'Búsqueda de la junta' });
  await form.getByLabel('Buscar en').selectOption('assets');
  await form.getByLabel('Texto de búsqueda').fill(code);
  await form.getByRole('button', { name: 'Buscar', exact: true }).click();
  const results = page.getByRole('region', { name: 'Resultados de bienes' });
  await results.getByRole('button', { name: `Ver bien ${code}` }).click();
  dialog = page.getByRole('dialog', { name: new RegExp(code) });
  await expect(dialog.getByText('27 movimientos')).toBeVisible();
  await dialog.getByRole('button', { name: 'Movimientos más antiguos' }).click();
  await expect(dialog.getByText('Página 2')).toBeVisible();
  await expect(dialog.getByRole('row').filter({ hasText: 'Registro inicial' })).toBeVisible();
  await page.setViewportSize({ width: 360, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});
