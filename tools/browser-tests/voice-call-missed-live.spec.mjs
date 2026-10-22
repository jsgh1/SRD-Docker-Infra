import { test, expect } from '@playwright/test';
import fs from 'node:fs';

const fixture = JSON.parse(fs.readFileSync(process.env.SRD_BROWSER_FIXTURE));
const mailUrl = process.env.SRD_MAILPIT_URL || 'http://localhost:8025';

async function login(page, role) {
  const email = fixture.users[role].email;
  const before = await (await page.request.get(`${mailUrl}/api/v1/messages`)).json();
  const oldIds = new Set(before.messages?.map(message => message.ID) || []);
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
    message = list.messages?.find(item => !oldIds.has(item.ID) && item.Subject === 'Tu código de seguridad de SRD'
      && item.To.some(to => to.Address === email));
    return !!message;
  }, { timeout: 85000 }).toBe(true);
  const content = await (await page.request.get(`${mailUrl}/api/v1/message/${message.ID}`)).json();
  await page.getByLabel('Código de verificación').fill(content.Text.match(/\b\d{6}\b/)[0]);
  await page.getByRole('button', { name: 'Confirmar código' }).click();
  await expect(page.getByRole('heading', { name: /Hola,/ })).toBeVisible();
}

test('una llamada no contestada crea aviso y evento visible en el chat', async ({ page, browser }) => {
  test.setTimeout(210000);
  const recipientContext = await browser.newContext({ viewport: { width: 360, height: 780 } });
  const recipient = await recipientContext.newPage();
  try {
    await login(recipient, 'registrar');
    await login(page, 'admin');
    const token = (await (await page.request.get('/api/v1/csrf')).json()).data.token;
    const headers = { 'X-CSRF-TOKEN': token };
    const conversationResponse = await page.request.post('/api/v1/conversations', {
      headers, data: { user_id: fixture.users.registrar.id },
    });
    expect(conversationResponse.ok()).toBe(true);
    const conversationId = (await conversationResponse.json()).data.id;
    const callResponse = await page.request.post(`/api/v1/conversations/${conversationId}/calls`, { headers });
    expect(callResponse.ok()).toBe(true);
    const callId = (await callResponse.json()).data.id;

    await expect(recipient.getByText('Llamada entrante de Prueba Admin')).toBeVisible({ timeout: 15000 });
    await expect.poll(async () => {
      const inbox = (await (await recipient.request.get('/api/v1/notifications')).json()).data;
      return inbox.items.some(item => item.kind === 'chat_call' && item.conversation_id === conversationId);
    }, { timeout: 15000 }).toBe(true);

    await expect.poll(async () => {
      const response = await page.request.get(`/api/v1/conversations/${conversationId}/calls/${callId}`);
      return (await response.json()).data.status;
    }, { timeout: 70000, intervals: [1000, 2000, 5000] }).toBe('missed');
    await expect(recipient.getByText('Llamada entrante de Prueba Admin')).toHaveCount(0);
    await expect.poll(async () => {
      const inbox = (await (await recipient.request.get('/api/v1/notifications')).json()).data;
      return inbox.items.some(item => item.kind === 'chat_missed' && item.conversation_id === conversationId);
    }, { timeout: 70000, intervals: [2000, 5000] }).toBe(true);

    await recipient.getByRole('button', { name: /^Notificaciones/ }).click();
    await recipient.getByRole('button', { name: 'Actualizar', exact: true }).click();
    const missed = recipient.getByRole('region', { name: 'Bandeja de notificaciones' })
      .getByRole('button', { name: /Llamada perdida de Prueba Admin/ });
    await expect(missed).toBeVisible();
    await missed.click();
    await expect(recipient.getByRole('region', { name: 'Mensajes' }).getByText('Llamada perdida')).toBeVisible();
  } finally {
    await recipientContext.close();
  }
});
