import { test, expect } from '@playwright/test';
import fs from 'node:fs';

const fixture = JSON.parse(fs.readFileSync(process.env.SRD_BROWSER_FIXTURE));
const mailUrl = process.env.SRD_MAILPIT_URL || 'http://localhost:8025';

test('notification inbox and preferences use the saved English event title', async ({ page }) => {
  await page.goto(`/j/${fixture.codeA}/login`);
  await page.getByLabel('Correo electrónico', { exact: true }).fill(fixture.users.viewer.email);
  await page.getByLabel('Contraseña', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: 'términos y condiciones' }).click();
  await page.getByRole('button', { name: 'Aceptar términos' }).click();
  await page.getByRole('button', { name: 'Ingresar', exact: true }).click();
  let message;
  await expect.poll(async () => {
    const list = await (await page.request.get(`${mailUrl}/api/v1/messages`)).json();
    message = list.messages?.find(item => item.Subject === 'Tu código de seguridad de SRD' && item.To.some(to => to.Address === fixture.users.viewer.email));
    return Boolean(message);
  }, { timeout: 85000 }).toBe(true);
  const content = await (await page.request.get(`${mailUrl}/api/v1/message/${message.ID}`)).json();
  await page.getByLabel('Código de verificación').fill(content.Text.match(/\b\d{6}\b/)[0]);
  await page.getByRole('button', { name: 'Confirmar código' }).click();
  await expect(page.locator('.sidebar').getByRole('button', { name: 'Home', exact: true })).toBeVisible();

  const title = 'Asamblea de prueba de la junta';
  const titleEn = 'Council test meeting';
  await page.route('**/api/v1/notifications?*', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ data: { items: [{ id: 'notice-1', event_id: 'event-1', conversation_id: null,
      kind: 'event_changed', title, title_en: titleEn, created_at: new Date(Date.now() - 2 * 3600000).toISOString(), read_at: null }],
      page: 1, page_size: 20, total: 1, unread: 1 } }),
  }));
  await page.route('**/api/v1/notification-preferences', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ data: { event_changes: true, reminders: true, chat_messages: true,
      quiet_start: null, quiet_end: null } }),
  }));
  await page.getByRole('button', { name: /^Notificaciones/ }).click();
  const spanish = page.getByRole('region', { name: 'Bandeja de notificaciones' });
  await expect(spanish).toContainText('Cambió el evento');
  await expect(spanish).toContainText(title);
  await expect(spanish.getByText('Preferencias de avisos')).toBeVisible();
  await spanish.getByRole('button', { name: 'Cerrar' }).click();

  await page.locator('.profile-trigger').click();
  await page.getByLabel('Idioma', { exact: true }).selectOption('en');
  await expect(page.getByRole('button', { name: 'Notifications, 1 unread' })).toBeVisible();
  await page.getByRole('button', { name: 'Notifications, 1 unread' }).click();
  const english = page.getByRole('region', { name: 'Notification inbox' });
  await expect(english).toContainText('The event changed');
  await expect(english).toContainText(titleEn);
  await expect(english).not.toContainText(title);
  await expect(english).toContainText('2 hours ago');
  await expect(english.getByRole('heading', { name: 'Notice preferences' })).toBeVisible();
  await expect(english.getByText('Event change notices')).toBeVisible();
  await expect(english.getByText('Enable quiet hours')).toBeVisible();
  await page.setViewportSize({ width: 360, height: 800 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(2);
});
