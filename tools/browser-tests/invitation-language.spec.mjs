import { test, expect } from '@playwright/test';

test.use({ channel: 'chrome' });

test('English invitation link opens English form and preserves language for a new account', async ({ page }) => {
  const invitation = '11111111-1111-4111-8111-111111111111';
  const secret = 'a'.repeat(64);
  let acceptance;
  await page.setViewportSize({ width: 320, height: 800 });
  await page.addInitScript(() => localStorage.setItem('srd-last-language', 'es'));
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let data;
    if (path.endsWith('/csrf')) data = { token: 'test' };
    else if (path.endsWith('/invitations/inspect')) data = {
      email: 'new@example.test', role: 'viewer', existing_account: false,
      organization: { id: '22222222-2222-4222-8222-222222222222', code: 'demo',
        name: 'Junta de prueba', accent: '#276065', version: 1,
        terms: { id: '33333333-3333-4333-8333-333333333333', version: 1,
          body: 'Términos', body_en: 'Terms' } },
    };
    else if (path.endsWith('/invitations/accept')) {
      acceptance = route.request().postDataJSON();
      data = { organization_code: 'demo' };
    }
    await route.fulfill({ status: data ? 200 : 401, contentType: 'application/json',
      body: JSON.stringify(data ? { data } : { error: { message: 'Unauthorized' } }) });
  });
  await page.goto(`/invite#${invitation}.${secret}.en`);
  await expect(page).toHaveURL(/\/invite$/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('heading', { name: 'Private invitation to SRD' })).toBeVisible();
  await page.getByLabel('Account name').fill('New account');
  await page.locator('input[name="password"]').fill('Strong-demo-password-2026');
  await page.locator('input[name="password_confirmation"]').fill('Strong-demo-password-2026');
  await page.getByRole('button', { name: 'Show passwords' }).click();
  await expect(page.locator('input[name="password"]')).toHaveAttribute('type', 'text');
  await expect(page.locator('input[name="password_confirmation"]')).toHaveAttribute('type', 'text');
  await page.getByRole('button', { name: 'Hide passwords' }).click();
  await expect(page.locator('input[name="password"]')).toHaveAttribute('type', 'password');
  await page.getByRole('button', { name: 'Read invitation terms' }).click();
  await expect(page.getByText('Terms', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Accept these terms' }).click();
  await page.getByRole('button', { name: 'Accept private invitation' }).click();
  await expect(page.getByRole('status')).toContainText('Invitation accepted');
  expect(acceptance).toMatchObject({ invitation_id: invitation, secret, language: 'en', accepted: true,
    terms_version_id: '33333333-3333-4333-8333-333333333333' });
  expect(await page.evaluate(() => localStorage.getItem('srd-last-language'))).toBe('en');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(321);
});
