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

test('calendar uses a 24-hour upcoming window and shows states in agenda', async ({ page }) => {
  await login(page);
  const token = (await (await page.request.get('/api/v1/csrf')).json()).data.token;
  const events = [];
  try {
    for (const [hours, state, label] of [[30, 'scheduled', 'Programado'], [6, 'upcoming', 'Próximo'], [12, 'cancelled', 'Cancelado']]) {
      const title = `Estado ${label} ${Date.now()}`;
      const start = new Date(Date.now() + hours * 3600000);
      const end = new Date(start.getTime() + 3600000);
      const response = await page.request.post('/api/v1/calendar-events', { headers: { 'X-CSRF-TOKEN': token }, data: {
        type: 'meeting', title, starts_at: start.toISOString().replace(/\.\d{3}Z$/, '+00:00'),
        ends_at: end.toISOString().replace(/\.\d{3}Z$/, '+00:00'), participants: [],
      } });
      expect(response.status()).toBe(200);
      const event = (await response.json()).data;
      events.push({ ...event, title, expected: state, label });
      if (state === 'cancelled') {
        const cancelled = await page.request.post(`/api/v1/calendar-events/${event.id}/cancel`, {
          headers: { 'X-CSRF-TOKEN': token }, data: { version: event.version },
        });
        expect(cancelled.status()).toBe(200);
        events.at(-1).cancelled = true;
      } else expect(event.state).toBe(state);
      expect((await (await page.request.get(`/api/v1/calendar-events/${event.id}`)).json()).data.state).toBe(state);
      const search = await page.request.get(`/api/v1/calendar-events/search?${new URLSearchParams({ q: title })}`);
      expect((await search.json()).data.items[0].state).toBe(state);
    }
    await page.locator('.sidebar').getByRole('button', { name: 'Calendario', exact: true }).click();
    await page.getByRole('button', { name: 'Agenda', exact: true }).click();
    for (const event of events) {
      const button = page.locator('.calendar-agenda .calendar-event').filter({ hasText: event.title }).first();
      await expect(button.locator('.calendar-event-state')).toHaveText(event.label);
      await button.click();
      const detail = page.getByRole('dialog', { name: 'Detalle del evento' });
      await expect(detail.getByText(`Estado: ${event.label}`, { exact: true })).toBeVisible();
      await detail.getByRole('button', { name: 'Cerrar', exact: true }).click();
    }
    const refreshed = page.waitForResponse(response => response.url().includes('/api/v1/calendar-events?') && response.request().method() === 'GET');
    await page.getByRole('button', { name: 'Actualizar calendario', exact: true }).click();
    expect((await refreshed).status()).toBe(200);
    for (const event of events) await expect(page.locator('.calendar-agenda .calendar-event').filter({ hasText: event.title }).first().locator('.calendar-event-state')).toHaveText(event.label);
    await page.screenshot({ path: '.local/calendar-states-desktop.png' });
    await page.setViewportSize({ width: 360, height: 800 });
    const scheduled = page.locator('.calendar-agenda .calendar-event').filter({ hasText: events[0].title }).first();
    await scheduled.scrollIntoViewIfNeeded();
    await expect(scheduled.locator('.calendar-event-state')).toBeVisible();
    const bounds = await scheduled.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(360);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await page.screenshot({ path: '.local/calendar-states-mobile.png' });
  } finally {
    for (const event of events.filter(event => !event.cancelled)) {
      const response = await page.request.post(`/api/v1/calendar-events/${event.id}/cancel`, {
        headers: { 'X-CSRF-TOKEN': token }, data: { version: event.version },
      });
      expect(response.status()).toBe(200);
    }
  }
});
