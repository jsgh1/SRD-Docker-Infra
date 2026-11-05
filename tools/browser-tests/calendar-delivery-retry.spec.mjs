import { test, expect } from '@playwright/test';
import fs from 'node:fs';

const fixture = JSON.parse(fs.readFileSync(process.env.SRD_BROWSER_FIXTURE, 'utf8'));
const mailUrl = process.env.SRD_MAILPIT_URL || 'http://localhost:8025';

async function login(page) {
  const email = fixture.users.admin.email;
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
  await expect(page.locator('.sidebar').getByRole('button', { name: 'Configuración', exact: true })).toBeVisible();
}

test('administrador reintenta un aviso agotado y llega una sola vez', async ({ page }) => {
  test.setTimeout(210000);
  await login(page);
  await page.locator('.sidebar').getByRole('button', { name: 'Configuración', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Entregas de calendario' });
  await expect(panel).toContainText('Avisos agotados');
  await panel.locator('summary').click();
  const row = panel.getByRole('row', { name: new RegExp(fixture.calendar_retry_job_id) });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Reintentar aviso' }).click();
  const confirmation = page.getByRole('dialog', { name: 'Confirmar acción' });
  await expect(confirmation).toContainText('¿Programar un nuevo intento');
  await confirmation.getByRole('button', { name: 'Confirmar' }).click();
  await expect(panel.getByText('Reintento programado. El aviso se procesará en el próximo ciclo.')).toBeVisible();
  await expect.poll(async () => {
    const response = await page.request.get('/api/v1/system/calendar-deliveries');
    return (await response.json()).data.exhausted;
  }, { timeout: 15000 }).toBe(0);
  await expect.poll(async () => {
    const response = await page.request.get('/api/v1/notifications');
    const data = (await response.json()).data;
    return data.items.filter(item => item.event_id === fixture.calendar_retry_event_id
      && item.kind === 'event_changed').length;
  }, { timeout: 120000, intervals: [1000, 3000, 5000] }).toBe(1);
  await expect.poll(async () => {
    const response = await page.request.get('/api/v1/audit-events?action=calendar.delivery_retry_requested');
    const data = (await response.json()).data;
    return data.items.some(item => item.resource_id === fixture.calendar_retry_job_id
      && item.actor_id === fixture.users.admin.id);
  }, { timeout: 120000, intervals: [1000, 3000, 5000] }).toBe(true);
});
