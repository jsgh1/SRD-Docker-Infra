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
  await expect(page.locator('.sidebar').getByRole('button', { name: 'Chat', exact: true })).toBeVisible();
}

test('historial cargado permanece al sondear mensajes nuevos', async ({ page }) => {
  test.setTimeout(180000);
  await login(page);
  await page.locator('.sidebar').getByRole('button', { name: 'Contactos', exact: true }).click();
  await page.locator('.contact-card').filter({ hasText: 'Prueba Viewer' }).getByRole('button', { name: 'Abrir chat' }).click();
  const panel = page.getByRole('region', { name: 'Mensajes' });
  await expect(panel.getByRole('button', { name: 'Ver perfil de Prueba Viewer' })).toBeVisible();
  const oldestBody = `Inicio del historial ${Date.now()}`;
  await panel.getByRole('textbox', { name: 'Mensaje' }).fill(oldestBody);
  await panel.getByRole('button', { name: 'Enviar', exact: true }).click();
  await expect(panel.getByText(oldestBody)).toHaveCount(1);

  const conversationId = (await (await page.request.get('/api/v1/conversations')).json()).data.items[0].id;
  const token = (await (await page.request.get('/api/v1/csrf')).json()).data.token;
  for (let index = 1; index <= 27; index++) {
    const response = await page.request.post(`/api/v1/conversations/${conversationId}/messages`, {
      headers: { 'X-CSRF-TOKEN': token }, data: { client_id: crypto.randomUUID(), body: `Relleno ${index}` },
    });
    expect(response.status()).toBe(200);
  }
  await page.locator('.sidebar').getByRole('button', { name: 'Contactos', exact: true }).click();
  await page.locator('.sidebar').getByRole('button', { name: 'Chat', exact: true }).click();
  await page.getByRole('region', { name: 'Conversaciones' }).getByRole('button', { name: 'Prueba Viewer' }).click();
  await expect(panel.getByRole('button', { name: 'Ver mensajes anteriores' })).toBeVisible();
  await expect(panel.getByText(oldestBody)).toHaveCount(0);
  await panel.getByRole('button', { name: 'Ver mensajes anteriores' }).click();
  await expect(panel.getByText(oldestBody)).toHaveCount(1);

  const newBody = `Llega después ${Date.now()}`;
  const response = await page.request.post(`/api/v1/conversations/${conversationId}/messages`, {
    headers: { 'X-CSRF-TOKEN': token }, data: { client_id: crypto.randomUUID(), body: newBody },
  });
  expect(response.status()).toBe(200);
  await expect(panel.getByText(newBody)).toHaveCount(1, { timeout: 30000 });
  await expect(panel.getByText(oldestBody)).toHaveCount(1);
  const oldMessage = panel.locator('.chat-messages li').filter({ hasText: oldestBody });
  await oldMessage.locator('.chat-message-menu summary').click();
  await oldMessage.getByRole('button', { name: 'Fijar mensaje' }).click();
  const pinned = panel.locator('.chat-pinned');
  await expect(pinned).toContainText(oldestBody);
  await pinned.locator('summary').click();
  await pinned.getByRole('button', { name: 'Ir al mensaje' }).click();
  await expect(oldMessage).toBeVisible();
});
