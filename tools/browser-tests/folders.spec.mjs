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

test('folders persist hierarchy and rename through gateway with MySQL and audit', async ({ page }) => {
  test.setTimeout(240000);
  await login(page);
  await page.getByRole('button', { name: 'Carpeta', exact: true }).click();
  await expect(page.getByText('No hay carpetas en esta ubicación')).toBeVisible();
  await page.getByRole('button', { name: 'Nueva carpeta', exact: true }).click();
  await page.getByLabel('Nombre de carpeta (ES)').fill('Actas de prueba');
  await page.getByLabel('Nombre de carpeta (EN)').fill('Test minutes');
  await page.getByRole('button', { name: 'Guardar carpeta', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Actas de prueba', exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Carpeta', exact: true }).click();
  await page.getByRole('button', { name: 'Actas de prueba', exact: true }).click();
  await expect(page.getByText('No hay carpetas en esta ubicación')).toBeVisible();
  await page.getByRole('button', { name: 'Nueva carpeta', exact: true }).click();
  await page.getByLabel('Nombre de carpeta (ES)').fill('Septiembre');
  await page.getByLabel('Nombre de carpeta (EN)').fill('September');
  await page.getByRole('button', { name: 'Guardar carpeta', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Septiembre', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Renombrar Septiembre', exact: true }).click();
  await page.getByLabel('Nombre de carpeta (ES)').fill('Septiembre 2026');
  await page.getByLabel('Nombre de carpeta (EN)').fill('September 2026');
  await page.getByRole('button', { name: 'Guardar carpeta', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Septiembre 2026', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Nueva carpeta', exact: true }).click();
  await page.getByLabel('Nombre de carpeta (ES)').fill('septiembre 2026');
  await page.getByLabel('Nombre de carpeta (EN)').fill('September 2026 duplicate');
  await page.getByRole('button', { name: 'Guardar carpeta', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Nueva carpeta' }).getByRole('alert')).toContainText('El recurso cambió o ya existe');
  await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
  const data = await (await page.request.get('/api/v1/folders')).json();
  expect(data.data.total).toBe(1);
  const root = data.data.items[0];
  const children = await (await page.request.get(`/api/v1/folders?parent_id=${root.id}`)).json();
  expect(children.data.items[0].name).toBe('Septiembre 2026');
  expect(children.data.items[0].version).toBe(2);
  await expect.poll(async () => {
    const result = await (await page.request.get('/api/v1/audit-events?service=files&action=folder.renamed')).json();
    return result.data.items.some(item => item.resource_id === children.data.items[0].id);
  }, { timeout: 85000, intervals: [2000, 5000] }).toBe(true);
  await page.setViewportSize({ width: 360, height: 800 });
  await expect(page.getByRole('button', { name: 'Septiembre 2026', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.local/folders-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('navigation', { name: 'Ruta de carpetas' }).getByRole('button', { name: 'Inicio', exact: true }).click();
  await page.getByRole('button', { name: 'Nueva carpeta', exact: true }).click();
  await page.getByLabel('Nombre de carpeta (ES)').fill('Archivo de prueba');
  await page.getByLabel('Nombre de carpeta (EN)').fill('Test archive');
  await page.getByRole('button', { name: 'Guardar carpeta', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Archivo de prueba', exact: true })).toBeVisible();
  const roots = await (await page.request.get('/api/v1/folders')).json();
  const target = roots.data.items.find(item => item.name === 'Archivo de prueba');
  const token = (await (await page.request.get('/api/v1/csrf')).json()).data.token;
  const child = children.data.items[0];
  const cycle = await page.request.post(`/api/v1/folders/${root.id}/move`, {
    headers: { 'X-CSRF-TOKEN': token }, data: { parent_id: child.id, version: root.version },
  });
  expect(cycle.status()).toBe(422);
  await page.getByRole('button', { name: 'Actas de prueba', exact: true }).click();
  await page.getByRole('button', { name: 'Mover Septiembre 2026', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Mover carpeta: Septiembre 2026' });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await page.getByRole('button', { name: 'Mover Septiembre 2026', exact: true }).click();
  await dialog.getByRole('button', { name: 'Abrir destino Archivo de prueba', exact: true }).click();
  await expect(dialog.getByText('Destino: Archivo de prueba', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 360, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.local/folder-move-mobile.png', fullPage: true });
  let release, received;
  const gate = new Promise(resolve => { release = resolve; });
  const responseReceived = new Promise(resolve => { received = resolve; });
  const moveUrl = `**/api/v1/folders/${child.id}/move`;
  await page.route(moveUrl, async route => {
    const response = await route.fetch();
    received(); await gate;
    await route.fulfill({ response });
  });
  await dialog.getByRole('button', { name: 'Mover a esta ubicación', exact: true }).click();
  await responseReceived;
  try {
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Moviendo…', exact: true })).toBeDisabled();
  } finally { release(); }
  await expect(page.getByText('No hay carpetas en esta ubicación', { exact: true })).toBeVisible();
  await page.unroute(moveUrl);
  const moved = await (await page.request.get(`/api/v1/folders?parent_id=${target.id}`)).json();
  expect(moved.data.items[0].id).toBe(child.id);
  expect(moved.data.items[0].version).toBe(3);
  const stale = await page.request.post(`/api/v1/folders/${child.id}/move`, {
    headers: { 'X-CSRF-TOKEN': token }, data: { parent_id: root.id, version: 2 },
  });
  expect(stale.status()).toBe(409);
  await expect.poll(async () => {
    const result = await (await page.request.get('/api/v1/audit-events?service=files&action=folder.moved')).json();
    return result.data.items.some(item => item.resource_id === child.id);
  }, { timeout: 85000, intervals: [2000, 5000] }).toBe(true);
  // Removing the only item on page two must return to the last valid page.
  for (const name of [...Array.from({ length: 23 }, (_, i) => `Relleno ${String(i).padStart(2, '0')}`), 'Z Última']) {
    const response = await page.request.post('/api/v1/folders', {
      headers: { 'X-CSRF-TOKEN': token }, data: { id: crypto.randomUUID(), name, parent_id: null },
    });
    expect(response.ok()).toBe(true);
  }
  await page.getByRole('navigation', { name: 'Ruta de carpetas' }).getByRole('button', { name: 'Inicio', exact: true }).click();
  await page.getByRole('button', { name: 'Siguiente', exact: true }).click();
  await expect(page.getByText('Página 2 de 2', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Mover Z Última', exact: true }).click();
  const lastDialog = page.getByRole('dialog', { name: 'Mover carpeta: Z Última' });
  await lastDialog.getByRole('button', { name: 'Abrir destino Archivo de prueba', exact: true }).click();
  await expect(lastDialog.getByText('Destino: Archivo de prueba', { exact: true })).toBeVisible();
  await lastDialog.getByRole('button', { name: 'Mover a esta ubicación', exact: true }).click();
  await expect(page.getByText('Página 1 de 1', { exact: true })).toHaveCount(0);
  await expect(page.getByText('25 carpetas en esta ubicación.', { exact: true })).toBeVisible();
});
