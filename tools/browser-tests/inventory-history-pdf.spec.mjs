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

test('inventory movement PDF uses applied filters and preserves history', async ({ page }) => {
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
      type: 'in', quantity: 1, reason: i === 26 ? `Entrada de prueba ${i} 50%_!`.padEnd(500, 'X') : `Entrada de prueba ${i} 50%_!`, idempotency_key: crypto.randomUUID(),
    } });
    expect(response.status()).toBe(200);
  }
  try {
    await page.locator('.sidebar').getByRole('button', { name: 'Inventario', exact: true }).click();
    await page.getByLabel('Buscar por código o nombre').fill(code);
    await page.getByRole('row').filter({ hasText: code }).getByRole('button', { name: 'Ver bien' }).click();
    const dialog = page.getByRole('dialog', { name: new RegExp(code) });
    const filters = dialog.getByRole('form', { name: 'Filtros del historial de inventario' });
    await expect(dialog.getByText('27 movimientos coincidentes', { exact: true })).toBeVisible();
    await filters.getByLabel('Operación del historial').selectOption('in');
    await filters.getByLabel('Motivo del movimiento').fill('50%_!');
    await filters.getByRole('button', { name: 'Aplicar filtros' }).click();
    await expect(dialog.getByText('26 movimientos coincidentes', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Movimientos más antiguos' }).click();
    await expect(dialog.getByText('Página 2')).toBeVisible();
    await filters.getByLabel('Motivo del movimiento').fill('borrador sin coincidencias');
    const button = dialog.getByRole('button', { name: 'Exportar historial PDF', exact: true });
    await dialog.getByLabel('Nombre del archivo (opcional)').fill('../Historia?.xlsx');
    await expect(button).toBeDisabled();
    await dialog.getByLabel('Confirmo el nombre del archivo').check();
    await expect(button).toBeEnabled();
    const responsePromise = page.waitForResponse(response => response.url().includes(`/assets/${id}/movements/export-pdf`));
    const downloadPromise = page.waitForEvent('download');
    await button.click();
    const response = await responsePromise;
    expect(response.status()).toBe(200);
    expect(new URL(response.url()).searchParams.get('movement_q')).toBe('50%_!');
    expect(new URL(response.url()).searchParams.has('movement_page')).toBe(false);
    expect((await response.json()).data.count).toBe(26);
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('Historia.pdf');
    await download.saveAs('.local/inventory-history-download.pdf');
    const bytes = fs.readFileSync('.local/inventory-history-download.pdf');
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    const data = (await response.json()).data;
    expect(data.headers).toHaveLength(11);
    expect(data.rows).toHaveLength(26);
    expect(data.rows[0][8]).toBe('Entrada de prueba 26 50%_!'.padEnd(500, 'X'));
    expect(data.rows[25][8]).toBe('Entrada de prueba 1 50%_!');
    await page.setViewportSize({ width: 360, height: 800 });
    await button.scrollIntoViewIfNeeded();
    const bounds = await button.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(360);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await page.screenshot({ path: '.local/inventory-history-pdf-mobile.png' });
    const current = (await (await page.request.get(`/api/v1/assets/${id}`)).json()).data;
    expect(current.asset.quantity).toBe(26);
    expect(current.asset.version).toBe(27);
    expect(current.movement_total).toBe(27);
    await filters.getByRole('button', { name: 'Aplicar filtros' }).click();
    await expect(dialog.getByText('0 movimientos coincidentes', { exact: true })).toBeVisible();
    await dialog.getByLabel('Nombre del archivo (opcional)').fill('');
    const emptyDownloadPromise = page.waitForEvent('download');
    await button.click();
    const emptyDownload = await emptyDownloadPromise;
    expect(emptyDownload.suggestedFilename()).toMatch(/^movimientos_inventario_\d{4}-\d{2}-\d{2}\.pdf$/);
    await emptyDownload.saveAs('.local/inventory-history-empty.pdf');
    expect(fs.readFileSync('.local/inventory-history-empty.pdf').subarray(0, 5).toString()).toBe('%PDF-');
    let release, requested;
    const gate = new Promise(resolve => { release = resolve; });
    const captured = new Promise(resolve => { requested = resolve; });
    const matcher = new RegExp(`/api/v1/assets/${id}/movements/export-pdf\\?`);
    await page.route(matcher, async route => { requested(); await gate; await route.continue(); });
    let lateDownloads = 0;
    const countDownload = () => { lateDownloads++; };
    page.on('download', countDownload);
    const lateResponse = page.waitForResponse(response => matcher.test(response.url()));
    await button.click();
    await captured;
    await dialog.getByRole('button', { name: 'Cerrar', exact: true }).click();
    release();
    expect((await lateResponse).status()).toBe(200);
    await page.waitForLoadState('networkidle');
    expect(lateDownloads).toBe(0);
    page.off('download', countDownload);
    await page.unroute(matcher);
  } finally {
    const out = await page.request.post(`/api/v1/assets/${id}/movements`, { headers: { 'X-CSRF-TOKEN': token }, data: {
      type: 'out', quantity: 26, reason: 'Cierre de prueba sintética de exportación', idempotency_key: crypto.randomUUID(),
    } });
    expect(out.status()).toBe(200);
    const version = (await out.json()).data.asset.version;
    const retired = await page.request.post(`/api/v1/assets/${id}/retire`, { headers: { 'X-CSRF-TOKEN': token }, data: {
      version, reason: 'Cierre de prueba sintética de exportación', idempotency_key: crypto.randomUUID(),
    } });
    expect(retired.status()).toBe(200);
    const history = await page.request.get(`/api/v1/assets/${id}`);
    expect(history.status()).toBe(200);
    expect((await history.json()).data.movement_total).toBe(29);
  }
});
