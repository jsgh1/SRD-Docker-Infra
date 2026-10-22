import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const fixture = JSON.parse(readFileSync(process.env.SRD_BROWSER_FIXTURE, 'utf8'));
const mailpit = process.env.SRD_MAILPIT_URL || 'http://localhost:8025';

test('contacts and audit recover after failed and stalled reads', async ({ page }) => {
  test.setTimeout(180000);
  const email = fixture.users.admin.email;
  const before = await (await page.request.get(`${mailpit}/api/v1/messages`)).json();
  const oldIds = new Set(before.messages?.map(message => message.ID) || []);
  await page.goto(`/j/${fixture.codeA}/login`);
  await page.getByLabel('Correo electrónico', { exact: true }).fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: 'términos y condiciones', exact: true }).click();
  await page.getByRole('button', { name: 'Aceptar términos', exact: true }).click();
  await page.getByRole('button', { name: 'Ingresar', exact: true }).click();
  let message;
  await expect.poll(async () => {
    const list = await (await page.request.get(`${mailpit}/api/v1/messages`)).json();
    message = list.messages?.find(item => !oldIds.has(item.ID) && item.To.some(to => to.Address === email));
    return Boolean(message);
  }, { timeout: 85000 }).toBe(true);
  const content = await (await page.request.get(`${mailpit}/api/v1/message/${message.ID}`)).json();
  await page.getByLabel('Código de verificación').fill(content.Text.match(/\b\d{6}\b/)[0]);
  await page.getByRole('button', { name: 'Confirmar código' }).click();

  await page.locator('.sidebar').getByRole('button', { name: 'Contactos', exact: true }).click();
  const contacts = page.getByRole('region', { name: 'Directorio de contactos' });
  await expect(contacts.locator('.contact-list')).toBeVisible();
  let failContacts = true;
  await page.route('**/api/v1/contacts?*', async route => {
    if (failContacts) {
      failContacts = false;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Contactos no disponibles.' } }) });
    } else await route.continue();
  });
  await contacts.getByRole('button', { name: 'Actualizar estados' }).click();
  await expect(contacts.locator('.error')).toContainText('Contactos no disponibles.');
  await expect(contacts.locator('.contact-list')).toHaveCount(0);
  await contacts.getByRole('button', { name: 'Actualizar estados' }).click();
  await expect(contacts.locator('.contact-list')).toBeVisible();
  await page.unroute('**/api/v1/contacts?*');

  await page.route('**/api/v1/contacts?*', async route => {
    await new Promise(resolve => setTimeout(resolve, 31000));
    await route.abort().catch(() => {});
  });
  await contacts.getByRole('button', { name: 'Actualizar estados' }).click();
  await expect(contacts.locator('.error')).toContainText('La conexión tardó demasiado.', { timeout: 34000 });
  await expect(contacts.locator('.contact-list')).toHaveCount(0);
  await page.unroute('**/api/v1/contacts?*');
  await contacts.getByRole('button', { name: 'Actualizar estados' }).click();
  await expect(contacts.locator('.contact-list')).toBeVisible();

  await page.locator('.sidebar').getByRole('button', { name: 'Auditoría', exact: true }).click();
  const audit = page.getByRole('region', { name: 'Consulta de auditoría' });
  await expect(audit.getByRole('status')).toBeVisible();
  let failAudit = true;
  await page.route('**/api/v1/audit-events?*', async route => {
    if (failAudit) {
      failAudit = false;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Auditoría no disponible.' } }) });
    } else await route.continue();
  });
  await page.getByRole('button', { name: 'Actualizar', exact: true }).click();
  await expect(audit.locator('.error')).toContainText('Auditoría no disponible.');
  await expect(audit.getByRole('status')).toHaveCount(0);
  await page.getByRole('button', { name: 'Actualizar', exact: true }).click();
  await expect(audit.getByRole('status')).toBeVisible();
  await page.unroute('**/api/v1/audit-events?*');

  await page.route('**/api/v1/audit-events?*', async route => {
    await new Promise(resolve => setTimeout(resolve, 31000));
    await route.abort().catch(() => {});
  });
  await page.getByRole('button', { name: 'Actualizar', exact: true }).click();
  await expect(audit.locator('.error')).toContainText('La conexión tardó demasiado.', { timeout: 34000 });
  await page.unroute('**/api/v1/audit-events?*');
  await page.getByRole('button', { name: 'Actualizar', exact: true }).click();
  await expect(audit.getByRole('status')).toBeVisible();
});
