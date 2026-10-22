import { test, expect } from '@playwright/test';

test.use({ channel: 'chrome' });

test('a late person search cannot replace the current privacy request selection', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let delayedRoute;
  let releaseDelayed;
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
    else if (url.pathname.endsWith('/privacy-requests')) data = { items: [], total: 0, page: 1, page_size: 25 };
    else if (url.pathname.endsWith('/persons')) {
      if (url.searchParams.get('q') === 'Ana') {
        delayedRoute = route;
        await new Promise(resolve => { releaseDelayed = resolve; });
        return;
      }
      data = { items: url.searchParams.get('q') === 'Nada' ? [] :
        [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', first_names: 'Bea', last_names: 'Prueba', document_number: 'BEA-001' }] };
    }
    await route.fulfill({ status: data === undefined ? 503 : 200, contentType: 'application/json',
      body: JSON.stringify(data === undefined ? { error: { message: 'Unavailable in preview' } } : { data }) });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Privacy requests' });
  const search = panel.getByLabel('Find person by name or ID');
  await search.fill('Ana');
  await panel.getByRole('button', { name: 'Search', exact: true }).click();
  await expect.poll(() => Boolean(delayedRoute)).toBe(true);
  await search.fill('Bea');
  await panel.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(panel.getByRole('button', { name: /Bea Prueba/ })).toBeVisible();
  await delayedRoute.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: {
    items: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', first_names: 'Ana', last_names: 'Vieja', document_number: 'ANA-001' }],
  } }) });
  releaseDelayed();
  await expect(panel.getByRole('button', { name: /Ana Vieja/ })).toHaveCount(0);
  await panel.getByRole('button', { name: /Bea Prueba/ }).click();
  await expect(panel.getByText(/Selected person: Bea Prueba/)).toBeVisible();
  await search.fill('Otra');
  await expect(panel.getByRole('button', { name: /Bea Prueba/ })).toHaveCount(0);
  await expect(panel.getByText(/Selected person: Bea Prueba/)).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Record request' })).toBeDisabled();
  await search.fill('N');
  await expect(panel.getByRole('button', { name: 'Search', exact: true })).toBeDisabled();
  await search.fill('Nada');
  await panel.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(panel.getByText('No people found for that search.')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(errors).toEqual([]);
});
