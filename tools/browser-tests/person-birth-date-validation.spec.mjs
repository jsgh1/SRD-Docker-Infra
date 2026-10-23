import { test, expect } from '@playwright/test';

test.use({ channel: 'chrome' });

function bogotaToday() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

test('person birth date follows the Bogota calendar before submission', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let posts = 0;
  await page.route('**/api/v1/**', async route => {
    const request = route.request();
    const endpoint = new URL(request.url()).pathname.replace('/api/v1/', '');
    let data = null;
    if (endpoint === 'me') data = {
      user_id: '22222222-2222-4222-8222-222222222222', role: 'admin', terms_required: false,
      user: { name: 'Test admin', email: 'admin@example.test', theme: 'light', presence: 'online', language: 'es' },
      organization: { id: '11111111-1111-4111-8111-111111111111', code: 'test', name: 'Junta de prueba', accent: '#276065', version: 1,
        terms: { id: '66666666-6666-4666-8666-666666666666', version: 1, body: 'Términos', body_en: 'Terms' } },
    };
    else if (endpoint === 'person-fields') data = { version: 1, fields: [] };
    else if (endpoint === 'person-positions') data = { version: 1, items: [] };
    else if (endpoint === 'csrf') data = { token: 'test' };
    else if (endpoint === 'persons' && request.method() === 'GET') data = { items: [], page: 1, page_size: 25, total: 0 };
    else if (endpoint === 'persons' && request.method() === 'POST') { posts++; data = { id: 'test' }; }
    await route.fulfill({ status: data === null ? 503 : 200, contentType: 'application/json',
      body: JSON.stringify(data === null ? { error: { message: 'Not used in this test' } } : { data }) });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Abrir menú' }).click();
  await page.locator('.sidebar').getByRole('button', { name: 'Registro', exact: true }).click();
  const birthDate = page.getByLabel('Fecha de nacimiento');
  const today = bogotaToday();
  const tomorrow = new Date(Date.parse(`${today}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
  await expect(birthDate).toHaveAttribute('max', today);
  await page.getByRole('combobox', { name: /Tipo de documento/ }).selectOption('CC');
  await page.getByLabel('Número de documento').fill('TEST-BIRTH-DATE');
  await page.getByLabel('Nombres', { exact: false }).fill('Persona de prueba');
  await page.getByLabel('Fundamento o referencia del soporte').fill('Prueba de interfaz');
  await page.getByLabel('Finalidad de la captura').fill('Comprobar fecha de nacimiento');
  await birthDate.fill(tomorrow);
  expect(await birthDate.evaluate(input => input.validity.rangeOverflow)).toBe(true);
  await page.getByRole('button', { name: 'Guardar registro', exact: true }).click();
  expect(posts).toBe(0);
  await birthDate.fill(today);
  expect(await birthDate.evaluate(input => input.validity.rangeOverflow)).toBe(false);
  await page.getByRole('button', { name: 'Guardar registro', exact: true }).click();
  await expect.poll(() => posts).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
