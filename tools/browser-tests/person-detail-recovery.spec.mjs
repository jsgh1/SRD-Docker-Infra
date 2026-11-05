import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const fixture = JSON.parse(readFileSync(process.env.SRD_BROWSER_FIXTURE, 'utf8'));
const mailpit = process.env.SRD_MAILPIT_URL || 'http://localhost:8025';

test('person detail recovers from a failed and stalled read', async ({ page }, testInfo) => {
  test.setTimeout(140000);
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
  await expect(page.locator('.sidebar').getByRole('button', { name: 'Lista', exact: true })).toBeVisible();
  const csrf = (await (await page.request.get('/api/v1/csrf')).json()).data.token;
  const created = await page.request.post('/api/v1/persons', { headers: { 'X-CSRF-TOKEN': csrf }, data: {
    document_type: 'CC', document_number: `DETAIL-${Date.now()}`, first_names: 'Detalle Sintético', status: 'pending',
    gender: 'female', authorization_basis: 'Prueba local', authorization_purpose: 'Verificar reintento',
  } });
  expect(created.status()).toBe(200);
  const id = (await created.json()).data.id;
  try {
    await page.locator('.sidebar').getByRole('button', { name: 'Lista', exact: true }).click();
    const viewDetail = page.getByRole('button', { name: 'Ver Detalle Sintético' });
    await expect(viewDetail).toBeVisible();
    let fail = true;
    await page.route(`**/api/v1/persons/${id}`, async route => {
      if (fail) {
        fail = false;
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Detalle no disponible.' } }) });
      } else await route.continue();
    });
    await viewDetail.click();
    const dialog = page.getByRole('dialog', { name: 'Detalle de persona' });
    await expect(dialog.locator('.error')).toContainText('Detalle no disponible.');
    for (const width of [320, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth), `Detalle a ${width}px`).toBeLessThanOrEqual(width + 2);
      await dialog.screenshot({ path: testInfo.outputPath(`person-detail-error-${width}.png`) });
    }
    await dialog.getByRole('button', { name: 'Reintentar detalle' }).click();
    await expect(dialog.getByText('Detalle Sintético')).toBeVisible();
    await page.unroute(`**/api/v1/persons/${id}`);
    await dialog.getByRole('button', { name: 'Cerrar' }).click();

    await page.route(`**/api/v1/persons/${id}`, async route => {
      await new Promise(resolve => setTimeout(resolve, 31000));
      await route.abort().catch(() => {});
    });
    await viewDetail.click();
    await expect(dialog.locator('.error')).toContainText('La conexión tardó demasiado.', { timeout: 34000 });
    await page.unroute(`**/api/v1/persons/${id}`);
    await dialog.getByRole('button', { name: 'Reintentar detalle' }).click();
    await expect(dialog.getByText('Detalle Sintético')).toBeVisible();
  } finally {
    await page.request.delete(`/api/v1/persons/${id}`, { headers: { 'X-CSRF-TOKEN': csrf }, data: { version: 1, confirmed: true } });
  }
});
