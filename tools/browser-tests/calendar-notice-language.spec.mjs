import { test, expect } from '@playwright/test';
import fs from 'node:fs';

const fixture = JSON.parse(fs.readFileSync(process.env.SRD_BROWSER_FIXTURE));
const mailUrl = process.env.SRD_MAILPIT_URL || 'http://127.0.0.1:8025';

async function login(page, role) {
  await page.goto(`/j/${fixture.codeA}/login`);
  await page.getByLabel('Correo electrónico', { exact: true }).fill(fixture.users[role].email);
  await page.getByLabel('Contraseña', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: 'términos y condiciones' }).click();
  await page.getByRole('button', { name: 'Aceptar términos' }).click();
  const started = Date.now();
  await page.getByRole('button', { name: 'Ingresar', exact: true }).click();
  let message;
  await expect.poll(async () => {
    const list = await (await page.request.get(`${mailUrl}/api/v1/messages`)).json();
    message = list.messages?.filter(item => item.Subject === 'Tu código de seguridad de SRD'
      && item.To.some(to => to.Address === fixture.users[role].email) && Date.parse(item.Created) >= started - 5000)
      .sort((a, b) => Date.parse(b.Created) - Date.parse(a.Created))[0];
    return Boolean(message);
  }, { timeout: 85000 }).toBe(true);
  const content = await (await page.request.get(`${mailUrl}/api/v1/message/${message.ID}`)).json();
  await page.getByLabel('Código de verificación').fill(content.Text.match(/\b\d{6}\b/)[0]);
  await page.getByRole('button', { name: 'Confirmar código' }).click();
  await expect(page.locator('.sidebar').getByRole('button', { name: 'Home', exact: true })).toBeVisible();
}

test('real calendar delivery keeps both event titles and notice preferences persist', async ({ page, browser }) => {
  test.setTimeout(180000);
  await login(page, 'admin');
  const viewerContext = await browser.newContext({ baseURL: process.env.SRD_TEST_URL || 'http://127.0.0.1:8080' });
  let created;
  try {
    const viewer = await viewerContext.newPage();
    await login(viewer, 'viewer');
    await viewer.locator('.profile-trigger').click();
    await viewer.getByLabel('Idioma', { exact: true }).selectOption('en');
    await viewer.locator('.profile-trigger').click();

    const token = (await (await page.request.get('/api/v1/csrf')).json()).data.token;
    const suffix = Date.now();
    const title = `Invitación bilingüe ${suffix}`;
    const titleEn = `Bilingual invitation ${suffix}`;
    const starts = new Date(Date.now() + 48 * 3600000);
    const ends = new Date(starts.getTime() + 3600000);
    const withOffset = value => value.toISOString().replace(/\.\d{3}Z$/, '+00:00');
    const response = await page.request.post('/api/v1/calendar-events', { headers: { 'X-CSRF-TOKEN': token }, data: {
      type: 'meeting', title, title_en: titleEn, starts_at: withOffset(starts), ends_at: withOffset(ends),
      participants: [fixture.users.viewer.id], remind_24h: false, remind_1h: false,
    } });
    expect(response.status()).toBe(200);
    created = (await response.json()).data;

    await expect.poll(async () => {
      const result = await viewer.request.get('/api/v1/notifications');
      const inbox = (await result.json()).data;
      return inbox.items.find(item => item.event_id === created.id && item.kind === 'invitation');
    }, { timeout: 90000, intervals: [1000, 2000, 5000] }).toMatchObject({ title, title_en: titleEn });

    await viewer.getByRole('button', { name: /^Notifications/ }).click();
    let inbox = viewer.getByRole('region', { name: 'Notification inbox' });
    await expect(inbox).toContainText(titleEn);
    await expect(inbox).not.toContainText(title);
    await inbox.getByRole('checkbox', { name: 'Event change notices' }).uncheck();
    await inbox.getByRole('button', { name: 'Save preferences' }).click();
    await expect.poll(async () => (await (await viewer.request.get('/api/v1/notification-preferences')).json()).data.event_changes).toBe(false);
    await viewer.reload();
    await viewer.getByRole('button', { name: /^Notifications/ }).click();
    inbox = viewer.getByRole('region', { name: 'Notification inbox' });
    await expect(inbox.getByRole('checkbox', { name: 'Event change notices' })).not.toBeChecked();
    await expect(inbox).toContainText(titleEn);
    await viewer.setViewportSize({ width: 360, height: 800 });
    await expect.poll(() => viewer.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(2);
  } finally {
    await viewerContext.close();
    if (created) {
      const token = (await (await page.request.get('/api/v1/csrf')).json()).data.token;
      const response = await page.request.post(`/api/v1/calendar-events/${created.id}/cancel`, {
        headers: { 'X-CSRF-TOKEN': token }, data: { version: created.version },
      });
      expect(response.status()).toBe(200);
    }
  }
});
