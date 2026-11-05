import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

test.use({ channel: 'chrome' });

const root = path.resolve(import.meta.dirname, '../..');
const fixture = JSON.parse(readFileSync(path.join(root, '.local/e2e-fixture.json'), 'utf8'));
const account = fixture.users.superadmin;

test('real treasury and inventory render and validate their forms at mobile and desktop widths', async ({ page, request }) => {
  test.setTimeout(120000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const mailpit = process.env.SRD_MAILPIT_URL || 'http://127.0.0.1:8025';
  const inbox = async () => (await (await request.get(`${mailpit}/api/v1/messages`)).json()).messages ?? [];
  const previous = new Set((await inbox()).map(message => message.ID));
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(`/j/${fixture.codeA || 'srd-e2e-a'}/login`);
  await page.getByLabel(/^(Correo electrónico|Email address)$/).fill(account.email);
  await page.getByLabel(/^(Contraseña|Password)$/).fill(fixture.password);
  await page.getByRole('button', { name: /^(términos y condiciones|terms and conditions)$/i }).click();
  await page.getByRole('button', { name: /^(Aceptar términos|Accept terms)$/ }).click();
  await page.getByRole('button', { name: /^(Ingresar|Sign in)$/ }).click();
  let mailId;
  await expect.poll(async () => {
    mailId = (await inbox()).find(message => !previous.has(message.ID)
      && message.To.some(to => to.Address === account.email))?.ID;
    return Boolean(mailId);
  }, { timeout: 30000 }).toBe(true);
  const mail = await (await request.get(`${mailpit}/api/v1/message/${mailId}`)).json();
  const code = mail.Text.match(/\b\d{6}\b/)?.[0];
  expect(code).toMatch(/^\d{6}$/);
  await page.getByLabel(/^(Código de verificación|Verification code)$/).fill(code);
  await page.getByRole('button', { name: /^(Confirmar código|Confirm code)$/ }).click();
  await expect(page.locator('.profile-trigger')).toBeVisible();

  for (const section of [
    { button: /^(Tesorería|Treasury)$/, heading: /^(Tesorería|Treasury)$/,
      endpoint: '/api/v1/treasury', action: /^(Registrar ingreso o egreso|Record income or expense)$/ },
    { button: /^(Inventario|Inventory)$/, heading: /^(Inventario|Inventory)$/,
      endpoint: '/api/v1/assets', action: /^(Registrar bien|Register asset)$/ },
  ]) {
    await page.getByRole('button', { name: /^(Abrir menú|Open menu)$/ }).click();
    await page.locator('.sidebar').getByRole('button', { name: section.button }).click();
    await expect(page.getByRole('heading', { name: section.heading, level: 1 })).toBeVisible();
    const response = await page.request.get(section.endpoint);
    expect(response.ok(), `${section.endpoint}: ${response.status()}`).toBe(true);
    await expect(page.getByRole('button', { name: section.action })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.locator('main .error').count()).toBe(0);
    if (section.endpoint === '/api/v1/treasury') {
      let writes = 0;
      page.on('request', submitted => {
        if (submitted.method() === 'POST' && new URL(submitted.url()).pathname === '/api/v1/treasury/movements') writes++;
      });
      await page.getByRole('button', { name: section.action }).click();
      const dialog = page.getByRole('dialog', { name: /^(Registrar movimiento|Record transaction)$/ });
      await dialog.getByLabel(/^(Importe COP|Amount COP)$/).fill('0.00');
      await dialog.getByLabel(/^(Concepto|Concept)$/).fill('Validación de importe');
      await dialog.getByRole('button', { name: /^(Guardar y generar comprobante|Save and create receipt)$/ }).click();
      await expect(dialog.getByRole('alert')).toContainText(/^(El importe debe ser mayor que cero\.|Amount must be greater than zero\.)$/);
      expect(writes).toBe(0);
      await dialog.getByLabel(/^(Importe COP|Amount COP)$/).fill('1.25');
      await expect(dialog.getByRole('alert')).toHaveCount(0);
      await dialog.getByRole('button', { name: /^(Cerrar|Close)$/ }).click();
    } else {
      await page.getByRole('button', { name: section.action }).click();
      const dialog = page.getByRole('dialog', { name: section.action });
      const nameEs = dialog.getByLabel(/^(Nombre|Name) \(ES\)$/);
      const nameEn = dialog.getByLabel(/^(Nombre|Name) \(EN\)$/);
      await expect(nameEs).toBeVisible();
      await expect(nameEn).toBeVisible();
      expect(await nameEs.getAttribute('required')).not.toBeNull();
      expect(await nameEn.getAttribute('required')).not.toBeNull();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await dialog.getByRole('button', { name: /^(Cerrar|Close)$/ }).click();
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.setViewportSize({ width: 360, height: 800 });
  }
  expect(errors).toEqual([]);
});
