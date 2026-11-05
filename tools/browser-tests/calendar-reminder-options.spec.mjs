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

function inputDate(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date).map(part => [part.type, part.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

test('event reminder choices persist and the real scheduler respects each selection', async ({ page, browser }) => {
  test.setTimeout(300000);
  await login(page, 'admin');
  const title = `Anticipación elegida ${Date.now()}`;
  let eventId;
  const context = await browser.newContext({ baseURL: process.env.SRD_TEST_URL || 'http://localhost:8080' });
  try {
    await page.locator('.sidebar').getByRole('button', { name: 'Calendario', exact: true }).click();
    await page.getByRole('button', { name: 'Crear evento', exact: true }).click();
    let form = page.getByRole('dialog', { name: 'Crear evento' });
    await expect(form.getByRole('checkbox', { name: '24 horas antes', exact: true })).toBeChecked();
    await expect(form.getByRole('checkbox', { name: '1 hora antes', exact: true })).toBeChecked();
    await form.getByLabel('Título', { exact: true }).fill(title);
    await form.getByLabel('Título (EN)').fill(`Reminder test ${Date.now()}`);
    const start = new Date(Date.now() + 30 * 60000), end = new Date(start.getTime() + 3600000);
    await form.getByLabel('Inicio', { exact: true }).fill(inputDate(start));
    await form.getByLabel('Final', { exact: true }).fill(inputDate(end));
    await form.getByRole('checkbox', { name: '24 horas antes', exact: true }).uncheck();
    await form.getByLabel('Buscar integrante', { exact: true }).fill('Prueba Viewer');
    await form.getByRole('button', { name: 'Añadir a Prueba Viewer', exact: true }).click();
    const choices = form.locator('.calendar-reminders');
    await choices.scrollIntoViewIfNeeded();
    await page.screenshot({ path: '.local/calendar-reminder-options-desktop.png' });
    await page.setViewportSize({ width: 360, height: 800 });
    await choices.scrollIntoViewIfNeeded();
    const bounds = await choices.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(360);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await page.screenshot({ path: '.local/calendar-reminder-options-mobile.png' });
    await form.getByRole('button', { name: 'Guardar evento', exact: true }).click();
    let detail = page.getByRole('dialog', { name: 'Detalle del evento' });
    await expect(detail.getByText('Recordatorios del evento: 1 hora', { exact: true })).toBeVisible();
    eventId = (await (await page.request.get(`/api/v1/calendar-events/search?${new URLSearchParams({ q: title })}`)).json()).data.items[0].id;
    const viewer = await context.newPage();
    await login(viewer, 'viewer');
    const kinds = async () => (await (await viewer.request.get('/api/v1/notifications')).json()).data.items.filter(item => item.title === title).map(item => item.kind).sort();
    await expect.poll(kinds, { timeout: 90000, intervals: [1000, 2000, 5000] }).toEqual(['invitation', 'reminder_1h']);
    await page.setViewportSize({ width: 1280, height: 720 });
    await detail.getByRole('button', { name: 'Editar', exact: true }).click();
    form = page.getByRole('dialog', { name: 'Editar evento' });
    await expect(form.getByRole('checkbox', { name: '24 horas antes', exact: true })).not.toBeChecked();
    await expect(form.getByRole('checkbox', { name: '1 hora antes', exact: true })).toBeChecked();
    await form.getByRole('checkbox', { name: '1 hora antes', exact: true }).uncheck();
    await form.getByRole('button', { name: 'Guardar evento', exact: true }).click();
    await expect(detail.getByText('Recordatorios del evento: Ninguno', { exact: true })).toBeVisible();
    await expect.poll(async () => (await kinds()).filter(kind => kind === 'event_changed').length, { timeout: 90000, intervals: [1000, 2000, 5000] }).toBe(1);
    await detail.getByRole('button', { name: 'Cerrar', exact: true }).click();
    await page.reload();
    await page.locator('.sidebar').getByRole('button', { name: 'Calendario', exact: true }).click();
    await page.getByRole('button', { name: 'Agenda', exact: true }).click();
    await page.locator('.calendar-agenda .calendar-event').filter({ hasText: title }).first().click();
    await expect(detail.getByText('Recordatorios del evento: Ninguno', { exact: true })).toBeVisible();
    await detail.getByRole('button', { name: 'Editar', exact: true }).click();
    await form.getByRole('checkbox', { name: '24 horas antes', exact: true }).check();
    const newStart = new Date(Date.now() + 2 * 3600000), newEnd = new Date(newStart.getTime() + 3600000);
    await form.getByLabel('Inicio', { exact: true }).fill(inputDate(newStart));
    await form.getByLabel('Final', { exact: true }).fill(inputDate(newEnd));
    await form.getByRole('button', { name: 'Guardar evento', exact: true }).click();
    await expect(detail.getByText('Recordatorios del evento: 24 horas', { exact: true })).toBeVisible();
    await expect.poll(async () => (await kinds()).filter(kind => kind === 'reminder_24h').length, { timeout: 90000, intervals: [1000, 2000, 5000] }).toBe(1);
    expect((await kinds()).filter(kind => kind === 'reminder_1h')).toHaveLength(1);
  } finally {
    await context.close();
    if (eventId) {
      const current = (await (await page.request.get(`/api/v1/calendar-events/${eventId}`)).json()).data;
      const token = (await (await page.request.get('/api/v1/csrf')).json()).data.token;
      const response = await page.request.post(`/api/v1/calendar-events/${eventId}/cancel`, { headers: { 'X-CSRF-TOKEN': token }, data: { version: current.version } });
      expect(response.status()).toBe(200);
    }
  }
});
