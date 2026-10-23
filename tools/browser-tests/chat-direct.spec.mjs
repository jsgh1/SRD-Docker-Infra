import { test, expect } from '@playwright/test';
import fs from 'node:fs';
const fixture = JSON.parse(fs.readFileSync(process.env.SRD_BROWSER_FIXTURE));
const mailUrl = process.env.SRD_MAILPIT_URL || 'http://localhost:8025';

async function login(page, role) {
  await page.goto(`/j/${fixture.codeA}/login`);
  await page.getByLabel('Correo electrónico', { exact: true }).fill(fixture.users[role].email);
  await page.getByLabel('Contraseña', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: 'términos y condiciones', exact: true }).click();
  await page.getByRole('button', { name: 'Aceptar términos', exact: true }).click();
  await page.getByRole('button', { name: 'Ingresar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ingresa tu código' })).toBeVisible();
  let message;
  await expect.poll(async () => {
    const list = await (await page.request.get(`${mailUrl}/api/v1/messages`)).json();
    message = list.messages?.find(item => item.Subject === 'Tu código de seguridad de SRD' && item.To.some(to => to.Address === fixture.users[role].email));
    return !!message;
  }, { timeout: 85000 }).toBe(true);
  const content = await (await page.request.get(`${mailUrl}/api/v1/message/${message.ID}`)).json();
  await page.getByLabel('Código de verificación').fill(content.Text.match(/\b\d{6}\b/)[0]);
  await page.getByRole('button', { name: 'Confirmar código' }).click();
  await expect(page.locator('.sidebar').getByRole('button', { name: 'Chat', exact: true })).toBeVisible();
}

