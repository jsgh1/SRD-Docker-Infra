import { test, expect } from '@playwright/test';
import fs from 'node:fs';

const fixture = JSON.parse(fs.readFileSync(process.env.SRD_BROWSER_FIXTURE, 'utf8'));
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
    message = list.messages?.find(item => item.Subject === 'Tu código de seguridad de SRD'
      && item.To.some(to => to.Address === fixture.users.admin.email));
    return !!message;
  }, { timeout: 85000 }).toBe(true);
  const content = await (await page.request.get(`${mailUrl}/api/v1/message/${message.ID}`)).json();
  await page.getByLabel('Código de verificación').fill(content.Text.match(/\b\d{6}\b/)[0]);
  await page.getByRole('button', { name: 'Confirmar código' }).click();
  await expect(page.locator('.sidebar').getByRole('button', { name: 'Chat', exact: true })).toBeVisible();
}

test('las conversaciones posteriores a la primera página se pueden abrir', async ({ page }) => {
  test.setTimeout(240000);
  expect(fixture.extra_chat_users).toHaveLength(26);
  await login(page);
  const csrf = (await (await page.request.get('/api/v1/csrf')).json()).data.token;
  for (const contact of [fixture.users.viewer, ...fixture.extra_chat_users]) {
    const response = await page.request.post('/api/v1/conversations', {
      headers: { 'X-CSRF-TOKEN': csrf }, data: { user_id: contact.id },
    });
    expect(response.status()).toBe(200);
  }
  await page.locator('.sidebar').getByRole('button', { name: 'Chat', exact: true }).click();
  const conversations = page.getByRole('region', { name: 'Conversaciones' });
  const buttons = conversations.locator('.chat-conversations button');
  await expect(buttons).toHaveCount(25);
  await expect(conversations.getByText('Página 1 de 2')).toBeVisible();
  const firstPage = await buttons.locator('strong').allTextContents();

  await conversations.getByRole('button', { name: 'Conversaciones siguientes' }).click();
  await expect(conversations.getByText('Página 2 de 2')).toBeVisible();
  await expect(buttons).toHaveCount(2);
  const secondPage = await buttons.locator('strong').allTextContents();
  const expected = ['Prueba Viewer', ...fixture.extra_chat_users.map(user => user.name)];
  expect(new Set([...firstPage, ...secondPage])).toEqual(new Set(expected));
  await page.waitForResponse(response => response.url().includes('/api/v1/conversations?page=2')
    && response.request().method() === 'GET', { timeout: 22000 });
  await expect(conversations.getByText('Página 2 de 2')).toBeVisible();
  await expect(buttons).toHaveCount(2);

  const contactName = secondPage[0];
  await conversations.getByRole('button', { name: new RegExp(`^${contactName}`) }).click();
  const messages = page.getByRole('region', { name: 'Mensajes' });
  await expect(messages.getByRole('button', { name: `Ver perfil de ${contactName}` })).toBeVisible();
  const body = `Mensaje desde la segunda página ${Date.now()}`;
  await messages.getByRole('textbox', { name: 'Mensaje' }).fill(body);
  await messages.getByRole('button', { name: 'Enviar', exact: true }).click();
  await expect(messages.getByText(body)).toBeVisible();
});
