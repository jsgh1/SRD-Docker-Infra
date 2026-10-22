import { test, expect } from '@playwright/test';
import fs from 'node:fs';

const fixture = JSON.parse(fs.readFileSync(process.env.SRD_BROWSER_FIXTURE, 'utf8'));
const mailUrl = process.env.SRD_MAILPIT_URL || 'http://localhost:8025';

async function mail(page, email, subject, previousId = null) {
  let message;
  await expect.poll(async () => {
    const list = await (await page.request.get(`${mailUrl}/api/v1/messages`)).json();
    message = list.messages?.find(item => item.ID !== previousId && item.Subject === subject
      && item.To.some(to => to.Address === email));
    return !!message;
  }, { timeout: 85000 }).toBe(true);
  return { id: message.ID, content: await (await page.request.get(`${mailUrl}/api/v1/message/${message.ID}`)).json() };
}

async function login(page, role, previousMailId = null) {
  const email = fixture.users[role].email;
  await page.goto(`/j/${fixture.codeA}/login`);
  await page.getByLabel('Correo electrónico', { exact: true }).fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: 'términos y condiciones', exact: true }).click();
  await page.getByRole('button', { name: 'Aceptar términos', exact: true }).click();
  const requestedAt = Date.now();
  await page.getByRole('button', { name: 'Ingresar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ingresa tu código' })).toBeVisible();
  const message = await mail(page, email, 'Tu código de seguridad de SRD', previousMailId);
  await page.getByLabel('Código de verificación').fill(message.content.Text.match(/\b\d{6}\b/)[0]);
  await page.getByRole('button', { name: 'Confirmar código' }).click();
  await expect(page.locator('.sidebar').getByRole('button', { name: 'Chat', exact: true })).toBeVisible();
  return { mailId: message.id, requestedAt };
}

async function rawSocket(page) {
  const opening = page.waitForEvent('websocket', { predicate: socket => socket.url().includes('/app/'), timeout: 30000 });
  await page.evaluate(async () => {
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
  await expect.poll(() => page.evaluate(() => {
    if (window.srdRawError) throw new Error(window.srdRawError);
    return window.srdRawSubscribed;
  }), { timeout: 30000 }).toBe(true);
  let closed = false;
  socket.on('close', () => { closed = true; });
  return () => closed;
}

async function csrf(page) {
  return (await (await page.request.get('/api/v1/csrf')).json()).data.token;
}

test('restablecer contraseña cierra el socket de la sesión revocada', async ({ page }) => {
  test.setTimeout(180000);
  await login(page, 'viewer');
  const closed = await rawSocket(page);
  const response = await page.request.post('/api/v1/auth/recover', {
    headers: { 'X-CSRF-TOKEN': await csrf(page) },
    data: { email: fixture.users.viewer.email, organization_code: fixture.codeA },
  });
  expect(response.status()).toBe(200);
  const resetMail = await mail(page, fixture.users.viewer.email, 'Restablece tu acceso a SRD');
  const match = resetMail.content.HTML.match(/\/reset#([a-f0-9-]+)\.([a-f0-9]{64})/);
  expect(match).toBeTruthy();
  const reset = await page.request.post('/api/v1/auth/reset', {
    headers: { 'X-CSRF-TOKEN': await csrf(page) },
    data: { challenge_id: match[1], secret: match[2], password: 'Nueva-clave-segura-123',
      password_confirmation: 'Nueva-clave-segura-123' },
  });
  expect(reset.status()).toBe(200);
  expect((await reset.json()).data).toEqual([]);
  await expect.poll(closed, { timeout: 5000 }).toBe(true);
  expect((await page.request.get('/api/v1/chat/broadcast-config')).status()).toBe(401);
});

test('cambiar correo cierra el socket anterior y conserva la sesión actual', async ({ page, browser }) => {
  test.setTimeout(240000);
  const firstLogin = await login(page, 'registrar');
  const closed = await rawSocket(page);
  const current = await browser.newPage();
  try {
    await new Promise(resolve => setTimeout(resolve, Math.max(0, 62000 - (Date.now() - firstLogin.requestedAt))));
    await login(current, 'registrar', firstLogin.mailId);
    const newEmail = `nuevo-registrar-${Date.now()}@srd-e2e.test`;
    const requested = await current.request.post('/api/v1/profile/email-change', {
      headers: { 'X-CSRF-TOKEN': await csrf(current) },
      data: { new_email: newEmail, password: fixture.password },
    });
    expect(requested.status()).toBe(200);
    const challengeId = (await requested.json()).data.challenge_id;
    const confirmationMail = await mail(current, newEmail, 'Tu código de seguridad de SRD');
    const code = confirmationMail.content.Text.match(/\b\d{6}\b/)[0];
    const confirmed = await current.request.post('/api/v1/profile/email-change/confirm', {
      headers: { 'X-CSRF-TOKEN': await csrf(current) },
      data: { challenge_id: challengeId, code },
    });
    expect(confirmed.status()).toBe(200);
    expect((await confirmed.json()).data).toEqual({
      message: 'Correo actualizado. Se revocaron las otras sesiones y se programó un aviso al correo anterior.',
    });
    await expect.poll(closed, { timeout: 5000 }).toBe(true);
    expect((await page.request.get('/api/v1/chat/broadcast-config')).status()).toBe(401);
    expect((await current.request.get('/api/v1/chat/broadcast-config')).status()).toBe(200);
  } finally {
    await current.close();
  }
});
