import { test, expect } from '@playwright/test';

for (const width of [320, 1280]) {
  test(`failed reads remain understandable across web sections at ${width}px`, async ({ page }, testInfo) => {
    test.setTimeout(120000);
    await page.setViewportSize({ width, height: 800 });
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
              : undefined;
      await route.fulfill({ status: data ? 200 : 503, contentType: 'application/json',
        body: JSON.stringify(data ? { data } : { error: { message: 'Unavailable in preview' } }) });
    });
    await page.goto('/');
    const sections = ['Home', 'Register', 'List', 'Look up', 'Contacts', 'Chat', 'Folders', 'Calendar',
      'Treasury', 'Inventory', 'Export', 'Settings', 'Audit', 'Downloads'];
    for (const section of sections) {
      if (width < 700) await page.getByRole('button', { name: 'Open menu' }).click();
      await page.locator('.sidebar nav').getByRole('button', { name: section, exact: true }).click();
      await expect(page.locator('main')).toBeVisible();
      if (section === 'Settings') await expect(page.locator('main .error').first()).toBeVisible();
      if (section === 'Settings') await page.waitForTimeout(300);
      await expect(page.locator('main .loading'), `${section}: loading after failed reads`).toHaveCount(0, { timeout: 12000 });
      if (!['Export', 'Downloads'].includes(section)) {
        await expect(page.locator('main .error').first(), `${section}: no error feedback`).toBeVisible();
      }
      if (section === 'Contacts') await expect(page.getByRole('button', { name: 'Retry contacts' })).toBeVisible();
      const documentWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(documentWidth, `${section}: horizontal overflow`).toBeLessThanOrEqual(width + 2);
      if (width === 320 && ['Register', 'List', 'Look up', 'Contacts', 'Chat', 'Export', 'Settings', 'Downloads'].includes(section)) {
        await page.screenshot({ path: testInfo.outputPath(`${section}-error-${width}.png`), animations: 'disabled' });
      }
    }
    expect(errors).toEqual([]);
  });
}
