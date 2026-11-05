import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const fixture = JSON.parse(readFileSync(process.env.SRD_BROWSER_FIXTURE, 'utf8'));
const mailpit = process.env.SRD_MAILPIT_URL || 'http://localhost:8025';

test('chat history has visible loading, error and retry states', async ({ page }, testInfo) => {
  test.setTimeout(130000);
  const email = fixture.users.admin.email;
  const before = await (await page.request.get(`${mailpit}/api/v1/messages`)).json();
  const oldIds = new Set(before.messages?.map(message => message.ID) || []);
  await page.goto(`/j/${fixture.codeA}/login`);
  await page.getByLabel('Correo electrónico', { exact: true }).fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: 'términos y condiciones', exact: true }).click();
  await page.getByRole('button', { name: 'Aceptar términos', exact: true }).click();
  await page.getByRole('button', { name: 'Ingresar', exact: true }).click();
  let message;
  await expect.poll(async () => {
    const list = await (await page.request.get(`${mailpit}/api/v1/messages`)).json();
    message = list.messages?.find(item => !oldIds.has(item.ID) && item.To.some(to => to.Address === email));
    return Boolean(message);
  }, { timeout: 85000 }).toBe(true);
  const content = await (await page.request.get(`${mailpit}/api/v1/message/${message.ID}`)).json();
  await page.getByLabel('Código de verificación').fill(content.Text.match(/\b\d{6}\b/)[0]);
  await page.getByRole('button', { name: 'Confirmar código' }).click();
  await expect(page.locator('.sidebar').getByRole('button', { name: 'Chat', exact: true })).toBeVisible();
  const csrf = (await (await page.request.get('/api/v1/csrf')).json()).data.token;
  const created = await page.request.post('/api/v1/conversations', {
    headers: { 'X-CSRF-TOKEN': csrf }, data: { user_id: fixture.users.viewer.id },
  });
  expect(created.status()).toBe(200);
  let fail = true;
  await page.route('**/api/v1/conversations/*/messages*', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    if (fail) {
      fail = false;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Historial no disponible.' } }) });
    } else await route.continue();
  });
  await page.locator('.sidebar').getByRole('button', { name: 'Chat', exact: true }).click();
  await page.getByRole('region', { name: 'Conversaciones' }).getByRole('button', { name: /Prueba Viewer/ }).click();
  const thread = page.getByRole('region', { name: 'Mensajes' });
  await expect(thread.locator('.chat-thread-error')).toContainText('Historial no disponible.');
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth), `Chat con error a ${width}px`).toBeLessThanOrEqual(width + 2);
    await thread.screenshot({ path: testInfo.outputPath(`chat-error-${width}.png`) });
  }
  await thread.getByRole('button', { name: 'Reintentar mensajes' }).click();
  await expect(thread.locator('.chat-thread-error')).toHaveCount(0);
  await page.unroute('**/api/v1/conversations/*/messages*');

  await page.route('**/api/v1/conversations/*/messages*', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    await new Promise(resolve => setTimeout(resolve, 31000));
    await route.abort().catch(() => {});
  });
  await page.evaluate(() => document.dispatchEvent(new Event('srd-chat-change')));
  await expect(thread.locator('.chat-thread-error')).toContainText('La conexión tardó demasiado.', { timeout: 34000 });
  await page.unroute('**/api/v1/conversations/*/messages*');
  await thread.getByRole('button', { name: 'Reintentar mensajes' }).click();
  await expect(thread.locator('.chat-thread-error')).toHaveCount(0);
});
