import { test, expect } from '@playwright/test';

const principal = {
  user_id: '22222222-2222-4222-8222-222222222222', role: 'superadmin', terms_required: false,
  user: { name: 'Test admin', email: 'admin@example.test', theme: 'dark', presence: 'online', language: 'en' },
  organization: { id: '11111111-1111-4111-8111-111111111111', code: 'test', name: 'Test council',
    accent: '#276065', version: 1, terms: { id: '44444444-4444-4444-8444-444444444444',
      version: 1, body: 'Terms', body_en: 'Terms' } },
};

for (const width of [320, 1280]) {
  test(`slow reads show feedback in main sections at ${width}px`, async ({ page }) => {
    test.setTimeout(120000);
    await page.setViewportSize({ width, height: 800 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let hold = false;
    let release = () => {};
    let pending = 0;
    await page.route('**/api/v1/**', async route => {
      const url = new URL(route.request().url()).pathname;
      const data = url.endsWith('/me') ? principal : url.endsWith('/csrf') ? { token: 'test' }
        : url.endsWith('/system/schedulers') || url.endsWith('/system/audit-deliveries') ? { items: [] }
          : url.endsWith('/system/calendar-deliveries') ? { exhausted: 0 }
            : url.endsWith('/system/mail-deliveries') ? { invitations: { exhausted: 0 }, security_notices: { exhausted: 0 } }
              : undefined;
      if (!data && hold) {
        pending += 1;
        await new Promise(resolve => { const previous = release; release = () => { previous(); resolve(); }; });
      }
      await route.fulfill({ status: data ? 200 : 503, contentType: 'application/json',
        body: JSON.stringify(data ? { data } : { error: { message: 'Unavailable in preview' } }) });
    });
    await page.goto('/');
    for (const section of ['Register', 'List', 'Contacts', 'Chat', 'Folders', 'Calendar', 'Treasury', 'Inventory', 'Settings', 'Audit']) {
      pending = 0;
      release = () => {};
      hold = true;
      if (width < 700) await page.getByRole('button', { name: 'Open menu' }).click();
      await page.locator('.sidebar nav').getByRole('button', { name: section, exact: true }).click();
      await expect.poll(() => pending, { timeout: 10000 }).toBeGreaterThan(0);
      await expect(page.locator('main .loading').first(), `${section}: no loading feedback`).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth), `${section}: horizontal overflow`).toBeLessThanOrEqual(width + 2);
      hold = false;
      release();
      await expect(page.locator('main .loading'), `${section}: stuck after response`).toHaveCount(0, { timeout: 12000 });
    }
    pending = 0;
    release = () => {};
    if (width < 700) await page.getByRole('button', { name: 'Open menu' }).click();
    await page.locator('.sidebar nav').getByRole('button', { name: 'Look up', exact: true }).click();
    const lookup = page.getByRole('form', { name: 'People filters' });
    await lookup.getByRole('textbox', { name: 'Document number' }).fill('1234567890');
    hold = true;
    await lookup.getByRole('button', { name: 'Look up' }).click();
    await expect.poll(() => pending, { timeout: 10000 }).toBeGreaterThan(0);
    await expect(page.locator('main .loading').first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Exact lookup' })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 2);
    hold = false;
    release();
    await expect(page.locator('main .loading')).toHaveCount(0, { timeout: 12000 });
    await expect(page.locator('main .error').first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Exact lookup' })).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
