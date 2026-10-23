import { test, expect } from '@playwright/test';

test.use({ channel: 'chrome' });

for (const language of ['es', 'en']) {
  test(`recovery keeps its generic response in ${language} at mobile width`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await page.addInitScript(value => localStorage.setItem('srd-last-language', value), language);
    const requests = [];
    await page.route('**/api/v1/**', async route => {
      const path = new URL(route.request().url()).pathname;
      let status = 200;
      let data;
      if (path.endsWith('/organizations/demo')) data = {
        id: '11111111-1111-4111-8111-111111111111', code: 'demo', name: 'Junta de prueba',
        accent: '#276065', version: 1,
        terms: { id: '22222222-2222-4222-8222-222222222222', version: 1, body: 'Términos', body_en: 'Terms' },
      };
      else if (path.endsWith('/csrf')) data = { token: 'test' };
      else if (path.endsWith('/auth/recover')) {
        requests.push(route.request().postDataJSON());
        data = { message: 'Si la cuenta está habilitada, recibirás instrucciones para recuperar el acceso.' };
      } else status = 401;
      await route.fulfill({ status, contentType: 'application/json',
        body: JSON.stringify(status === 200 ? { data } : { error: { message: 'No autorizado' } }) });
    });
    await page.goto('/j/demo/login');
    await expect(page.locator('.small-label')).toHaveText('Junta de prueba');
    await page.getByRole('button', { name: language === 'en' ? 'Forgot my password' : 'Olvidé mi contraseña' }).click();
    const email = page.getByLabel(language === 'en' ? 'Email address' : 'Correo electrónico');
    await email.fill('not-an-email');
    await page.getByRole('button', { name: language === 'en' ? 'Send instructions' : 'Enviar instrucciones' }).click();
    expect(requests).toHaveLength(0);
    expect(await email.evaluate(element => element.validity.typeMismatch)).toBe(true);
    await email.fill('unknown@example.test');
    await page.getByRole('button', { name: language === 'en' ? 'Send instructions' : 'Enviar instrucciones' }).click();
    await expect(page.locator('.access-form .notice')).toHaveText(language === 'en'
      ? 'If the account is active, you will receive instructions to recover access.'
      : 'Si la cuenta está habilitada, recibirás instrucciones para recuperar el acceso.');
    expect(requests).toEqual([{ email: 'unknown@example.test', organization_code: 'demo' }]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(321);
  });
}

test('successful reset leaves the one-time route and reload opens council selection', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('srd-last-language', 'en'));
  const challenge = '11111111-1111-4111-8111-111111111111';
  const secret = 'a'.repeat(64);
  let resetBody;
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let status = 200;
    let data;
    if (path.endsWith('/csrf')) data = { token: 'test' };
    else if (path.endsWith('/auth/reset')) {
      resetBody = route.request().postDataJSON();
      data = { revoked_session_ids: [] };
    } else status = 401;
    await route.fulfill({ status, contentType: 'application/json',
      body: JSON.stringify(status === 200 ? { data } : { error: { message: 'Unauthenticated' } }) });
  });
  await page.goto(`/reset#${challenge}.${secret}`);
  await expect(page.getByRole('heading', { name: 'New password' })).toBeVisible();
  await expect(page).toHaveURL(/\/reset$/);
  await page.locator('input[name="password"]').fill('New-password-2026');
  await page.locator('input[name="password_confirmation"]').fill('New-password-2026');
  await page.locator('.access-form form button.primary.full').click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Find your council' })).toBeVisible();
  await expect(page.locator('.access-form .notice')).toHaveText('Password updated. Sign in with your new password.');
  expect(resetBody).toEqual({ password: 'New-password-2026', password_confirmation: 'New-password-2026',
    challenge_id: challenge, secret });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Find your council' })).toBeVisible();
  await expect(page.locator('input[name="password"]')).toHaveCount(0);
});

test('leaving an expired reset link returns to council selection after reload', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('srd-last-language', 'en'));
  await page.route('**/api/v1/**', route => route.fulfill({ status: 401, contentType: 'application/json',
    body: JSON.stringify({ error: { message: 'Unauthenticated' } }) }));
  await page.goto(`/reset#11111111-1111-4111-8111-111111111111.${'a'.repeat(64)}`);
  await expect(page.getByRole('heading', { name: 'New password' })).toBeVisible();
  await page.getByRole('button', { name: '← Back to sign in' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Find your council' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Find your council' })).toBeVisible();
});
