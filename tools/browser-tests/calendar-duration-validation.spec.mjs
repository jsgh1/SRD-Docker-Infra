import { test, expect } from '@playwright/test';

test.use({ channel: 'chrome' });

test('calendar rejects an event longer than seven days before sending and accepts the boundary', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let posts = 0;
  let language = 'es';
  await page.route('**/api/v1/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const endpoint = url.pathname.replace('/api/v1/', '');
    let data = null;
    if (endpoint === 'me') data = {
      user_id: '22222222-2222-4222-8222-222222222222', role: 'admin', terms_required: false,
      user: { name: 'Test admin', email: 'admin@example.test', theme: 'light', presence: 'online', language },
      organization: { id: '11111111-1111-4111-8111-111111111111', code: 'test', name: 'Junta de prueba', accent: '#276065', version: 1,
        terms: { id: '66666666-6666-4666-8666-666666666666', version: 1, body: 'Términos', body_en: 'Terms' } },
    };
    else if (endpoint === 'csrf') data = { token: 'test' };
    else if (endpoint === 'calendar-settings') data = { version: 1, editor_roles: [], can_manage: true, can_edit: true };
    else if (endpoint === 'calendar-invitations') data = { items: [], page: 1, page_size: 25, total: 0 };
    else if (endpoint === 'calendar-events' && request.method() === 'GET') data = { items: [] };
    else if (endpoint === 'calendar-events' && request.method() === 'POST') {
      posts++;
      const body = request.postDataJSON();
      expect(body.starts_at).toBe('2030-01-10T09:00:00-05:00');
      expect(body.ends_at).toBe('2030-01-17T09:00:00-05:00');
      data = { id: '77777777-7777-4777-8777-777777777777', ...body, cancelled_at: null,
        state: 'scheduled', version: 1, participants: [] };
    } else if (endpoint === 'contacts') data = { items: [] };
    await route.fulfill({ status: data === null ? 503 : 200, contentType: 'application/json',
      body: JSON.stringify(data === null ? { error: { message: 'Not used in this test' } } : { data }) });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Abrir menú' }).click();
  await page.locator('.sidebar').getByRole('button', { name: 'Calendario', exact: true }).click();
  await page.getByRole('button', { name: 'Crear evento' }).click();
  const form = page.getByRole('dialog', { name: 'Crear evento' });
  await form.getByLabel('Título', { exact: true }).fill('Reunión de duración');
  await form.getByLabel('Título (EN)').fill('Duration meeting');
  await form.getByLabel('Inicio', { exact: true }).fill('2030-01-10T09:00');
  await form.getByLabel('Final', { exact: true }).fill('2030-01-17T09:01');
  await form.getByRole('button', { name: 'Guardar evento' }).click();
  await expect(form.getByRole('alert')).toContainText('El evento no puede durar más de siete días.');
  expect(posts).toBe(0);
  await form.getByLabel('Final', { exact: true }).fill('2030-01-17T09:00');
  await form.getByRole('button', { name: 'Guardar evento' }).click();
  await expect(form).toHaveCount(0);
  expect(posts).toBe(1);
  language = 'en';
  await page.reload();
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.locator('.sidebar').getByRole('button', { name: 'Calendar', exact: true }).click();
  await page.getByRole('button', { name: 'Create event' }).click();
  const englishForm = page.getByRole('dialog', { name: 'Create event' });
  await englishForm.getByLabel('Title', { exact: true }).fill('Duration meeting');
  await englishForm.getByLabel('Title (EN)').fill('Duration meeting');
  await englishForm.getByLabel('Start', { exact: true }).fill('2030-01-10T09:00');
  await englishForm.getByLabel('End', { exact: true }).fill('2030-01-17T09:01');
  await englishForm.getByRole('button', { name: 'Save event' }).click();
  await expect(englishForm.getByRole('alert')).toContainText('The event cannot last more than seven days.');
  expect(posts).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
