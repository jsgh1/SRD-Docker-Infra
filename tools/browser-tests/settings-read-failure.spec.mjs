import { test, expect } from '@playwright/test';

test('settings replaces failed reads with errors and usable retries', async ({ page }) => {
  test.setTimeout(60000);
  await page.setViewportSize({ width: 320, height: 800 });
  let recover = false;
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const data = path.endsWith('/me') ? {
      user_id: '22222222-2222-4222-8222-222222222222', role: 'superadmin', terms_required: false,
      user: { name: 'Test admin', email: 'admin@example.test', theme: 'dark', presence: 'online', language: 'en' },
      organization: { id: '11111111-1111-4111-8111-111111111111', code: 'test', name: 'Test council',
        accent: '#276065', version: 1, terms: { id: '44444444-4444-4444-8444-444444444444',
          version: 1, body: 'Terms', body_en: 'Terms' } },
    } : path.endsWith('/csrf') ? { token: 'test' }
      : path.endsWith('/system/schedulers') || path.endsWith('/system/audit-deliveries') ? { items: [] }
        : path.endsWith('/system/calendar-deliveries') ? { exhausted: 0 }
          : path.endsWith('/system/mail-deliveries') ? { invitations: { exhausted: 0 }, security_notices: { exhausted: 0 } }
            : recover && path.endsWith('/platform/organizations') ? { data: [], current_page: 1, last_page: 1 }
              : recover && path.endsWith('/platform/accounts') ? { items: [], total: 0, page: 1, page_size: 25 }
                : recover && (path.endsWith('/members') || path.endsWith('/invitations'))
                  ? { items: [], total: 0, page: 1, page_size: 25 } : undefined;
    await route.fulfill({ status: data ? 200 : 503, contentType: 'application/json',
      body: JSON.stringify(data ? { data } : { error: { message: 'Unavailable in preview' } }) });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.locator('.sidebar nav').getByRole('button', { name: 'Settings' }).click();
  const users = page.locator('.panel').filter({ has: page.getByRole('heading', { name: 'Council users' }) });
  const councils = page.locator('.panel').filter({ has: page.getByRole('heading', { name: 'Council administration' }) });
  const accounts = page.locator('.panel').filter({ has: page.getByRole('heading', { name: 'Platform accounts' }) });
  for (const panel of [users, councils, accounts]) await expect(panel.getByRole('alert')).toBeVisible();
  await expect(page.locator('main .loading')).toHaveCount(0);
  for (const [panel, name] of [[users, 'Refresh members'], [councils, 'Refresh councils'], [accounts, 'Refresh accounts']]) {
    await expect(panel.getByRole('button', { name })).toBeVisible();
  }
  recover = true;
  await councils.getByRole('button', { name: 'Refresh councils' }).click();
  await accounts.getByRole('button', { name: 'Refresh accounts' }).click();
  await users.getByRole('button', { name: 'Refresh members' }).click();
  for (const panel of [users, councils, accounts]) await expect(panel.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('main .loading')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  expect(errors).toEqual([]);
});
