import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const fixture = JSON.parse(readFileSync(process.env.SRD_BROWSER_FIXTURE, 'utf8'));
const mailpit = process.env.SRD_MAILPIT_URL || 'http://localhost:8025';

test('calendar permissions and invitations recover after failed reads', async ({ page }) => {
  test.setTimeout(120000);
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
  const nav = page.locator('.sidebar').getByRole('button', { name: 'Calendario', exact: true });
  await expect(nav).toBeVisible();
  const failOnce = new Set(['calendar-settings', 'calendar-invitations']);
  await page.route('**/api/v1/calendar-*', async route => {
    const path = new URL(route.request().url()).pathname;
    const key = path.endsWith('/calendar-settings') ? 'calendar-settings' : path.endsWith('/calendar-invitations') ? 'calendar-invitations' : '';
    if (key && failOnce.has(key)) {
      failOnce.delete(key);
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Servicio temporalmente no disponible.' } }) });
    } else await route.continue();
  });
  await nav.click();
  await expect(page.getByRole('button', { name: 'Reintentar permisos del calendario' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reintentar invitaciones del calendario' })).toBeVisible();
  await page.getByRole('button', { name: 'Reintentar permisos del calendario' }).click();
  await expect(page.getByRole('button', { name: 'Crear evento' })).toBeVisible();
  await page.getByRole('button', { name: 'Reintentar invitaciones del calendario' }).click();
  await expect(page.getByRole('region', { name: 'Mis invitaciones' })).toBeVisible();
  let failContact = true;
  await page.route('**/api/v1/contacts?*', async route => {
    if (failContact && new URL(route.request().url()).searchParams.get('q') === 'Prueba Viewer') {
      failContact = false;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Integrantes temporalmente no disponibles.' } }) });
    } else await route.continue();
  });
  await page.getByRole('button', { name: 'Crear evento' }).click();
  const form = page.getByRole('dialog', { name: 'Crear evento' });
  await form.getByLabel('Buscar integrante').fill('Prueba Viewer');
  await expect(form.getByRole('button', { name: 'Reintentar integrantes' })).toBeVisible();
  await form.getByRole('button', { name: 'Reintentar integrantes' }).click();
  await expect(form.getByRole('button', { name: 'Añadir a Prueba Viewer' })).toBeVisible();
  await form.getByRole('button', { name: 'Cerrar' }).click();
  const token = (await (await page.request.get('/api/v1/csrf')).json()).data.token;
  const start = new Date(Date.now() + 36 * 3600000), end = new Date(start.getTime() + 3600000);
  const title = `Evento de aviso ${Date.now()}`;
  const created = await page.request.post('/api/v1/calendar-events', { headers: { 'X-CSRF-TOKEN': token }, data: {
    type: 'meeting', title, title_en: 'Notice event', starts_at: start.toISOString().replace(/\.\d{3}Z$/, '+00:00'),
    ends_at: end.toISOString().replace(/\.\d{3}Z$/, '+00:00'), participants: [],
  } });
  expect(created.status()).toBe(200);
  const event = (await created.json()).data;
  await page.route('**/api/v1/notifications?*', route => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ data: { items: [{ id: 'notice-calendar-retry', event_id: event.id, conversation_id: null,
      kind: 'event_changed', title, created_at: new Date().toISOString(), read_at: new Date().toISOString() }],
      page: 1, page_size: 20, total: 1, unread: 0 } }),
  }));
  let failDetail = true;
  await page.route(`**/api/v1/calendar-events/${event.id}`, async route => {
    if (failDetail) { failDetail = false; await route.fulfill({ status: 503, contentType: 'application/json',
      body: JSON.stringify({ error: { message: 'Detalle del evento no disponible.' } }) }); }
    else await route.continue();
  });
  await page.getByRole('button', { name: /^Notificaciones/ }).click();
  await page.getByRole('region', { name: 'Bandeja de notificaciones' }).getByRole('button', { name: new RegExp(title) }).click();
  await expect(page.getByText('Detalle del evento no disponible.')).toBeVisible();
  await page.getByRole('button', { name: 'Reintentar evento' }).click();
  await expect(page.getByRole('dialog', { name: 'Detalle del evento' })).toContainText(title);
  await page.getByRole('dialog', { name: 'Detalle del evento' }).getByRole('button', { name: 'Cerrar' }).click();
  await page.setViewportSize({ width: 320, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(322);
});
