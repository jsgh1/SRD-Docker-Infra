import { test, expect } from '@playwright/test';
import fs from 'node:fs';

const fixture = JSON.parse(fs.readFileSync(process.env.SRD_BROWSER_FIXTURE, 'utf8'));
const mailUrl = process.env.SRD_MAILPIT_URL || 'http://localhost:8025';

async function login(page, role) {
  const email = fixture.users[role].email;
  await page.goto(`/j/${fixture.codeA || 'srd-e2e-a'}/login`);
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

test('superadministrador suspende y reactiva una cuenta sin restaurar su sesión', async ({ page, browser }) => {
  test.setTimeout(240000);
  await login(page, 'superadmin');
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

    await page.locator('.sidebar').getByRole('button', { name: 'Configuración', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Cuentas de la plataforma' })).toBeVisible();
    await page.getByLabel('Buscar por nombre o correo').fill(fixture.users.viewer.email);
    await page.getByRole('button', { name: 'Buscar cuentas' }).click();
    const accountsPanel = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Cuentas de la plataforma', exact: true }) });
    const row = accountsPanel.getByRole('row', { name: new RegExp(fixture.users.viewer.email) });
    await expect(row).toBeVisible();
    await expect(row).toContainText('2');
    await row.getByRole('button', { name: 'Suspender cuenta' }).click();
    const suspendConfirmation = page.getByRole('dialog', { name: 'Confirmar acción' });
    await expect(suspendConfirmation).toContainText('¿Suspender la cuenta');
    await suspendConfirmation.getByRole('button', { name: 'Confirmar' }).click();
    await expect(page.getByText('Cuenta suspendida. Sus sesiones quedaron revocadas.')).toBeVisible();
    await expect.poll(() => closed, { timeout: 5000 }).toBe(true);
    await expect.poll(() => viewer.evaluate(async () =>
      (await fetch('/api/v1/me', { credentials: 'same-origin' })).status),
    { timeout: 10000 }).toBe(401);

    await row.getByRole('button', { name: 'Reactivar cuenta' }).click();
    const reactivateConfirmation = page.getByRole('dialog', { name: 'Confirmar acción' });
    await expect(reactivateConfirmation).toContainText('¿Reactivar la cuenta');
    await reactivateConfirmation.getByRole('button', { name: 'Confirmar' }).click();
    await expect(page.getByText('Cuenta reactivada. Deberá iniciar sesión de nuevo.')).toBeVisible();
    expect(await viewer.evaluate(async () =>
      (await fetch('/api/v1/me', { credentials: 'same-origin' })).status)).toBe(401);
    expect(await page.evaluate(async () =>
      (await fetch('/api/v1/me', { credentials: 'same-origin' })).status)).toBe(200);
  } finally { await viewer.close(); }
});
