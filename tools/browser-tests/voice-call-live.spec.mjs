import { test, expect } from '@playwright/test';
import fs from 'node:fs';

const fixture = JSON.parse(fs.readFileSync(process.env.SRD_BROWSER_FIXTURE));
const mailUrl = process.env.SRD_MAILPIT_URL || 'http://localhost:8025';

test.use({ channel: 'chrome', launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] } });

async function login(page, role) {
  const email = fixture.users[role].email;
  const before = await (await page.request.get(`${mailUrl}/api/v1/messages`)).json();
  const oldIds = new Set(before.messages?.map(message => message.ID) || []);
  await page.goto(`/j/${fixture.codeA || 'srd-e2e-a'}/login`);
  await page.getByLabel('Correo electrónico', { exact: true }).fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: 'términos y condiciones', exact: true }).click();
  await page.getByRole('button', { name: 'Aceptar términos', exact: true }).click();
  await page.getByRole('button', { name: 'Ingresar', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Ingresa tu código|Enter your code/ })).toBeVisible();
  let message;
  await expect.poll(async () => {
    const list = await (await page.request.get(`${mailUrl}/api/v1/messages`)).json();
    message = list.messages?.find(item => !oldIds.has(item.ID) && ['Tu código de seguridad de SRD', 'Your SRD security code'].includes(item.Subject) && item.To.some(to => to.Address === email));
    return !!message;
  }, { timeout: 85000 }).toBe(true);
  const content = await (await page.request.get(`${mailUrl}/api/v1/message/${message.ID}`)).json();
  await page.getByLabel(/Código de verificación|Verification code/).fill(content.Text.match(/\b\d{6}\b/)[0]);
  await page.getByRole('button', { name: /Confirmar código|Confirm code/ }).click();
  await expect(page.getByRole('heading', { name: /Hola,|Hello,/ })).toBeVisible();
}

test('two authenticated sessions complete a voice call through Gateway and Chat', async ({ page, browser }) => {
  test.setTimeout(180000);
  const receiverContext = await browser.newContext({ viewport: { width: 360, height: 780 } });
  const recordRtcErrors = () => {
    window.__srdRtcErrors = [];
    for (const method of ['setRemoteDescription', 'createAnswer', 'addIceCandidate']) {
      const original = RTCPeerConnection.prototype[method];
      RTCPeerConnection.prototype[method] = async function (...args) {
        try { return await original.apply(this, args); }
        catch (error) { window.__srdRtcErrors.push(`${method}: ${error.name}`); throw error; }
      };
    }
  };
  await page.addInitScript(recordRtcErrors);
  await receiverContext.addInitScript(recordRtcErrors);
  const receiver = await receiverContext.newPage();
  const errors = [];
  const signalRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  receiver.on('pageerror', error => errors.push(error.message));
  for (const tab of [page, receiver]) tab.on('response', response => {
    if (!response.url().includes('/calls/') || !response.url().includes('/signal')) return;
    const request = response.request();
    signalRequests.push({ side: tab === page ? 'caller' : 'callee', method: request.method(),
      kind: request.method() === 'POST' ? request.postDataJSON()?.kind : 'poll', status: response.status() });
  });
  try {
    await login(receiver, 'registrar');
    await login(page, 'admin');
    const contacts = (await (await page.request.get('/api/v1/contacts?page=1')).json()).data.items;
    const recipientName = contacts.find(contact => contact.id === fixture.users.registrar.id)?.name;
    expect(recipientName).toBeTruthy();
    await page.locator('.sidebar').getByRole('button', { name: /^(Contactos|Contacts)$/ }).click();
    await page.locator('.contact-card').filter({ hasText: recipientName }).getByRole('button', { name: /Abrir chat|Open chat/ }).click();
    await expect(page.getByRole('region', { name: /Mensajes|Messages/ }).getByRole('button', { name: `Ver perfil de ${recipientName}` })).toBeVisible();
    await page.getByRole('button', { name: new RegExp(`^(Llamar a|Call) ${recipientName}$`) }).click();
    await expect(receiver.getByText('Llamada entrante de Prueba Admin')).toBeVisible({ timeout: 30000 });
    expect(await receiver.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await receiver.getByRole('button', { name: 'Aceptar llamada' }).click();
    await expect(page.getByText(/Llamada en curso|Call in progress/)).toBeVisible({ timeout: 30000 });
    await expect(receiver.getByText('Llamada en curso')).toBeVisible();
    const remoteAudio = () => page.evaluate(() => {
      const audio = document.querySelector('audio[aria-label="Audio de la llamada"], audio[aria-label="Call audio"]');
      return audio?.srcObject?.getAudioTracks().some(track => track.readyState === 'live') || false;
    });
    try { await expect.poll(remoteAudio, { timeout: 12000 }).toBe(true); }
    catch {
      const details = await Promise.all([page, receiver].map(tab => tab.evaluate(() => ({
        rtc: window.__srdRtcErrors,
        callActive: !!document.querySelector('.voice-call-active'),
        hasError: !!document.querySelector('.voice-call .error'),
      }))));
      throw new Error(`No remote audio: ${JSON.stringify({ details, signalRequests })}`);
    }
    await page.getByRole('button', { name: /Silenciar micrófono|Mute microphone/ }).click();
    await expect(page.getByRole('button', { name: /Activar micrófono|Unmute microphone/ })).toBeVisible();
    await page.getByRole('button', { name: /Finalizar llamada|End call/ }).click();
    await expect(receiver.getByText('Llamada en curso')).toHaveCount(0, { timeout: 15000 });
    expect(errors).toEqual([]);
  } finally {
    await receiverContext.close();
  }
});
