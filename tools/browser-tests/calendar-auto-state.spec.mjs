import { test, expect } from '@playwright/test';
import fs from 'node:fs';
const fixture = JSON.parse(fs.readFileSync(process.env.SRD_BROWSER_FIXTURE));
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
    message = list.messages?.find(item => item.Subject === 'Tu código de seguridad de SRD' && item.To.some(to => to.Address === fixture.users.admin.email));
    return !!message;
  }, { timeout: 85000 }).toBe(true);
  const content = await (await page.request.get(`${mailUrl}/api/v1/message/${message.ID}`)).json();
  await page.getByLabel('Código de verificación').fill(content.Text.match(/\b\d{6}\b/)[0]);
  await page.getByRole('button', { name: 'Confirmar código' }).click();
  await expect(page.locator('.sidebar').getByRole('button', { name: 'Home', exact: true })).toBeVisible();
}

test('calendar advances list and detail states without session requests', async ({ page }) => {
  await login(page);
  const token = (await (await page.request.get('/api/v1/csrf')).json()).data.token;
  const start = new Date(Date.now() + 30 * 3600000), end = new Date(start.getTime() + 3600000);
  const title = `Estado automático ${Date.now()}`;
  const created = await page.request.post('/api/v1/calendar-events', { headers: { 'X-CSRF-TOKEN': token }, data: {
    type: 'meeting', title, starts_at: start.toISOString().replace(/\.\d{3}Z$/, '+00:00'),
    ends_at: end.toISOString().replace(/\.\d{3}Z$/, '+00:00'), participants: [],
  } });
  expect(created.status()).toBe(200);
  const event = (await created.json()).data;
  try {
    await page.locator('.sidebar').getByRole('button', { name: 'Calendario', exact: true }).click();
    await page.getByRole('button', { name: 'Agenda', exact: true }).click();
    const button = page.locator('.calendar-agenda .calendar-event').filter({ hasText: title }).first();
    await expect(button.locator('.calendar-event-state')).toHaveText('Programado');
    await button.click();
    const detail = page.getByRole('dialog', { name: 'Detalle del evento' });
    await expect(detail.getByText('Estado: Programado', { exact: true })).toBeVisible();
    await page.waitForLoadState('networkidle');
    const requests = [];
    const capture = request => { if (request.url().includes('/api/v1/')) requests.push(request.url()); };
    page.on('request', capture);
    await page.clock.install({ time: new Date() });
    for (const [time, label] of [[start.getTime() - 24 * 3600000, 'Próximo'], [start.getTime(), 'En curso'], [end.getTime(), 'Finalizado']]) {
      await page.clock.setSystemTime(new Date(time));
      await page.clock.runFor(1000);
      await expect(button.locator('.calendar-event-state')).toHaveText(label);
      await expect(detail.getByText(`Estado: ${label}`, { exact: true })).toBeVisible();
    }
    await page.clock.setSystemTime(new Date(start.getTime() - 3600000));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(detail.getByText('Estado: Próximo', { exact: true })).toBeVisible();
    await page.evaluate(() => Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }));
    await page.clock.setSystemTime(end);
    await page.clock.runFor(2000);
    await expect(detail.getByText('Estado: Próximo', { exact: true })).toBeVisible();
    await page.evaluate(() => {
      delete document.visibilityState;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(detail.getByText('Estado: Finalizado', { exact: true })).toBeVisible();
    expect(requests.filter(url => new URL(url).pathname !== '/api/v1/presence/heartbeat')).toEqual([]);
    page.off('request', capture);
    await page.setViewportSize({ width: 360, height: 800 });
    await page.screenshot({ path: '.local/calendar-auto-state-mobile.png' });
    const current = (await (await page.request.get(`/api/v1/calendar-events/${event.id}`)).json()).data;
    expect(current.version).toBe(event.version);
    expect(current.starts_at).toBe(event.starts_at);
    expect(current.ends_at).toBe(event.ends_at);
    expect(current.state).toBe('scheduled');
  } finally {
    const cancelled = await page.request.post(`/api/v1/calendar-events/${event.id}/cancel`, {
      headers: { 'X-CSRF-TOKEN': token }, data: { version: event.version },
    });
    expect(cancelled.status()).toBe(200);
  }
});
