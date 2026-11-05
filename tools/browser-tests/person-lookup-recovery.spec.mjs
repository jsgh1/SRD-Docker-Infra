import { test, expect } from '@playwright/test';
import fs from 'node:fs';

const fixture = JSON.parse(fs.readFileSync(process.env.SRD_BROWSER_FIXTURE));
const mailpit = process.env.SRD_MAILPIT_URL || 'http://localhost:8025';

test('exact lookup clears an old result during a slow search and recovers after an error', async ({ page }) => {
  test.setTimeout(90000);
  const email = fixture.users.admin.email;
  const before = await (await page.request.get(`${mailpit}/api/v1/messages`)).json();
  const oldIds = new Set(before.messages?.map(message => message.ID) || []);
  await page.goto(`/j/${fixture.codeA}/login`);
  await page.getByLabel('Correo electrónico', { exact: true }).fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: 'términos y condiciones', exact: true }).click();
  await page.getByRole('button', { name: 'Aceptar términos', exact: true }).click();
  await page.getByRole('button', { name: 'Ingresar', exact: true }).click();
  let message;
  await expect.poll(async () => {
    const list = await (await page.request.get(`${mailpit}/api/v1/messages`)).json();
    message = list.messages?.find(item => !oldIds.has(item.ID) && item.To.some(to => to.Address === email));
    return Boolean(message);
  }, { timeout: 85000 }).toBe(true);
  const content = await (await page.request.get(`${mailpit}/api/v1/message/${message.ID}`)).json();
  await page.getByLabel('Código de verificación').fill(content.Text.match(/\b\d{6}\b/)[0]);
  await page.getByRole('button', { name: 'Confirmar código' }).click();
  await expect(page.locator('.profile-trigger')).toBeVisible();

  const csrf = (await (await page.request.get('/api/v1/csrf')).json()).data.token;
  const number = `LOOKUP-${Date.now()}`;
  const created = await page.request.post('/api/v1/persons', { headers: { 'X-CSRF-TOKEN': csrf }, data: {
    document_type: 'CC', document_number: number, first_names: 'Consulta sintética', status: 'pending',
    gender: 'female', zone: 'urban', authorization_basis: 'Prueba', authorization_purpose: 'Consulta exacta',
  } });
  expect(created.status()).toBe(200);
  const personId = (await created.json()).data.id;

  await page.setViewportSize({ width: 320, height: 800 });
  await page.getByRole('button', { name: 'Abrir menú' }).click();
  await page.locator('.sidebar').getByRole('button', { name: 'Consultar', exact: true }).click();
  const form = page.getByRole('form', { name: 'Filtros de personas' });
  await form.getByRole('combobox', { name: 'Tipo de documento' }).selectOption('CC');
  await form.getByRole('textbox', { name: 'Número de documento' }).fill(number);
  const search = form.getByRole('button', { name: 'Consultar', exact: true });
  await search.click();
  await expect(page.getByRole('list', { name: 'Lista de personas' }).getByText('Consulta sintética', { exact: true })).toBeVisible();

  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let intercepted = false;
  const pattern = '**/api/v1/persons/lookup?*';
  await page.route(pattern, async route => {
    intercepted = true;
    await gate;
    await route.fulfill({ status: 503, contentType: 'application/json',
      body: JSON.stringify({ error: { message: 'Consulta temporalmente no disponible.' } }) });
  });
  await search.click();
  await expect.poll(() => intercepted).toBe(true);
  await expect(page.locator('main .loading')).toBeVisible();
  await expect(page.getByText('Consulta sintética', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(322);
  release();
  await expect(page.locator('main .error')).toContainText('Consulta temporalmente no disponible.');
  await expect(page.locator('main .loading')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Consulta exacta' })).toHaveCount(0);
  await page.unroute(pattern);
  await search.click();
  await expect(page.getByRole('list', { name: 'Lista de personas' }).getByText('Consulta sintética', { exact: true })).toBeVisible();
  await expect(page.locator('main .error')).toHaveCount(0);

  const deleted = await page.request.delete(`/api/v1/persons/${personId}`, {
    headers: { 'X-CSRF-TOKEN': csrf }, data: { version: 1, confirmed: true },
  });
  expect(deleted.status()).toBe(200);
});
