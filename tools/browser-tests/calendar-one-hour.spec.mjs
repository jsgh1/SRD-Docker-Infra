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
  await expect(page.locator('.sidebar').getByRole('button', { name: 'Home', exact: true })).toBeVisible();
}

test('one-hour reminder arrives through the real scheduler and has a distinct label', async ({ page, browser }) => {
  test.setTimeout(240000);
  await login(page, 'admin');
  const token = (await (await page.request.get('/api/v1/csrf')).json()).data.token;
  const title = `Recordatorio cercano ${Date.now()}`;
  const starts = new Date(Date.now() + 30 * 60000), ends = new Date(starts.getTime() + 3600000);
  const created = await page.request.post('/api/v1/calendar-events', { headers: { 'X-CSRF-TOKEN': token }, data: {
    type: 'meeting', title, starts_at: starts.toISOString().replace(/\.\d{3}Z$/, '+00:00'),
    ends_at: ends.toISOString().replace(/\.\d{3}Z$/, '+00:00'), participants: [fixture.users.viewer.id],
  } });
  expect(created.status()).toBe(200);
  const event = (await created.json()).data;
  const context = await browser.newContext({ baseURL: process.env.SRD_TEST_URL || 'http://localhost:8080' });
  try {
    const viewer = await context.newPage();
    await login(viewer, 'viewer');
    await expect.poll(async () => {
      const notices = (await (await viewer.request.get('/api/v1/notifications')).json()).data;
      return notices.items.filter(item => item.title === title).map(item => item.kind).sort();
    }, { timeout: 90000, intervals: [1000, 2000, 5000] }).toEqual(['invitation', 'reminder_1h', 'reminder_24h']);
    await viewer.getByRole('button', { name: /^Notificaciones/ }).click();
    const inbox = viewer.getByRole('region', { name: 'Bandeja de notificaciones' });
    await expect(inbox.getByText(`Recordatorio de 1 hora: ${title}`, { exact: true })).toBeVisible();
    await expect(inbox.getByText(`Recordatorio de 24 horas: ${title}`, { exact: true })).toBeVisible();
    await expect(inbox.getByText('3 sin leer', { exact: true })).toBeVisible();
    await expect(inbox.getByRole('checkbox', { name: 'Recordatorios de 24 horas y 1 hora', exact: true })).toBeChecked();
    await viewer.screenshot({ path: '.local/calendar-one-hour-desktop.png' });
    await viewer.setViewportSize({ width: 360, height: 800 });
    const reminder = inbox.getByText(`Recordatorio de 1 hora: ${title}`, { exact: true });
    await reminder.scrollIntoViewIfNeeded();
    const bounds = await inbox.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(360);
    expect(await viewer.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await viewer.screenshot({ path: '.local/calendar-one-hour-mobile.png' });
    const preferences = inbox.getByRole('checkbox', { name: 'Recordatorios de 24 horas y 1 hora', exact: true });
    await preferences.scrollIntoViewIfNeeded();
    await viewer.screenshot({ path: '.local/calendar-one-hour-preferences-mobile.png' });
    await preferences.uncheck();
    await inbox.getByRole('button', { name: 'Guardar preferencias' }).click();
    await expect.poll(async () => (await (await viewer.request.get('/api/v1/notification-preferences')).json()).data.reminders).toBe(false);
    expect((await (await viewer.request.get('/api/v1/notifications')).json()).data.unread).toBe(3);
    const admin = (await (await page.request.get('/api/v1/notifications')).json()).data;
    expect(admin.items.filter(item => item.title === title)).toHaveLength(0);
  } finally {
    await context.close();
    const cancelled = await page.request.post(`/api/v1/calendar-events/${event.id}/cancel`, {
      headers: { 'X-CSRF-TOKEN': token }, data: { version: event.version },
    });
    expect(cancelled.status()).toBe(200);
  }
});
