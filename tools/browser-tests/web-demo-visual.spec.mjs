import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const fixture = JSON.parse(fs.readFileSync(path.join(root, '.local/e2e-fixture.json')));
const mailUrl = process.env.SRD_MAILPIT_URL || 'http://localhost:8025';

test('pantallas prioritarias con datos de demostración cargados', async ({ page }, testInfo) => {
  test.setTimeout(180000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const email = fixture.users.admin.email;
  const before = await (await page.request.get(`${mailUrl}/api/v1/messages`)).json();
  const oldIds = new Set(before.messages?.map(message => message.ID) || []);
  await page.goto(`/j/${fixture.codeA || 'srd-e2e-a'}/login`);
  await page.getByLabel('Correo electrónico', { exact: true }).fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: 'términos y condiciones', exact: true }).click();
  await page.getByRole('button', { name: 'Aceptar términos', exact: true }).click();
  await page.getByRole('button', { name: 'Ingresar', exact: true }).click();
  let message;
  await expect.poll(async () => {
    const list = await (await page.request.get(`${mailUrl}/api/v1/messages`)).json();
    message = list.messages?.find(item => !oldIds.has(item.ID)
      && ['Tu código de seguridad de SRD', 'Your SRD security code'].includes(item.Subject)
      && item.To.some(to => to.Address === email));
    return !!message;
  }, { timeout: 85000 }).toBe(true);
  const content = await (await page.request.get(`${mailUrl}/api/v1/message/${message.ID}`)).json();
  await page.getByLabel('Código de verificación').fill(content.Text.match(/\b\d{6}\b/)[0]);
  await page.getByRole('button', { name: 'Confirmar código' }).click();
  await expect(page.locator('.profile-trigger')).toBeVisible();
  const english = await page.locator('.sidebar nav').getByRole('button', { name: 'Folders', exact: true }).count() > 0;

  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [section, labelEs, labelEn, headingEs, headingEn] of [
      ['Carpeta', 'Carpeta', 'Folders', 'Carpeta', 'Folders'],
      ['Lista', 'Lista', 'List', 'Lista de personas', 'People'],
      ['Configuración', 'Configuración', 'Settings', 'Configuración', 'Settings'],
      ['Auditoría', 'Auditoría', 'Audit', 'Auditoría', 'Audit']]) {
      if (width <= 650) await page.getByRole('button', { name: english ? 'Open menu' : 'Abrir menú' }).click();
      await page.locator('.sidebar nav').getByRole('button', { name: english ? labelEn : labelEs, exact: true }).click();
      await expect(page.getByRole('heading', { name: english ? headingEn : headingEs, exact: true }).first()).toBeVisible();
      await expect(page.locator('.workspace .loading')).toHaveCount(0, { timeout: 35000 });
      await expect(page.locator('.workspace .error')).toHaveCount(0);
      if (section === 'Lista') {
        if (width <= 650) {
          await expect(page.locator('.person-desktop-table')).toBeHidden();
          const cards = page.locator('.person-mobile-card');
          expect(await cards.count()).toBeGreaterThan(0);
          await expect(cards.first().getByRole('button', { name: english ? /^View / : /^Ver / })).toBeVisible();
        } else {
          await expect(page.locator('.person-mobile-list')).toBeHidden();
        }
      }
      if (section === 'Auditoría') {
        if (width <= 650) {
          await expect(page.locator('.audit-desktop-table')).toBeHidden();
          const cards = page.locator('.audit-mobile-card');
          expect(await cards.count()).toBeGreaterThan(0);
          await expect(cards.first().getByRole('button', { name: english ? /^View event / : /^Ver evento / })).toBeVisible();
        } else {
          await expect(page.locator('.audit-mobile-list')).toBeHidden();
        }
      }
      await page.screenshot({ path: testInfo.outputPath(`${section}-${width}.png`), fullPage: true, animations: 'disabled' });
      const geometry = await page.evaluate(() => ({
        viewport: innerWidth,
        document: document.documentElement.scrollWidth,
        cards: [...document.querySelectorAll('.folder-card, .delivery-card')].map(node => ({
          client: node.clientWidth, scroll: node.scrollWidth,
        })),
      }));
      expect(geometry.document, `${section} ${width}px`).toBeLessThanOrEqual(width + 2);
      for (const card of geometry.cards) expect(card.scroll, `${section} ${width}px: ${JSON.stringify(card)}`).toBeLessThanOrEqual(card.client + 2);
      if (section === 'Lista' && width <= 650) {
        await page.locator('.person-mobile-card').first().getByRole('button', { name: english ? /^View / : /^Ver / }).click();
        const detail = page.getByRole('dialog', { name: english ? 'Person details' : 'Detalle de persona' });
        await expect(detail).toBeVisible();
        await detail.getByRole('button', { name: english ? 'Close' : 'Cerrar' }).click();
      }
      if (section === 'Auditoría' && width <= 650) {
        await page.locator('.audit-mobile-card').first().getByRole('button', { name: english ? /^View event / : /^Ver evento / }).click();
        const detail = page.getByRole('dialog', { name: english ? 'Event details' : 'Detalle del evento' });
        await expect(detail).toBeVisible();
        await detail.getByRole('button', { name: english ? 'Close' : 'Cerrar' }).click();
      }
    }
  }
  expect(errors).toEqual([]);
});
