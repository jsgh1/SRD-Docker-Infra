import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const fixture = JSON.parse(readFileSync(process.env.SRD_BROWSER_FIXTURE || path.join(root, '.local/e2e-fixture.json'), 'utf8'));
const mailpit = process.env.SRD_MAILPIT_URL || 'http://127.0.0.1:8025';

async function login(page, role) {
  const inbox = async () => (await (await page.request.get(`${mailpit}/api/v1/messages`)).json()).messages ?? [];
  const previous = new Set((await inbox()).map(m => m.ID));
  await page.goto(`/j/${fixture.codeA || 'srd-e2e-a'}/login`);
  await page.getByLabel('Correo electrónico', { exact: true }).fill(fixture.users[role].email);
  await page.getByLabel('Contraseña', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: 'términos y condiciones', exact: true }).click();
  await page.getByRole('button', { name: 'Aceptar términos', exact: true }).click();
  await page.getByRole('button', { name: 'Ingresar', exact: true }).click();
  let message;
  await expect.poll(async () => {
    const list = await inbox();
    message = list.find(m => !previous.has(m.ID) && ['Tu código de seguridad de SRD', 'Your SRD security code'].includes(m.Subject)
      && m.To.some(t => t.Address === fixture.users[role].email));
    return !!message;
  }).toBe(true);
  const content = await (await page.request.get(`${mailpit}/api/v1/message/${message.ID}`)).json();
  await page.getByLabel('Código de verificación').fill(content.Text.match(/\b\d{6}\b/)[0]);
  await page.getByRole('button', { name: 'Confirmar código' }).click();
  await expect(page.locator('.profile-trigger')).toBeVisible();
}

test('superadmin saves a pending person and creates a linked viewer invitation', async ({ page }) => {
  test.setTimeout(120000);
  await login(page, 'superadmin');
  await page.locator('.sidebar').getByRole('button', { name: 'Registro', exact: true }).click();
  await page.getByRole('combobox', { name: /Tipo de documento/ }).selectOption('CC');
  await page.getByLabel('Número de documento').fill(`INV-${Date.now()}`);
  await page.getByLabel('Nombres', { exact: false }).fill('Invitada de prueba');
  await page.getByLabel('Correo electrónico', { exact: true }).fill(`invitada-${Date.now()}@example.test`);
  await page.getByLabel('Enviar invitación al correo de esta persona después de guardar').check();
  await expect(page.getByRole('combobox', { name: 'Rol de acceso' })).toHaveValue('viewer');
  const saved = page.waitForResponse(r => new URL(r.url()).pathname === '/api/v1/persons' && r.request().method() === 'POST');
  const invited = page.waitForResponse(r => new URL(r.url()).pathname === '/api/v1/invitations' && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Guardar registro', exact: true }).click();
  expect((await saved).status()).toBe(200);
  expect((await invited).status()).toBe(200);
  await expect(page.locator('.notice[role="status"]')).toContainText('Invitación creada');
});
