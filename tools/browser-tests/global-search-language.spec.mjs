import { test, expect } from '@playwright/test';
import fs from 'node:fs';

const fixture = JSON.parse(fs.readFileSync(process.env.SRD_BROWSER_FIXTURE));
const mailUrl = process.env.SRD_MAILPIT_URL || 'http://localhost:8025';

test('global search and council asset results follow ES/EN preference', async ({ page }) => {
  await page.goto(`/j/${fixture.codeA}/login`);
  await page.getByLabel('Correo electrónico', { exact: true }).fill(fixture.users.admin.email);
  await page.getByLabel('Contraseña', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: 'términos y condiciones' }).click();
  await page.getByRole('button', { name: 'Aceptar términos' }).click();
  const loginStarted = Date.now();
  await page.getByRole('button', { name: 'Ingresar', exact: true }).click();
  let message;
  await expect.poll(async () => {
    const list = await (await page.request.get(`${mailUrl}/api/v1/messages`)).json();
    message = list.messages?.filter(item => item.Subject === 'Tu código de seguridad de SRD' && item.To.some(to => to.Address === fixture.users.admin.email) && Date.parse(item.Created) >= loginStarted - 5000)
      .sort((a, b) => Date.parse(b.Created) - Date.parse(a.Created))[0];
    return Boolean(message);
  }, { timeout: 85000 }).toBe(true);
  const content = await (await page.request.get(`${mailUrl}/api/v1/message/${message.ID}`)).json();
  await page.getByLabel('Código de verificación').fill(content.Text.match(/\b\d{6}\b/)[0]);
  await page.getByRole('button', { name: 'Confirmar código' }).click();
  await expect(page.locator('.sidebar').getByRole('button', { name: 'Home', exact: true })).toBeVisible();

  const code = `SEARCH-EN-${Date.now().toString().slice(-8)}`;
  const token = (await (await page.request.get('/api/v1/csrf')).json()).data.token;
  const created = await page.request.post('/api/v1/assets', { headers: { 'X-CSRF-TOKEN': token }, data: {
    code, type: 'movable', name: 'Sillas de prueba', name_en: 'Test chairs',
    category: 'Mobiliario', category_en: 'Furniture', unit: 'unidad', unit_en: 'unit',
    location: 'Salón principal', location_en: 'Main hall', condition: 'Bueno', condition_en: 'Good',
    quantity: 2, idempotency_key: crypto.randomUUID(),
  } });
  expect(created.status()).toBe(200);

  await page.locator('.profile-trigger').click();
  await page.getByLabel('Idioma', { exact: true }).selectOption('en');
  await page.getByRole('button', { name: 'Search this council', exact: true }).click();
  const form = page.getByRole('form', { name: 'Council search' });
  await form.getByLabel('Search in').selectOption('assets');
  await form.getByLabel('Search text').fill(code);
  await form.getByRole('button', { name: 'Search', exact: true }).click();
  const assets = page.getByRole('region', { name: 'Asset results' });
  const row = assets.getByRole('row').filter({ hasText: code });
  await expect(row).toContainText('Test chairs');
  await expect(row).toContainText('Main hall');
  await expect(row).not.toContainText('Sillas de prueba');
  await row.getByRole('button', { name: `View asset ${code}` }).click();
  const detail = page.getByRole('dialog', { name: new RegExp(code) });
  await expect(detail).toContainText('Furniture');
  await expect(detail).toContainText('Good');
  await detail.getByRole('button', { name: 'Close' }).click();
  await page.setViewportSize({ width: 360, height: 800 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(2);
  await page.setViewportSize({ width: 1280, height: 800 });

  for (const [scope, endpoint, region, empty] of [
    ['calendar', 'calendar-events/search', 'Calendar results', 'No calendar matches'],
    ['treasury', 'treasury', 'Treasury results', 'No treasury matches'],
    ['files', 'folder-documents/search', 'File results', 'No file matches'],
  ]) {
    await page.route(`**/api/v1/${endpoint}?*`, route => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ data: { items: [], total: 0, page_size: 25 } }),
    }));
    await form.getByLabel('Search in').selectOption(scope);
    await form.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page.getByRole('region', { name: region }).getByText(empty)).toBeVisible();
    if (scope === 'calendar') {
      const event = { id: 'mock-event', title: 'Asamblea de la junta', title_en: 'Council assembly', type: 'meeting',
        starts_at: '2020-01-01T10:00:00Z', ends_at: '2020-01-01T11:00:00Z',
        location: 'Salón comunal', location_en: 'Community hall',
        description: 'Texto redactado por la junta', description_en: 'Council authored text',
        cancelled_at: null, remind_24h: true, remind_1h: false, state: 'finished',
        participants: [{ name: 'Participante de prueba', response: 'accepted' }] };
      await page.route('**/api/v1/calendar-events/search?*', route => route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ data: { items: [event], total: 1, page_size: 25 } }),
      }));
      await page.route('**/api/v1/calendar-events/mock-event', route => route.fulfill({
        status: 200, contentType: 'application/json', body: JSON.stringify({ data: event }),
      }));
      await form.getByRole('button', { name: 'Search', exact: true }).click();
      const calendar = page.getByRole('region', { name: 'Calendar results' });
      await expect(calendar.getByRole('row').filter({ hasText: event.title_en })).toContainText('Meeting');
      await expect(calendar.getByRole('row').filter({ hasText: event.title_en })).toContainText('Finished');
      await calendar.getByRole('button', { name: `View event ${event.title_en}` }).click();
      const eventDetail = page.getByRole('dialog', { name: 'Event details' });
      await expect(eventDetail).toContainText('Accepted');
      await expect(eventDetail).toContainText('Council authored text');
      await expect(eventDetail).toContainText('Community hall');
      await eventDetail.getByRole('button', { name: 'Close' }).click();
    }
  }

  await page.locator('.profile-trigger').click();
  await page.getByLabel('Language', { exact: true }).selectOption('es');
  await page.locator('.profile-trigger').click();
  const spanishForm = page.getByRole('form', { name: 'Búsqueda de la junta' });
  await spanishForm.getByLabel('Buscar en').selectOption('assets');
  await spanishForm.getByRole('button', { name: 'Buscar', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Resultados de bienes' }).getByRole('row').filter({ hasText: code })).toContainText('Sillas de prueba');
});
