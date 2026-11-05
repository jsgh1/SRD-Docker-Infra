import { test, expect } from '@playwright/test';
import fs from 'node:fs';

test.use({ channel: 'chrome' });

const logo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lZkAAAAASUVORK5CYII=';

test('audit PDF uses the current council logo and still downloads without one', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let configuredLogo = logo;
  await page.route('**/api/v1/**', async route => {
    const endpoint = new URL(route.request().url()).pathname.replace('/api/v1/', '');
    let data = null;
    if (endpoint === 'me') data = {
      user_id: '22222222-2222-4222-8222-222222222222', role: 'admin', terms_required: false,
      user: { name: 'Test admin', email: 'admin@example.test', theme: 'light', presence: 'online', language: 'es' },
      organization: { id: '11111111-1111-4111-8111-111111111111', code: 'test', name: 'Junta de prueba', accent: '#276065', version: 1,
        terms: { id: '66666666-6666-4666-8666-666666666666', version: 1, body: 'Términos', body_en: 'Terms' } },
    };
    else if (endpoint === 'planilla-settings') data = { logo_data: configuredLogo };
    else if (endpoint === 'audit-events') data = { items: [], total: 0, page: 1, page_size: 25 };
    else if (endpoint === 'audit-events/export-pdf') data = {
      filename: 'auditoria.pdf', date: '2026-10-13', count: 0,
      headers: Array.from({ length: 8 }, (_, index) => `Columna ${index}`), rows: [],
    };
    await route.fulfill({ status: data === null ? 503 : 200, contentType: 'application/json',
      body: JSON.stringify(data === null ? { error: { message: 'Not used in this test' } } : { data }) });
  });

  for (const withLogo of [true, false]) {
    configuredLogo = withLogo ? logo : null;
    await page.goto('/');
    await expect(page.locator('.brand-mark-logo img')).toHaveCount(withLogo ? 1 : 0);
    await page.getByRole('button', { name: 'Abrir menú' }).click();
    await page.locator('.sidebar').getByRole('button', { name: 'Auditoría', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Exportar PDF' })).toBeEnabled();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Exportar PDF' }).click();
    const pdf = fs.readFileSync(await (await download).path());
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.includes(Buffer.from('/Subtype /Image'))).toBe(withLogo);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  expect(errors).toEqual([]);
});
