import { test, expect } from '@playwright/test';

test.use({ channel: 'chrome' });

test('privacy requests remain accessible beyond the first page at mobile width', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const items = Array.from({ length: 27 }, (_, index) => ({
    id: `90000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    person_id: '33333333-3333-4333-8333-333333333333', first_names: `Case ${index}`, last_names: 'Person',
    document_number: `TEST-${index}`, kind: index === 26 ? 'erasure' : 'access',
    status: index === 26 ? 'approved_pending_erasure' : 'resolved', summary: `Synthetic request ${index}`,
    decision: null, responsible_id: null, decided_at: null, created_at: '2026-10-12T12:00:00Z', version: 1, history: [],
  }));
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url());
    let data;
    if (url.pathname.endsWith('/me')) data = {
      user_id: '22222222-2222-4222-8222-222222222222', role: 'admin', terms_required: false,
      user: { name: 'Test admin', email: 'admin@example.test', theme: 'light', presence: 'online', language: 'en' },
      organization: { id: '11111111-1111-4111-8111-111111111111', code: 'test', name: 'Test council', accent: '#276065', version: 1,
        terms: { id: '44444444-4444-4444-8444-444444444444', version: 1, body: 'Terms', body_en: 'Terms' } },
    };
    else if (url.pathname.endsWith('/csrf')) data = { token: 'test' };
    else if (url.pathname.endsWith('/privacy-requests')) {
      const current = Number(url.searchParams.get('page') || 1);
      const filtered = items.filter(item => (!url.searchParams.has('kind') || item.kind === url.searchParams.get('kind'))
        && (!url.searchParams.has('status') || item.status === url.searchParams.get('status')));
      data = { items: filtered.slice((current - 1) * 25, current * 25), total: filtered.length, page: current, page_size: 25 };
    }
    await route.fulfill({ status: data === undefined ? 503 : 200, contentType: 'application/json',
      body: JSON.stringify(data === undefined ? { error: { message: 'Unavailable in preview' } } : { data }) });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Privacy requests' });
  await expect(panel.getByText('Case 0 Person')).toBeVisible();
  await expect(panel.getByText('Case 25 Person')).toHaveCount(0);
  await expect(panel.getByText('Page 1 of 2')).toBeVisible();
  await panel.getByRole('button', { name: 'Next requests' }).click();
  await expect(panel.getByText('Case 25 Person')).toBeVisible();
  await expect(panel.getByText('Case 0 Person')).toHaveCount(0);
  await expect(panel.getByText('Page 2 of 2')).toBeVisible();
  await panel.getByLabel('Filter by type').selectOption('erasure');
  await panel.getByLabel('Filter by status').selectOption('approved_pending_erasure');
  await expect(panel.getByText('Case 26 Person')).toBeVisible();
  await expect(panel.getByText('Case 0 Person')).toHaveCount(0);
  await panel.getByLabel('Filter by type').selectOption('access');
  await expect(panel.getByText('No requests match these filters.')).toBeVisible();
  await panel.getByLabel('Filter by type').selectOption('');
  await panel.getByLabel('Filter by status').selectOption('');
  await expect(panel.getByText('Case 0 Person')).toBeVisible();
  await expect(panel.getByText('Page 1 of 2')).toBeVisible();
  await panel.getByRole('button', { name: 'Next requests' }).click();
  await expect(panel.getByText('Case 25 Person')).toBeVisible();
  await panel.getByRole('button', { name: 'Previous requests' }).click();
  await expect(panel.getByText('Case 0 Person')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(errors).toEqual([]);
});

test('privacy list does not show previous filter results after a failed refresh', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  let failFiltered = true;
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url());
    let data;
    if (url.pathname.endsWith('/me')) data = {
      user_id: '22222222-2222-4222-8222-222222222222', role: 'admin', terms_required: false,
      user: { name: 'Test admin', email: 'admin@example.test', theme: 'light', presence: 'online', language: 'en' },
      organization: { id: '11111111-1111-4111-8111-111111111111', code: 'test', name: 'Test council', accent: '#276065', version: 1,
        terms: { id: '44444444-4444-4444-8444-444444444444', version: 1, body: 'Terms', body_en: 'Terms' } },
    };
    else if (url.pathname.endsWith('/csrf')) data = { token: 'test' };
    else if (url.pathname.endsWith('/privacy-requests') && !(url.searchParams.has('kind') && failFiltered)) data = {
      items: [{ id: '90000000-0000-4000-8000-000000000001', person_id: '33333333-3333-4333-8333-333333333333',
        first_names: url.searchParams.has('kind') ? 'New' : 'Old', last_names: 'Result', document_number: 'TEST-1',
        kind: url.searchParams.has('kind') ? 'erasure' : 'access', status: 'open',
        summary: 'Previously loaded request', decision: null, responsible_id: null, decided_at: null,
        created_at: '2026-10-12T12:00:00Z', version: 1, history: [] }], total: 1, page: 1, page_size: 25,
    };
    await route.fulfill({ status: data === undefined ? 503 : 200, contentType: 'application/json',
      body: JSON.stringify(data === undefined ? { error: { message: 'Unavailable in preview' } } : { data }) });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Privacy requests' });
  await expect(panel.getByText('Old Result')).toBeVisible();
  await panel.getByLabel('Filter by type').selectOption('erasure');
  await expect(panel.getByRole('alert')).toBeVisible();
  await expect(panel.getByText('Old Result')).toHaveCount(0);
  await expect(panel.getByText('No requests match these filters.')).toHaveCount(0);
  failFiltered = false;
  await panel.getByRole('button', { name: 'Refresh requests' }).click();
  await expect(panel.getByText('New Result')).toBeVisible();
  await expect(panel.getByRole('alert')).toHaveCount(0);
});
