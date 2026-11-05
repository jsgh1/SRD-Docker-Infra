import { test, expect } from '@playwright/test';
import fs from 'node:fs';

const fixture = JSON.parse(fs.readFileSync(process.env.SRD_BROWSER_FIXTURE, 'utf8'));
const mailUrl = process.env.SRD_MAILPIT_URL || 'http://localhost:8025';

async function login(page, role) {
  const email = fixture.users[role].email;
  await page.goto(`/j/${fixture.codeA}/login`);
  await page.getByLabel('Correo electrónico', { exact: true }).fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: 'términos y condiciones', exact: true }).click();
  await page.getByRole('button', { name: 'Aceptar términos', exact: true }).click();
  await page.getByRole('button', { name: 'Ingresar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ingresa tu código' })).toBeVisible();
  let message;
  await expect.poll(async () => {
    const list = await (await page.request.get(`${mailUrl}/api/v1/messages`)).json();
    message = list.messages?.find(item => item.Subject === 'Tu código de seguridad de SRD'
      && item.To.some(to => to.Address === email));
    return !!message;
  }, { timeout: 85000 }).toBe(true);
  const content = await (await page.request.get(`${mailUrl}/api/v1/message/${message.ID}`)).json();
  await page.getByLabel('Código de verificación').fill(content.Text.match(/\b\d{6}\b/)[0]);
  await page.getByRole('button', { name: 'Confirmar código' }).click();
  await expect(page.locator('.sidebar').getByRole('button', { name: 'Auditoría', exact: true })).toBeVisible();
}

async function identityCard(page) {
  await page.locator('.sidebar').getByRole('button', { name: 'Auditoría', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Estado de entrega de auditoría' });
  const card = panel.locator('.delivery-card').filter({ has: page.getByRole('heading', { name: 'Identidad', exact: true }) });
  await expect(card).toContainText('Eventos agotados');
  await card.locator('summary').click();
  return card;
}

test('SA/AD reintenta un evento agotado y Auditoría lo recibe una sola vez', async ({ page, browser }) => {
  test.setTimeout(210000);
  const auditor = await browser.newPage();
  try {
    await login(auditor, 'auditor');
    const auditorCard = await identityCard(auditor);
    await expect(auditorCard.getByText(fixture.retry_event_id)).toBeVisible();
    await expect(auditorCard.getByRole('button', { name: 'Reintentar entrega' })).toHaveCount(0);

    await login(page, 'admin');
    const adminCard = await identityCard(page);
    const row = adminCard.getByRole('row', { name: new RegExp(fixture.retry_event_id) });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Reintentar entrega' }).click();
    const confirmation = page.getByRole('dialog', { name: 'Confirmar acción' });
    await expect(confirmation).toContainText('¿Programar un nuevo intento');
    await confirmation.getByRole('button', { name: 'Confirmar' }).click();
    await expect(page.getByText('Reintento programado. La entrega se procesará en el próximo ciclo.')).toBeVisible();
    await expect.poll(async () => {
      const response = await page.request.get('/api/v1/audit-delivery/identity');
      return (await response.json()).data.exhausted;
    }, { timeout: 15000 }).toBe(0);

    await expect.poll(async () => {
      const response = await page.request.get('/api/v1/audit-events?action=test.retry_exhausted');
      const result = (await response.json()).data;
      return result.items.filter(item => item.id === fixture.retry_event_id).length;
    }, { timeout: 120000, intervals: [1000, 3000, 5000] }).toBe(1);
    await expect.poll(async () => {
      const audit = await (await page.request.get('/api/v1/audit-events?action=audit.delivery_retry_requested')).json();
      return audit.data.items.some(item => item.resource_id === fixture.retry_event_id
        && item.actor_id === fixture.users.admin.id);
    }, { timeout: 120000, intervals: [1000, 3000, 5000] }).toBe(true);
  } finally { await auditor.close(); }
});
