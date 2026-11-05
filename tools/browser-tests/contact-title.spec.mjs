import { test, expect } from '@playwright/test';

test.use({ channel: 'chrome' });

test('profile title saves in both languages and appears in Contacts at mobile width', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let title = null;
  let titleEn = null;
  let submitted = null;
  await page.route('**/api/v1/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let data = null;
    if (path.endsWith('/me')) data = {
      user_id: '00000000-0000-4000-8000-000000000001', role: 'admin', terms_required: false,
      user: { name: 'Test admin', email: 'admin@example.test', theme: 'light', presence: 'online',
        language: 'en', title, title_en: titleEn },
      organization: { id: '00000000-0000-4000-8000-000000000002', code: 'test', name: 'Test council',
        accent: '#276065', version: 1, terms: { id: '00000000-0000-4000-8000-000000000003', version: 1,
          body: 'Terms', body_en: 'Terms' } },
    };
    else if (path.endsWith('/csrf')) data = { token: 'test-token' };
    else if (path.endsWith('/profile') && request.method() === 'PATCH') {
      submitted = request.postDataJSON();
      title = submitted.title;
      titleEn = submitted.title_en;
      data = submitted;
    }
    else if (path.endsWith('/contacts')) data = { items: [{ id: '00000000-0000-4000-8000-000000000004',
      name: 'María', role: 'viewer', presence: 'offline', title: 'Secretaria', title_en: 'Secretary' }],
      page: 1, page_size: 25, total: 1 };
    else if (path.endsWith('/presence/heartbeat')) data = { effective: 'online', preference: 'online', ttl_seconds: 90 };
    else if (path.endsWith('/notifications')) data = { items: [], unread: 0, total: 0, page: 1, page_size: 25 };
    else if (path.endsWith('/notification-preferences')) data = { event_changes: true, reminders: true,
      chat_messages: true, quiet_start: null, quiet_end: null };
    await route.fulfill({ status: data === null ? 503 : 200, contentType: 'application/json',
      body: JSON.stringify(data === null ? { error: { message: 'Unavailable in preview' } } : { data }) });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.locator('.sidebar').getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Title shown in this council (ES)').fill('Coordinadora');
  await page.getByLabel('Title shown in this council (EN)').fill('Coordinator');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect.poll(() => submitted?.title_en).toBe('Coordinator');
  await expect(page.getByText('Changes saved.')).toBeVisible();
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.locator('.sidebar').getByRole('button', { name: 'Contacts', exact: true }).click();
  await expect(page.getByText('Secretary', { exact: true })).toBeVisible();
  await expect(page.getByText('Viewer', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
