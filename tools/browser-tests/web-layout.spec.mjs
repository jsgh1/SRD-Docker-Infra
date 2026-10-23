import { test, expect } from '@playwright/test';
import fs from 'node:fs';

const fixture = JSON.parse(fs.readFileSync(process.env.SRD_BROWSER_FIXTURE));
const mailUrl = process.env.SRD_MAILPIT_URL || 'http://localhost:8025';

async function login(page) {
  const email = fixture.users.admin.email;
  const before = await (await page.request.get(`${mailUrl}/api/v1/messages`)).json();
  const oldIds = new Set(before.messages?.map(message => message.ID) || []);
  await page.goto(`/j/${fixture.codeA}/login`);
  await page.getByLabel('Correo electrónico', { exact: true }).fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: 'términos y condiciones', exact: true }).click();
  await page.getByRole('button', { name: 'Aceptar términos', exact: true }).click();
  await page.getByRole('button', { name: 'Ingresar', exact: true }).click();
  let message;
  await expect.poll(async () => {
    const list = await (await page.request.get(`${mailUrl}/api/v1/messages`)).json();
    message = list.messages?.find(item => !oldIds.has(item.ID) && item.Subject === 'Tu código de seguridad de SRD'
      && item.To.some(to => to.Address === email));
    return !!message;
  }, { timeout: 85000 }).toBe(true);
  const content = await (await page.request.get(`${mailUrl}/api/v1/message/${message.ID}`)).json();
  await page.getByLabel('Código de verificación').fill(content.Text.match(/\b\d{6}\b/)[0]);
  await page.getByRole('button', { name: 'Confirmar código' }).click();
  await expect(page.getByRole('heading', { name: /Hola,/ })).toBeVisible();
}

test('secciones principales conservan el ancho y controles visibles', async ({ page }, testInfo) => {
  test.setTimeout(180000);
  await login(page);
  const destinations = [
    ['Carpeta', 'Carpeta'], ['Lista', 'Lista de personas'],
    ['Configuración', 'Configuración'], ['Auditoría', 'Auditoría'],
  ];
  for (const width of [1366, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [link, heading] of destinations) {
      if (width <= 650) await page.getByRole('button', { name: 'Abrir menú' }).click();
      await page.locator('.sidebar').getByRole('button', { name: link, exact: true }).click();
      await expect(page.getByRole('heading', { name: heading, exact: true }).first()).toBeVisible();
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
      await expect(page.locator('.workspace .loading')).toHaveCount(0, { timeout: 20000 });
      await page.screenshot({ path: testInfo.outputPath(`${link}-${width}.png`), fullPage: true });
      const size = await page.evaluate(() => ({ screen: innerWidth, document: document.documentElement.scrollWidth }));
      expect(size.document, `${link} a ${width}px: ${JSON.stringify(size)}`).toBeLessThanOrEqual(size.screen + 2);
      if (link === 'Lista') {
        const checkbox = page.getByRole('region', { name: 'Planilla de firmas' }).getByLabel('Correo electrónico', { exact: true });
        const bounds = await checkbox.boundingBox();
        expect(bounds?.width, `Casilla de planilla a ${width}px`).toBeLessThanOrEqual(22);
      }
      if (link === 'Auditoría' && width === 390) {
        const cards = page.locator('.delivery-grid .delivery-card');
        const first = await cards.nth(0).boundingBox();
        const second = await cards.nth(1).boundingBox();
        expect(first?.y).toBe(second?.y);
        expect(second?.x).toBeGreaterThan((first?.x ?? 0) + (first?.width ?? 0));
      }
    }
  }
  for (const link of ['Home', 'Registro', 'Consultar', 'Contactos', 'Chat', 'Calendario', 'Tesorería', 'Inventario', 'Exportar', 'Descargas']) {
    await page.getByRole('button', { name: 'Abrir menú' }).click();
    await page.locator('.sidebar').getByRole('button', { name: link, exact: true }).click();
    await expect(page.locator('.workspace h1').first()).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    await expect(page.locator('.workspace .loading')).toHaveCount(0, { timeout: 20000 });
    if (link === 'Chat') await expect(page.locator('.chat-thread')).toBeHidden();
    await page.screenshot({ path: testInfo.outputPath(`${link}-390.png`), fullPage: true });
    const size = await page.evaluate(() => ({ screen: innerWidth, document: document.documentElement.scrollWidth }));
    expect(size.document, `${link} a 390px: ${JSON.stringify(size)}`).toBeLessThanOrEqual(size.screen + 2);
  }
  await page.evaluate(() => {
    window.__confirmResult = undefined;
    window.dispatchEvent(new CustomEvent('srd-confirm-action', {
      detail: { message: 'Verificación de confirmación integrada', resolve: accepted => { window.__confirmResult = accepted; } },
    }));
  });
  const confirmation = page.getByRole('dialog', { name: 'Confirmar acción' });
  await expect(confirmation).toContainText('Verificación de confirmación integrada');
  await confirmation.getByRole('button', { name: 'Cancelar' }).click();
  expect(await page.evaluate(() => window.__confirmResult)).toBe(false);

  await page.getByRole('button', { name: 'Abrir menú' }).click();
  await page.locator('.sidebar').getByRole('button', { name: 'Carpeta', exact: true }).click();
  await page.getByRole('button', { name: 'Nueva carpeta' }).click();
  const editor = page.getByRole('dialog', { name: 'Nueva carpeta' });
  await editor.getByRole('button', { name: 'Guardar carpeta' }).click();
  expect(await editor.getByLabel('Nombre de carpeta (ES)').evaluate(input => input.validity.valueMissing)).toBe(true);
  const name = `Revisión visual ${Date.now()}`;
  await editor.getByLabel('Nombre de carpeta (ES)').fill(name);
  await editor.getByLabel('Nombre de carpeta (EN)').fill(`Visual review ${Date.now()}`);
  await editor.getByRole('button', { name: 'Guardar carpeta' }).click();
  const card = page.locator('.folder-card').filter({ hasText: name });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: `Eliminar carpeta ${name}` }).click();
  const remove = page.getByRole('dialog', { name: `Eliminar carpeta: ${name}` });
  await remove.getByRole('checkbox').check();
  await remove.getByRole('button', { name: 'Sí, eliminar' }).click();
  await expect(card).toHaveCount(0);
});
