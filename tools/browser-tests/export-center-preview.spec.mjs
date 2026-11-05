import {test, expect} from '@playwright/test';

test.use({channel: 'chrome'});

const principal = role => ({
  user_id: '00000000-0000-4000-8000-000000000001', role, terms_required: false,
  user: {name: 'Cuenta de prueba', email: 'demo@example.test', theme: 'light', presence: 'online', language: 'en'},
  organization: {id: '00000000-0000-4000-8000-000000000002', code: 'srd-e2e-a', name: 'Junta de prueba', accent: '#276065', version: 1,
    terms: {id: '00000000-0000-4000-8000-000000000003', version: 1, body: 'Términos de prueba', body_en: 'Sample terms'}},
});

async function preview(page, role, section = 'export') {
  const errors = [];
  page.on('pageerror', error => errors.push(error.stack));
  await page.route('**/api/v1/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    const data = pathname.endsWith('/me') ? principal(role)
      : pathname.endsWith('/planilla-settings') ? {logo_data: null}
      : pathname.endsWith('/quick-links') ? {mode: 'common', common_version: 1, personal_version: 1,
        inherited: true, items: [], common_items: [], personal_items: null, catalog: []}
      : pathname.endsWith('/presence/heartbeat') ? {effective: 'online', preference: 'online', ttl_seconds: 90}
      : pathname.endsWith('/dashboard') ? {date: '2026-10-11', generated_at: '2026-10-11T12:00:00Z', total: 0, today: 0, week: 0, month: 0,
        last_seven_days: [], latest: [], gender: [], document_types: []}
      : pathname.endsWith('/treasury') ? {opened: false, balance: '0.00', opening: '0.00', credits: '0.00', debits: '0.00', items: [], total: 0, page: 1, page_size: 25}
      : pathname.endsWith('/notifications') ? {items: [], unread: 0, total: 0, page: 1, page_size: 25}
      : null;
    return route.fulfill({status: data === null ? 503 : 200, contentType: 'application/json',
      body: JSON.stringify(data === null ? {error: {message: 'Servicio de prueba no disponible'}} : {data})});
  });
  await page.goto('/');
  if (page.viewportSize()?.width < 700) await page.getByRole('button', {name: 'Open menu'}).click();
  await page.locator('.sidebar').getByRole('button', {name: section === 'export' ? 'Export' : 'Settings', exact: true}).click();
  return errors;
}

test('export center shows only permitted areas and opens the existing workflow', async ({page}) => {
  test.setTimeout(30000);
  const errors = await preview(page, 'treasurer');
  await expect(page.getByRole('heading', {name: 'Export', exact: true})).toBeVisible();
  await expect(page.getByRole('heading', {name: 'People and signature sheet'})).toBeVisible();
  await expect(page.getByRole('heading', {name: 'Treasury'})).toBeVisible();
  await expect(page.getByRole('heading', {name: 'Inventory'})).toBeVisible();
  await expect(page.getByRole('heading', {name: 'Audit'})).toHaveCount(0);
  await page.getByRole('button', {name: 'Open treasury exports'}).click();
  await expect(page.getByRole('heading', {name: 'Treasury', exact: true})).toBeVisible();
  expect(errors).toEqual([]);
});

test('export center remains usable on a narrow screen for a reader', async ({page}) => {
  test.setTimeout(30000);
  await page.setViewportSize({width: 360, height: 780});
  const errors = await preview(page, 'viewer');
  await expect(page.getByRole('heading', {name: 'People and signature sheet'})).toBeVisible();
  await expect(page.getByRole('heading', {name: 'Treasury'})).toHaveCount(0);
  await expect(page.getByRole('heading', {name: 'Inventory'})).toHaveCount(0);
  await expect(page.getByRole('heading', {name: 'Audit'})).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(2);
  expect(errors).toEqual([]);
});

test('account and council administration show English copy in settings', async ({page}) => {
  test.setTimeout(30000);
  const errors = await preview(page, 'superadmin', 'settings');
  await expect(page.getByRole('heading', {name: 'Sign-in email'})).toBeVisible();
  await expect(page.getByText('We will verify the new address before replacing your current email. You must confirm your password.')).toBeVisible();
  await expect(page.getByRole('heading', {name: 'Council users'})).toBeVisible();
  await expect(page.getByRole('heading', {name: 'Council administration'})).toBeVisible();
  await expect(page.getByRole('heading', {name: 'Platform accounts'})).toBeVisible();
  await expect(page.getByPlaceholder('sample-council')).toBeVisible();
  expect(errors).toEqual([]);
});
