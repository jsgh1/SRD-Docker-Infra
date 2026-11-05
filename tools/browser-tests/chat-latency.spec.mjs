import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const fixture = JSON.parse(fs.readFileSync(process.env.SRD_BROWSER_FIXTURE, 'utf8'));
const mailUrl = process.env.SRD_MAILPIT_URL || 'http://localhost:8025';
const count = Number(process.env.SRD_CHAT_LATENCY_COUNT || 1000);
if (!Number.isInteger(count) || count < 1 || count > 1000) throw new Error('La cantidad debe estar entre 1 y 1000.');

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
    message = list.messages?.find(item => item.Subject === 'Tu código de seguridad de SRD'
      && item.To.some(to => to.Address === fixture.users[role].email));
    return !!message;
  }, { timeout: 85000 }).toBe(true);
  const content = await (await page.request.get(`${mailUrl}/api/v1/message/${message.ID}`)).json();
  await page.getByLabel('Código de verificación').fill(content.Text.match(/\b\d{6}\b/)[0]);
  await page.getByRole('button', { name: 'Confirmar código' }).click();
  await expect(page.locator('.sidebar').getByRole('button', { name: 'Chat', exact: true })).toBeVisible();
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  return Math.round(ordered[Math.ceil(ordered.length * fraction) - 1] * 100) / 100;
}

test('latencia de 1000 mensajes persistidos hasta lectura autorizada por WSS', async ({ page, browser }) => {
  test.setTimeout(30 * 60 * 1000);
  if (process.env.SRD_TEST_TLS !== '1') throw new Error('Ejecuta esta medición con -Compose -Tls.');
  const reportFile = path.join(path.dirname(process.env.SRD_BROWSER_REPORT), 'chat-latency-measurements.json');
  const runId = crypto.randomUUID();
  const results = [];
  let failure = null;
  let attempted = 0;
  const context = await browser.newContext({ ignoreHTTPSErrors: process.env.SRD_TEST_TLS === '1' });
  const receiver = await context.newPage();
  let socketStarted = false;
  try {
    await login(page, 'admin');
    await login(receiver, 'viewer');
    const senderCsrf = (await (await page.request.get('/api/v1/csrf')).json()).data.token;
    const start = await page.request.post('/api/v1/conversations', {
      headers: { 'X-CSRF-TOKEN': senderCsrf }, data: { user_id: fixture.users.viewer.id },
    });
    expect(start.status()).toBe(200);
    const conversationId = (await start.json()).data.id;

    const opening = receiver.waitForEvent('websocket', { predicate: socket => socket.url().includes('/app/'), timeout: 30000 });
    await receiver.evaluate(async () => {
      const config = (await (await fetch('/api/v1/chat/broadcast-config')).json()).data;
      const csrf = (await (await fetch('/api/v1/csrf')).json()).data.token;
      window.srdLoadSubscribed = false;
      window.srdLoadError = null;
      const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(`${scheme}//${location.host}/app/${encodeURIComponent(config.key)}?protocol=7&client=js&version=8.6.0&flash=false`);
      window.srdLoadSocket = socket;
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
            if (!response.ok) throw new Error(`Canal rechazado: ${response.status}`);
            const authorization = (await response.json()).data;
            socket.send(JSON.stringify({ event: 'pusher:subscribe', data: {
              auth: authorization.auth, channel: config.channel, channel_data: authorization.channel_data,
            } }));
          } else if (frame.event?.includes('subscription_succeeded')) {
            window.srdLoadSubscribed = true;
          } else if (frame.event === 'pusher:ping') {
            socket.send(JSON.stringify({ event: 'pusher:pong', data: {} }));
          }
        } catch (error) { window.srdLoadError = String(error); }
      });
    });
    socketStarted = true;
    const socket = await opening;
    if (process.env.SRD_TEST_TLS === '1') expect(socket.url().startsWith('wss://')).toBe(true);
    await expect.poll(() => receiver.evaluate(() => {
      if (window.srdLoadError) throw new Error(window.srdLoadError);
      return window.srdLoadSubscribed;
    }), { timeout: 30000 }).toBe(true);

    let pendingSignal;
    socket.on('framereceived', frame => {
      if (!frame.payload.includes('"event":"chat.changed"')) return;
      pendingSignal?.();
    });
    for (let index = 1; index <= count; index++) {
      attempted++;
      const body = `Carga SRD ${runId} ${index}`;
      const started = performance.now();
      let timer;
      const signalled = new Promise(resolve => {
        timer = setTimeout(() => resolve(null), 10000);
        pendingSignal = () => resolve(performance.now());
      });
      try {
        const response = await page.request.post(`/api/v1/conversations/${conversationId}/messages`, {
          headers: { 'X-CSRF-TOKEN': senderCsrf }, data: { client_id: crypto.randomUUID(), body },
        });
        if (response.status() !== 200) throw new Error(`Mensaje ${index}: HTTP ${response.status()}.`);
        const sent = (await response.json()).data;
        const persistedMs = performance.now() - started;
        const signalAt = await signalled;
        if (signalAt === null) throw new Error(`Sin señal para el mensaje ${index}.`);
        const signalMs = signalAt - started;
        const received = await receiver.request.get(`/api/v1/conversations/${conversationId}/messages?after=${sent.sequence - 1}`);
        if (received.status() !== 200) throw new Error(`Lectura ${index}: HTTP ${received.status()}.`);
        const matches = (await received.json()).data.items.some(item => item.id === sent.id && item.body === body);
        if (!matches) throw new Error(`El receptor no recuperó el mensaje ${index}.`);
        const deliveryMs = performance.now() - started;
        results.push({ index, persisted_ms: Math.round(persistedMs * 100) / 100,
          signal_ms: Math.round(signalMs * 100) / 100, delivery_ms: Math.round(deliveryMs * 100) / 100 });
        if (index % 100 === 0) console.log(`Chat: ${index}/${count} mensajes verificados.`);
        await new Promise(resolve => setTimeout(resolve, Math.max(0, 650 - (performance.now() - started))));
      } finally {
        clearTimeout(timer);
        pendingSignal = undefined;
      }
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    if (socketStarted) await receiver.evaluate(() => window.srdLoadSocket?.close()).catch(() => {});
    await context.close();
    const successful = results.length;
    const report = { requested: count, attempted, successful, failed_attempts: attempted - successful,
      not_run: count - attempted, transport: 'WSS', pacing_minimum_ms: 650, error: failure,
      p95_persisted_ms: percentile(results.map(item => item.persisted_ms), 0.95),
      p95_signal_ms: percentile(results.map(item => item.signal_ms), 0.95),
      p95_delivery_ms: percentile(results.map(item => item.delivery_ms), 0.95),
      measurements: results };
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
    console.log(`Chat: ${successful}/${count}; p95 entrega ${report.p95_delivery_ms ?? 'sin datos'} ms; informe ${reportFile}`);
  }
  if (count === 1000) expect(percentile(results.map(item => item.delivery_ms), 0.95)).toBeLessThan(2000);
});
