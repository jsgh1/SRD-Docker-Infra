import { test, expect } from '@playwright/test';

test.use({ channel: 'chrome' });

for (const { width, theme } of [{ width: 320, theme: 'dark' }, { width: 375, theme: 'light' },
  { width: 768, theme: 'dark' }, { width: 1280, theme: 'light' }]) {
  test(`main sections fit ${width}px in ${theme} theme`, async ({ page }) => {
    test.setTimeout(90000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width, height: 800 });
    await page.route('**/api/v1/**', async route => {
      const url = new URL(route.request().url());
      let data;
      if (url.pathname.endsWith('/me')) data = {
        user_id: '22222222-2222-4222-8222-222222222222', role: 'superadmin', terms_required: false,
        user: { name: 'Test admin', email: 'admin@example.test', theme, presence: 'online', language: 'en' },
        organization: { id: '11111111-1111-4111-8111-111111111111', code: 'test', name: 'Test council', accent: '#276065', version: 1,
          terms: { id: '44444444-4444-4444-8444-444444444444', version: 1, body: 'Terms', body_en: 'Terms' } },
      };
      else if (url.pathname.endsWith('/csrf')) data = { token: 'test' };
      await route.fulfill({ status: data === undefined ? 503 : 200, contentType: 'application/json',
        body: JSON.stringify(data === undefined ? { error: { message: 'Unavailable in preview' } } : { data }) });
    });
    await page.goto('/');
    await expect(page.locator('.sidebar nav')).toBeAttached();
    const sections = ['Home', 'Register', 'List', 'Look up', 'Contacts', 'Chat', 'Folders', 'Calendar',
      'Treasury', 'Inventory', 'Export', 'Settings', 'Audit', 'Downloads'];
    for (const label of sections) {
      if (width < 700) await page.getByRole('button', { name: 'Open menu' }).click();
      await page.locator('.sidebar nav').getByRole('button', { name: label, exact: true }).click();
      await expect(page.locator('main')).toBeVisible();
      const overflow = await page.evaluate(() => ({ width: document.documentElement.clientWidth,
        scroll: document.documentElement.scrollWidth,
        offenders: [...document.querySelectorAll('main *')].filter(element => {
          const rect = element.getBoundingClientRect();
          return rect.width && rect.right > document.documentElement.clientWidth + 1;
        }).slice(0, 5).map(element => `${element.tagName}.${String(element.className).slice(0, 45)}`),
      }));
      expect(overflow.scroll, `${label}: ${JSON.stringify(overflow)}`).toBeLessThanOrEqual(overflow.width + 1);
    }
    expect(errors).toEqual([]);
  });
}

