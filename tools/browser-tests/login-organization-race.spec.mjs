import { test, expect } from '@playwright/test';

test.use({ channel: 'chrome' });

const council = code => ({ id: code === 'alpha' ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222',
  code, name: `${code} Council`, accent: '#276065', version: 1,
  terms: { id: code === 'alpha' ? '33333333-3333-4333-8333-333333333333' : '44444444-4444-4444-8444-444444444444',
    version: 1, body: `${code} terms`, body_en: `${code} terms` } });

test('late council lookup cannot replace a code selected by the user', async ({ page }) => {
  let releaseAlpha;
  const alphaReady = new Promise(resolve => { releaseAlpha = resolve; });
  let alphaStarted;
  const alphaRequest = new Promise(resolve => { alphaStarted = resolve; });
  let alphaFinished;
  const alphaDone = new Promise(resolve => { alphaFinished = resolve; });
  let loginBody;
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/organizations/alpha')) {
      alphaStarted();
      await alphaReady;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: council('alpha') }) });
      alphaFinished();
    } else if (path.endsWith('/organizations/beta')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: council('beta') }) });
    } else if (path.endsWith('/csrf')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { token: 'test' } }) });
    } else if (path.endsWith('/auth/login')) {
      loginBody = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { challenge_id: 'test', resend_after: 60 } }) });
    } else {
      await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Unauthenticated' } }) });
    }
  });
  await page.goto('/j/alpha/login', { waitUntil: 'domcontentloaded' });
  await alphaRequest;
  await page.getByLabel('Código de la junta').fill('beta');
  await page.getByRole('button', { name: 'Continuar' }).click();
  await expect(page.getByRole('heading', { name: 'Iniciar sesión' })).toBeVisible();
  await expect(page.locator('.small-label')).toHaveText('beta Council');
  releaseAlpha();
  await alphaDone;
  await expect(page.locator('.small-label')).toHaveText('beta Council');
  await expect(page.getByRole('button', { name: 'Ingresar a otra junta' })).toBeVisible();
  await page.getByLabel('Correo electrónico').fill('admin@example.test');
  await page.getByLabel('Contraseña', { exact: true }).fill('synthetic-password');
  await page.getByRole('button', { name: 'términos y condiciones' }).click();
  await page.getByRole('button', { name: 'Aceptar términos' }).click();
  await page.getByRole('button', { name: 'Ingresar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ingresa tu código' })).toBeVisible();
  expect(loginBody.organization_code).toBe('beta');
  expect(loginBody.terms_version_id).toBe(council('beta').terms.id);
});

test('editing a code during lookup discards its late success and error', async ({ page }) => {
  let finishBeta;
  const betaReady = new Promise(resolve => { finishBeta = resolve; });
  let rejectBeta = true;
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/organizations/beta')) {
      await betaReady;
      await route.fulfill({ status: rejectBeta ? 503 : 200, contentType: 'application/json', body: JSON.stringify(rejectBeta
        ? { error: { message: 'Temporary failure' } } : { data: council('beta') }) });
    } else if (path.endsWith('/organizations/alpha')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: council('alpha') }) });
    } else {
      await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Unauthenticated' } }) });
    }
  });
  await page.goto('/');
  await page.getByLabel('Código de la junta').fill('beta');
  await page.getByRole('button', { name: 'Continuar' }).click();
  await page.getByLabel('Código de la junta').fill('alpha');
  finishBeta();
  await expect(page.getByRole('heading', { name: 'Encuentra tu junta' })).toBeVisible();
  await expect(page.locator('.access-form [role="alert"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Continuar' }).click();
  await expect(page.locator('.small-label')).toHaveText('alpha Council');
});
