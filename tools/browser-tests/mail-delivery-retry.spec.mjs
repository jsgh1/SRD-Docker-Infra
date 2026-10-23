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

test('administrador reintenta invitación y aviso de seguridad agotados', async ({ page }) => {
  test.setTimeout(240000);
  await login(page);
  await page.locator('.sidebar').getByRole('button', { name: 'Configuración', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Entregas de correo' });
  await expect(panel).toContainText('Invitaciones agotadas');
  await expect(panel).toContainText('Avisos de seguridad agotados');
  await expect(panel).not.toContainText(fixture.mail_retry_invitation_email);
  await expect(panel).not.toContainText(fixture.mail_retry_notice_email);

  await panel.getByText(/Invitaciones agotadas \(/).click();
  const invitation = panel.getByRole('row', { name: new RegExp(fixture.mail_retry_invitation_id) });
  await expect(invitation).toBeVisible();
  await invitation.getByRole('button', { name: 'Reintentar correo' }).click();
  const invitationConfirmation = page.getByRole('dialog', { name: 'Confirmar acción' });
  await expect(invitationConfirmation).toContainText('¿Programar un nuevo intento');
  await invitationConfirmation.getByRole('button', { name: 'Confirmar' }).click();
  await expect(panel.getByText('Reintento de correo programado para el próximo ciclo.')).toBeVisible();

  await panel.getByText(/Avisos de seguridad agotados \(/).click();
  const notice = panel.getByRole('row', { name: new RegExp(fixture.mail_retry_notice_id) });
  await expect(notice).toBeVisible();
  await notice.getByRole('button', { name: 'Reintentar correo' }).click();
  const noticeConfirmation = page.getByRole('dialog', { name: 'Confirmar acción' });
  await expect(noticeConfirmation).toContainText('¿Programar un nuevo intento');
  await noticeConfirmation.getByRole('button', { name: 'Confirmar' }).click();
  await expect.poll(async () => {
    const response = await page.request.get('/api/v1/system/mail-deliveries');
    const data = (await response.json()).data;
    return [data.invitations.exhausted, data.security_notices.exhausted];
  }, { timeout: 15000 }).toEqual([0, 0]);

  await expect.poll(async () => {
    const list = await (await page.request.get(`${mailUrl}/api/v1/messages`)).json();
    return [
      list.messages?.filter(item => item.Subject === 'Invitación privada a SRD'
        && item.To.some(to => to.Address === fixture.mail_retry_invitation_email)).length ?? 0,
      list.messages?.filter(item => item.Subject === 'Aviso de cambio de correo en SRD'
        && item.To.some(to => to.Address === fixture.mail_retry_notice_email)).length ?? 0,
    ];
  }, { timeout: 120000, intervals: [1000, 3000, 5000] }).toEqual([1, 1]);
  await expect.poll(async () => {
    const actions = ['mail.invitation_retry_requested', 'mail.security_notice_retry_requested'];
    const ids = [fixture.mail_retry_invitation_id, fixture.mail_retry_notice_id];
    return Promise.all(actions.map(async (action, index) => {
      const response = await page.request.get(`/api/v1/audit-events?action=${action}`);
      const items = (await response.json()).data.items;
      return items.some(item => item.resource_id === ids[index] && item.actor_id === fixture.users.admin.id);
    }));
  }, { timeout: 120000, intervals: [1000, 3000, 5000] }).toEqual([true, true]);
});