test('chat directo guarda, reutiliza y recupera texto sin duplicar reintentos', async ({ page, browser }) => {
  test.setTimeout(240000);
  const context = await browser.newContext();
  const receiver = await context.newPage();
  await login(receiver, 'viewer');
  const socketOpening = receiver.waitForEvent('websocket', { predicate: socket => socket.url().includes('/app/'), timeout: 30000 });
  await receiver.locator('.sidebar').getByRole('button', { name: 'Chat', exact: true }).click();
  const socket = await socketOpening;
  let socketClosed = false;
  socket.on('close', () => { socketClosed = true; });
  if (process.env.SRD_TEST_TLS === '1') expect(socket.url().startsWith('wss://')).toBe(true);
  const frames = [];
  socket.on('framereceived', frame => frames.push(frame.payload));
  await expect.poll(() => frames.some(frame => frame.includes('subscription_succeeded')), { timeout: 30000 }).toBe(true);
  await expect(receiver.getByRole('region', { name: 'Conversaciones' }).getByText('Sin conversaciones')).toBeVisible();
  await login(page, 'admin');
  await page.locator('.sidebar').getByRole('button', { name: 'Contactos', exact: true }).click();
  const card = page.locator('.contact-card').filter({ hasText: 'Prueba Viewer' });
  await card.getByRole('button', { name: 'Abrir chat' }).click();
  const panel = page.getByRole('region', { name: 'Mensajes' });
  await expect(panel.getByRole('button', { name: 'Ver perfil de Prueba Viewer' })).toBeVisible();
  const body = `Mensaje privado ${Date.now()}`;
  await panel.getByRole('textbox', { name: 'Mensaje' }).fill(body);
  await panel.getByRole('button', { name: 'Enviar', exact: true }).click();
  await expect(panel.getByText(body)).toBeVisible();
  await expect(panel.getByText('Enviado', { exact: false })).toBeVisible();
  const sentItem = panel.locator('.chat-messages li').filter({ hasText: body });
  await expect(sentItem).toContainText('Enviado');

  const conversations = (await (await page.request.get('/api/v1/conversations')).json()).data;
  expect(conversations.total).toBe(1);
  const conversationId = conversations.items[0].id;
  const token = (await (await page.request.get('/api/v1/csrf')).json()).data.token;
  const clientId = crypto.randomUUID();
  const retry = { client_id: clientId, body: 'Reintento sin duplicado' };
  const first = await page.request.post(`/api/v1/conversations/${conversationId}/messages`, { headers: { 'X-CSRF-TOKEN': token }, data: retry });
  expect(first.status()).toBe(200);
  const second = await page.request.post(`/api/v1/conversations/${conversationId}/messages`, { headers: { 'X-CSRF-TOKEN': token }, data: retry });
  expect(second.status()).toBe(200);
  expect((await second.json()).data.id).toBe((await first.json()).data.id);
  expect((await page.request.post(`/api/v1/conversations/${conversationId}/messages`, { headers: { 'X-CSRF-TOKEN': token }, data: { ...retry, body: 'Cambiado' } })).status()).toBe(409);

  try {
    await expect.poll(() => frames.some(frame => frame.includes('chat.changed')), { timeout: 10000 }).toBe(true);
    await expect(receiver.getByRole('region', { name: 'Conversaciones' }).getByRole('button', { name: 'Prueba Admin' })).toBeVisible({ timeout: 30000 });
    await expect(sentItem).toContainText('Enviado');
    const holdRead = async route => {
      if (route.request().postDataJSON()?.kind === 'read') await route.abort();
      else await route.continue();
    };
    await receiver.route('**/api/v1/conversations/*/receipts', holdRead);
    const bell = receiver.getByRole('button', { name: /^Notificaciones/ });
    await expect.poll(() => bell.getAttribute('aria-label'), { timeout: 110000 }).toMatch(/\d+ sin leer/);
    await bell.click();
    const notice = receiver.getByRole('region', { name: 'Bandeja de notificaciones' }).getByRole('button', { name: /Nuevo mensaje de Prueba Admin/ }).first();
    await expect(notice).toBeVisible();
    await notice.click();
    const received = receiver.getByRole('region', { name: 'Mensajes' });
    await expect(received.getByRole('button', { name: 'Ver perfil de Prueba Admin' })).toBeVisible();
    await expect(received.getByText(body)).toBeVisible();
    await expect(sentItem).toContainText('Entregado', { timeout: 30000 });
    await receiver.unroute('**/api/v1/conversations/*/receipts', holdRead);
    await expect(sentItem).toContainText('Leído', { timeout: 45000 });
    await expect(received.getByText('Reintento sin duplicado')).toHaveCount(1);
    await received.getByRole('textbox', { name: 'Mensaje' }).fill('Respuesta confirmada');
    await received.getByRole('button', { name: 'Enviar', exact: true }).click();
    await expect(panel.getByText('Respuesta confirmada')).toBeVisible({ timeout: 20000 });
    const receiverToken = (await (await receiver.request.get('/api/v1/csrf')).json()).data.token;
    const existingNotices = (await (await receiver.request.get('/api/v1/notifications')).json()).data.items;
    for (const item of existingNotices.filter(item => !item.read_at)) {
      const clear = await receiver.request.post(`/api/v1/notifications/${item.id}/read`, { headers: { 'X-CSRF-TOKEN': receiverToken } });
      expect(clear.ok()).toBe(true);
    }
    await receiver.locator('.sidebar').getByRole('button', { name: 'Home', exact: true }).click();
    const readBody = `Aviso para leer ${Date.now()}`;
    await panel.getByRole('textbox', { name: 'Mensaje' }).fill(readBody);
    await panel.getByRole('button', { name: 'Enviar', exact: true }).click();
    const readItem = panel.locator('.chat-messages li').filter({ hasText: readBody });
    await expect(readItem).toContainText('Enviado');
    const readMessageId = await readItem.getAttribute('id');
    await expect.poll(async () => {
      const data = (await (await receiver.request.get('/api/v1/notifications')).json()).data;
      return data.items.some(item => !item.read_at && `chat-message-${item.message_id}` === readMessageId);
    }, { timeout: 110000 }).toBe(true);
    await bell.click();
    await receiver.getByRole('button', { name: 'Actualizar', exact: true }).click();
    const unreadNotice = receiver.locator('.notification-list li.unread').filter({ hasText: 'Nuevo mensaje de Prueba Admin' }).first();
    await expect(unreadNotice).toBeVisible();
    await unreadNotice.getByRole('button', { name: 'Marcar leído' }).click();
    await expect(readItem).toContainText('Leído', { timeout: 45000 });
    const dismissBody = `Aviso para descartar ${Date.now()}`;
    await panel.getByRole('textbox', { name: 'Mensaje' }).fill(dismissBody);
    await panel.getByRole('button', { name: 'Enviar', exact: true }).click();
    await expect.poll(async () => {
      const data = (await (await receiver.request.get('/api/v1/notifications')).json()).data;
      return data.items.filter(item => !item.read_at && item.kind === 'chat_message').length;
    }, { timeout: 110000 }).toBe(1);
    await receiver.getByRole('button', { name: 'Actualizar', exact: true }).click();
    await expect(receiver.locator('.notification-list li.unread').filter({ hasText: 'Nuevo mensaje de Prueba Admin' }).first()).toBeVisible();
    const totalBeforeDismiss = await receiver.locator('.notification-list li').count();
    await receiver.locator('.notification-list li.unread').filter({ hasText: 'Nuevo mensaje de Prueba Admin' }).first().getByRole('button', { name: 'Descartar' }).click();
    await expect(receiver.locator('.notification-list li')).toHaveCount(totalBeforeDismiss - 1);
    const logout = await receiver.request.post('/api/v1/auth/logout', { headers: { 'X-CSRF-TOKEN': receiverToken } });
    expect(logout.status()).toBe(200);
    await expect.poll(() => socketClosed, { timeout: 25000 }).toBe(true);
  } finally { await context.close(); }
});