test('shell stays within 320px with a 200% root font and long names', async ({ page }) => {
  test.setTimeout(90000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 320, height: 800 });
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const data = path.endsWith('/me') ? {
      user_id: '22222222-2222-4222-8222-222222222222', role: 'superadmin', terms_required: false,
      user: { name: 'CoordinadoraDeAccesosComunitariosConUnNombreExtenso', email: 'admin@example.test', theme: 'light', presence: 'online', language: 'en' },
      organization: { id: '11111111-1111-4111-8111-111111111111', code: 'test', name: 'JuntaComunitariaDeUnSectorConUnNombreMuyExtenso', accent: '#276065', version: 1,
        terms: { id: '44444444-4444-4444-8444-444444444444', version: 1, body: 'Terms', body_en: 'Terms' } },
    } : path.endsWith('/csrf') ? { token: 'test' } : undefined;
    await route.fulfill({ status: data ? 200 : 503, contentType: 'application/json',
      body: JSON.stringify(data ? { data } : { error: { message: 'Unavailable in preview' } }) });
  });
  await page.goto('/');
  await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
  const sections = ['Home', 'Register', 'List', 'Look up', 'Contacts', 'Chat', 'Folders', 'Calendar',
    'Treasury', 'Inventory', 'Export', 'Settings', 'Audit', 'Downloads'];
  for (const label of sections) {
    await page.getByRole('button', { name: 'Open menu' }).click();
    await page.locator('.sidebar nav').getByRole('button', { name: label, exact: true }).click();
    const overflow = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth,
      offenders: [...document.querySelectorAll('body *')].filter(element => {
        const rect = element.getBoundingClientRect();
        return rect.width && rect.right > document.documentElement.clientWidth + 1;
      }).slice(0, 8).map(element => ({ tag: element.tagName, className: String(element.className).slice(0, 45),
        left: Math.round(element.getBoundingClientRect().left), right: Math.round(element.getBoundingClientRect().right),
        minWidth: getComputedStyle(element).minWidth, sample: element.outerHTML.slice(0, 90) })),
      wide: [...document.querySelectorAll('body *')].filter(element => element.scrollWidth > element.clientWidth + 1)
        .slice(0, 12).map(element => ({ tag: element.tagName, className: String(element.className).slice(0, 45),
          client: element.clientWidth, scroll: element.scrollWidth, overflow: getComputedStyle(element).overflowX })) }));
    expect(overflow.document, `${label}: ${JSON.stringify(overflow)}`).toBeLessThanOrEqual(overflow.viewport + 1);
  }
  const headerControls = await page.locator('.app-header .hamburger, .app-header .notification-anchor button, .app-header .profile-trigger')
    .evaluateAll(elements => elements.map(element => ({ label: element.getAttribute('aria-label'),
      left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right })));
  expect(headerControls.length).toBeGreaterThanOrEqual(3);
  for (const control of headerControls) {
    expect(control.left, JSON.stringify(control)).toBeGreaterThanOrEqual(0);
    expect(control.right, JSON.stringify(control)).toBeLessThanOrEqual(321);
  }
  await page.locator('.profile-trigger').click();
  await expect(page.locator('#profile-menu')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(321);
  expect(errors).toEqual([]);
});

test('mobile menu hides closed links and restores keyboard focus', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const data = path.endsWith('/me') ? {
      user_id: '22222222-2222-4222-8222-222222222222', role: 'superadmin', terms_required: false,
      user: { name: 'Test admin', email: 'admin@example.test', theme: 'light', presence: 'online', language: 'en' },
      organization: { id: '11111111-1111-4111-8111-111111111111', code: 'test', name: 'Test council', accent: '#276065', version: 1,
        terms: { id: '44444444-4444-4444-8444-444444444444', version: 1, body: 'Terms', body_en: 'Terms' } },
    } : path.endsWith('/csrf') ? { token: 'test' } : undefined;
    await route.fulfill({ status: data ? 200 : 503, contentType: 'application/json',
      body: JSON.stringify(data ? { data } : { error: { message: 'Unavailable in preview' } }) });
  });
  await page.goto('/');
  const open = page.getByRole('button', { name: 'Open menu' });
  const firstLink = page.locator('#main-sidebar nav button').first();
  await expect(open).toHaveAttribute('aria-expanded', 'false');
  await expect(open).toHaveAttribute('aria-controls', 'main-sidebar');
  await expect(firstLink).toBeHidden();
  await open.click();
  await expect(page.getByRole('button', { name: 'Close menu' }).first()).toHaveAttribute('aria-expanded', 'true');
  await expect(firstLink).toBeFocused();
  await expect(page.locator('main.workspace')).toHaveAttribute('inert', '');
  await page.keyboard.press('Escape');
  await expect(open).toBeFocused();
  await expect(firstLink).toBeHidden();
  await open.click();
  await page.locator('#main-sidebar nav').getByRole('button', { name: 'Settings' }).click();
  await expect(page.locator('main.workspace')).toBeFocused();
  await expect(firstLink).toBeHidden();
  await expect(page.locator('main.workspace')).not.toHaveAttribute('inert');
  const profileButton = page.locator('.profile-trigger');
  await profileButton.click();
  await page.locator('#profile-language-choice').focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('#profile-menu')).toBeHidden();
  await expect(profileButton).toBeFocused();
  await profileButton.click();
  await page.locator('#profile-menu').getByRole('button', { name: 'Edit profile' }).click();
  await expect(page.locator('main.workspace')).toBeFocused();
});
