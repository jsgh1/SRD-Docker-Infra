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
  await expect(page.locator('.sidebar').getByRole('button', { name: 'Chat', exact: true })).toBeVisible();
}

test('desactivar una membresía cierra desde Reverb el socket de esa junta', async ({ page, browser }) => {
  test.setTimeout(180000);
  await login(page, 'admin');
  const viewer = await browser.newPage();
  try {
    await login(viewer, 'viewer');
    const opening = viewer.waitForEvent('websocket', { predicate: socket => socket.url().includes('/app/'), timeout: 30000 });
    await viewer.evaluate(async () => {
      const config = (await (await fetch('/api/v1/chat/broadcast-config')).json()).data;
      const csrf = (await (await fetch('/api/v1/csrf')).json()).data.token;
      window.srdRawSubscribed = false;
      window.srdRawError = null;
      const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(`${scheme}//${location.host}/app/${encodeURIComponent(config.key)}?protocol=7&client=js&version=8.6.0&flash=false`);
      socket.addEventListener('message', async event => {
        try {
          const frame = JSON.parse(event.data);
          if (frame.event === 'pusher:connection_established') {
            const socketId = JSON.parse(frame.data).socket_id;
            const response = await fetch('/api/v1/chat/broadcast-auth', {
              method: 'POST', credentials: 'same-origin',
              headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-TOKEN': csrf },
              body: JSON.stringify({ socket_id: socketId, channel_name: config.channel }),
            });
            if (!response.ok) throw new Error(`Autorización HTTP ${response.status}`);
            const auth = (await response.json()).data;
            socket.send(JSON.stringify({ event: 'pusher:subscribe', data: {
              auth: auth.auth, channel: config.channel, channel_data: auth.channel_data,
            } }));
          } else if (frame.event?.includes('subscription_succeeded')) {
            window.srdRawSubscribed = true;
          } else if (frame.event === 'pusher:ping') {
            socket.send(JSON.stringify({ event: 'pusher:pong', data: {} }));
          }
        } catch (error) { window.srdRawError = String(error); }
      });
    });
    const socket = await opening;
    if (process.env.SRD_TEST_TLS === '1') expect(socket.url().startsWith('wss://')).toBe(true);
    await expect.poll(() => viewer.evaluate(() => {
      if (window.srdRawError) throw new Error(window.srdRawError);
      return window.srdRawSubscribed;
    }), { timeout: 30000 }).toBe(true);
    let closed = false;
    socket.on('close', () => { closed = true; });

    const members = (await (await page.request.get('/api/v1/members')).json()).data.items;
    const membership = members.find(item => item.user_id === fixture.users.viewer.id);
    expect(membership).toBeTruthy();
    const token = (await (await page.request.get('/api/v1/csrf')).json()).data.token;
    const response = await page.request.patch(`/api/v1/members/${membership.id}`, {
      headers: { 'X-CSRF-TOKEN': token },
      data: { role: membership.role, active: false, version: membership.version },
    });
    expect(response.status()).toBe(200);
    expect((await response.json()).data).toEqual({ version: membership.version + 1 });
    await expect.poll(() => closed, { timeout: 5000 }).toBe(true);
    expect((await viewer.request.get('/api/v1/chat/broadcast-config')).status()).toBe(401);
    expect((await page.request.get('/api/v1/chat/broadcast-config')).status()).toBe(200);
  } finally {
    await viewer.close();
  }
});
