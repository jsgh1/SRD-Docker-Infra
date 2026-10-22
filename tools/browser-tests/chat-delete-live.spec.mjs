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

test('el autor borra para ambos y el receptor solo para sí', async ({ page, browser }) => {
  test.setTimeout(160000);
  const recipientContext = await browser.newContext();
  const recipient = await recipientContext.newPage();
  try {
    await login(recipient, 'viewer');
    await login(page, 'admin');
    await page.locator('.sidebar').getByRole('button', { name: 'Contactos', exact: true }).click();
    await page.locator('.contact-card').filter({ hasText: 'Prueba Viewer' })
      .getByRole('button', { name: 'Abrir chat' }).click();
    const senderPanel = page.getByRole('region', { name: 'Mensajes' });
    const first = `Eliminar para ambos ${Date.now()}`;
    await senderPanel.getByRole('textbox', { name: 'Mensaje' }).fill(first);
    await senderPanel.getByRole('button', { name: 'Enviar', exact: true }).click();
    await expect(senderPanel.getByText(first)).toBeVisible();

    await recipient.locator('.sidebar').getByRole('button', { name: 'Chat', exact: true }).click();
    await recipient.getByRole('region', { name: 'Conversaciones' })
      .getByRole('button', { name: 'Prueba Admin' }).click();
    const receiverPanel = recipient.getByRole('region', { name: 'Mensajes' });
    await expect(receiverPanel.getByText(first)).toBeVisible({ timeout: 30000 });
    const sent = senderPanel.locator('.chat-messages li').filter({ hasText: first });
    await sent.locator('.chat-message-menu summary').click();
    await sent.getByRole('button', { name: 'Borrar para todos' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Borrar para todos' }).click();
    await expect(senderPanel.getByText(first)).toHaveCount(0);
    await expect(receiverPanel.getByText(first)).toHaveCount(0, { timeout: 30000 });

    const second = `Eliminar para mí ${Date.now()}`;
    await senderPanel.getByRole('textbox', { name: 'Mensaje' }).fill(second);
    await senderPanel.getByRole('button', { name: 'Enviar', exact: true }).click();
    const received = receiverPanel.locator('.chat-messages li').filter({ hasText: second });
    await expect(received).toBeVisible({ timeout: 30000 });
    await received.locator('.chat-message-menu summary').click();
    await received.getByRole('button', { name: 'Borrar para mí' }).click();
    await recipient.getByRole('dialog').getByRole('button', { name: 'Borrar para mí' }).click();
    await expect(receiverPanel.getByText(second)).toHaveCount(0);
    await expect(senderPanel.getByText(second)).toBeVisible();
  } finally {
    await recipientContext.close();
  }
});
