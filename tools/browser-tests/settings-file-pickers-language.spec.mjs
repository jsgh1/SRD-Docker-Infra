import { test, expect } from '@playwright/test';

test.use({ channel: 'chrome', locale: 'es-CO' });

test('photo and signature logo pickers follow English profile on a Spanish browser', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 360, height: 780 });
  const errors = [];
  let profileWrites = 0;
  page.on('pageerror', error => errors.push(error.message));
  const userId = '22222222-2222-4222-8222-222222222222';
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let data;
    if (path.endsWith('/me')) data = {
      user_id: userId, role: 'admin', terms_required: false,
      user: { name: 'Test admin', email: 'admin@example.test', theme: 'light', presence: 'online', language: 'en' },
      organization: { id: '11111111-1111-4111-8111-111111111111', code: 'test', name: 'Test council', accent: '#276065', version: 1,
        terms: { id: '33333333-3333-4333-8333-333333333333', version: 1, body: 'Terms', body_en: 'Terms' } },
    };
    else if (path.endsWith('/csrf')) data = { token: 'test' };
    else if (path.endsWith('/profile') && route.request().method() === 'PATCH') { profileWrites++; data = {}; }
    else if (path.endsWith(`/users/${userId}/photos`)) data = {
      items: [{ slot: 'avatar', version: 0, present: false, size: 0, width: null, height: null }],
    };
    else if (path.endsWith('/planilla-settings')) data = {
      version: 1, allowed_columns: [], h1: 'Signatures', h2: 'Test council', h3: 'Sheet',
      h1_en: 'Signatures', h2_en: 'Test council', h3_en: 'Sheet', logo_data: null,
      delegated_roles: [], can_manage: true, can_delegate: false,
    };
    await route.fulfill({ status: data === undefined ? 503 : 200, contentType: 'application/json',
      body: JSON.stringify(data === undefined ? { error: { message: 'Unavailable in preview' } } : { data }) });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const profile = page.locator('.profile-photo-settings');
  await expect(profile.getByText('Choose file', { exact: true })).toBeVisible();
  await expect(profile.getByText('No file selected', { exact: true })).toBeVisible();
  await expect(profile.getByLabel('Add photo')).toHaveAttribute('type', 'file');
  await expect(page.getByLabel('Title shown in this council (ES)')).toHaveAttribute('placeholder', 'Ej.: Coordinadora');
  const titleEs = page.getByLabel('Title shown in this council (ES)');
  const titleEn = page.getByLabel('Title shown in this council (EN)');
  await titleEs.fill('Coordinadora comunitaria');
  await expect(titleEn).toHaveAttribute('required', '');
  await page.getByRole('button', { name: 'Save profile' }).click();
  expect(profileWrites).toBe(0);
  await titleEs.fill('');
  await titleEn.fill('Community coordinator');
  await expect(titleEs).toHaveAttribute('required', '');
  await titleEn.fill('');
  await titleEs.fill('Coordinadora comunitaria');
  await titleEn.fill('Community coordinator');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect.poll(() => profileWrites).toBe(1);

  const sections = page.getByRole('navigation', { name: 'Settings sections' });
  await expect(sections).toBeVisible();
  expect(await sections.evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(2);
  await sections.locator('a[href="#settings-security"]').click();
  await expect(page.locator('#settings-security')).toBeInViewport();
  for (const href of ['#settings-profile', '#settings-persons', '#settings-access', '#settings-services', '#settings-security']) {
    await sections.locator(`a[href="${href}"]`).click();
    const geometry = await page.evaluate(selector => ({
      targetTop: document.querySelector(selector).getBoundingClientRect().top,
      navBottom: document.querySelector('.settings-jump').getBoundingClientRect().bottom,
    }), href);
    expect(geometry.targetTop, `${href}: section title hidden behind sticky navigation`).toBeGreaterThanOrEqual(geometry.navBottom - 2);
  }
  expect(await sections.evaluate(element => Math.abs(element.getBoundingClientRect().top - 72))).toBeLessThanOrEqual(2);
  await sections.locator('a[href="#settings-profile"]').click();
  await expect(page.locator('#settings-profile')).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('settings-navigation-360.png'), animations: 'disabled' });

  const planilla = page.getByRole('region', { name: 'Signature sheet settings' });
  await expect(planilla.getByText('Choose file', { exact: true })).toBeVisible();
  await expect(planilla.getByText('No file selected', { exact: true })).toBeVisible();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAAC0lEQVQImWNgQAYAAA4AAbGa6gYAAAAASUVORK5CYII=', 'base64');
  await planilla.getByLabel('Council logo for the signature sheet (PNG, 128 KB maximum)')
    .setInputFiles({ name: 'council.png', mimeType: 'image/png', buffer: png });
  await expect(planilla.getByText('council.png', { exact: true })).toBeVisible();
  await expect(planilla.getByRole('img', { name: 'Council logo preview' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(errors).toEqual([]);
});
