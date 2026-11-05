import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const fixture = JSON.parse(fs.readFileSync(path.join(root, '.local/e2e-fixture.json'), 'utf8'));
const mailUrl = process.env.SRD_MAILPIT_URL || 'http://localhost:8025';

test('todas las secciones de la junta de demostración con datos reales', async ({ page }, testInfo) => {
  test.setTimeout(240000);
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

  const nav = page.locator('.sidebar nav');
  const sections = (await nav.locator('button').allTextContents()).map(value => value.trim()).filter(Boolean);
  expect(sections.length).toBeGreaterThan(10);
  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [index, section] of sections.entries()) {
      if (width <= 650) await page.getByRole('button', { name: /^(Abrir menú|Open menu)$/ }).click();
      await nav.getByRole('button', { name: section, exact: true }).click();
      await expect(page.locator('.workspace .loading')).toHaveCount(0, { timeout: 30000 });
      await expect(page.locator('.workspace .error'), `${section} a ${width}px`).toHaveCount(0);
      const documentWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(documentWidth, `${section} a ${width}px`).toBeLessThanOrEqual(width + 2);
      const unnamedButtons = await page.locator('main button').evaluateAll(buttons => buttons.filter(button => {
        const box = button.getBoundingClientRect();
        if (!box.width || !box.height || getComputedStyle(button).visibility === 'hidden') return false;
        return !button.textContent?.trim() && !button.getAttribute('aria-label')?.trim()
          && !button.getAttribute('aria-labelledby') && !button.getAttribute('title')?.trim();
      }).map(button => button.outerHTML.slice(0, 170)));
      expect(unnamedButtons, `${section} a ${width}px: botones sin nombre`).toEqual([]);
      const tinyIconButtons = await page.locator('main button').evaluateAll(buttons => buttons.filter(button => {
        const box = button.getBoundingClientRect();
        if (!box.width || !box.height || getComputedStyle(button).visibility === 'hidden') return false;
        return !button.textContent?.trim() && (box.width < 28 || box.height < 28);
      }).map(button => ({ width: Math.round(button.getBoundingClientRect().width),
        height: Math.round(button.getBoundingClientRect().height), label: button.getAttribute('aria-label') })));
      expect(tinyIconButtons, `${section} a ${width}px: controles de icono menores a 28px`).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath(`${String(index + 1).padStart(2, '0')}-${section}-${width}.png`),
        fullPage: width <= 650, animations: 'disabled' });
      if (width === 320 && ['Treasury', 'Tesorería', 'Inventory', 'Inventario'].includes(section)) {
        await expect(page.locator('.record-desktop-table')).toBeHidden();
        const cards = page.locator('.record-mobile-card');
        await expect(cards.first()).toBeVisible();
        await cards.first().locator('button').click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await page.getByRole('dialog').getByRole('button', { name: /^(Cerrar|Close)$/ }).first().click();
      }
      if (width === 320 && ['Calendar', 'Calendario'].includes(section)) {
        const grid = page.locator('.calendar-grid');
        await expect(grid).toBeVisible();
        expect(await grid.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(2);
        await expect(page.locator('.calendar-weekdays strong')).toHaveCount(7);
      }
    }
  }
  expect(errors).toEqual([]);
});
