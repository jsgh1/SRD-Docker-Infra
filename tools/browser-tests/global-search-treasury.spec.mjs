import { test, expect } from '@playwright/test';
import fs from 'node:fs';

const fixture = JSON.parse(fs.readFileSync(process.env.SRD_BROWSER_FIXTURE));
const mailUrl = process.env.SRD_MAILPIT_URL || 'http://localhost:8025';

async function login(page, role) {
  await page.goto(`/j/${fixture.codeA}/login`);
  await page.getByLabel('Correo electrónico', { exact: true }).fill(fixture.users[role].email);
  await page.getByLabel('Contraseña', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: 'términos y condiciones', exact: true }).click();
  await page.getByRole('button', { name: 'Aceptar términos', exact: true }).click();
  await page.getByRole('button', { name: 'Ingresar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ingresa tu código' })).toBeVisible();
  let message;
  await expect.poll(async () => {
    const list = await (await page.request.get(`${mailUrl}/api/v1/messages`)).json();
    message = list.messages?.find(item => item.Subject === 'Tu código de seguridad de SRD' && item.To.some(to => to.Address === fixture.users[role].email));
    return !!message;
  }, { timeout: 85000 }).toBe(true);
  const content = await (await page.request.get(`${mailUrl}/api/v1/message/${message.ID}`)).json();
  await page.getByLabel('Código de verificación').fill(content.Text.match(/\b\d{6}\b/)[0]);
  await page.getByRole('button', { name: 'Confirmar código' }).click();
  await expect(page.locator('.sidebar').getByRole('button', { name: 'Home', exact: true })).toBeVisible();
}

async function post(page, path, data) {
  const token = (await (await page.request.get('/api/v1/csrf')).json()).data.token;
  const response = await page.request.post('/api/v1/' + path, { data, headers: { 'X-CSRF-TOKEN': token } });
  expect(response.status()).toBe(200);
  return (await response.json()).data;
}

test('treasury search isolates literal concepts, receipt lookup, errors and roles', async ({ page, browser }) => {
  test.setTimeout(240000);
  await login(page, 'admin');
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const summary = await (await page.request.get('/api/v1/treasury')).json();
  if (!summary.data.opened) await post(page, 'treasury/opening', { amount: '0.00', effective_date: today,
    concept: 'Apertura de prueba', idempotency_key: crypto.randomUUID() });
  const marker = String(Date.now()).slice(-8);
  const concept = `Aporte 50%_! ${marker}`;
  const wanted = await post(page, 'treasury/movements', { kind: 'income', amount: '12.00', effective_date: today,
    concept, idempotency_key: crypto.randomUUID() });
  await post(page, 'treasury/movements', { kind: 'income', amount: '13.00', effective_date: today,
    concept: `Aporte 50ABC! ${marker}`, idempotency_key: crypto.randomUUID() });

  await page.getByRole('button', { name: 'Buscar en la junta', exact: true }).click();
  const form = page.getByRole('form', { name: 'Búsqueda de la junta' });
  const treasury = page.getByRole('region', { name: 'Resultados de tesorería' });
  await form.getByLabel('Texto de búsqueda').fill(`50%_! ${marker}`);
  await form.getByRole('button', { name: 'Buscar', exact: true }).click();
  await expect(treasury.getByText('1 coincidencias en tesorería')).toBeVisible();
  await expect(treasury.getByRole('row').filter({ hasText: wanted.receipt })).toBeVisible();
  await treasury.getByRole('button', { name: `Ver comprobante ${wanted.receipt}` }).click();
  await expect(page.getByRole('dialog', { name: `Comprobante ${wanted.receipt}` }).getByText(concept)).toBeVisible();
  await page.getByRole('dialog', { name: `Comprobante ${wanted.receipt}` }).getByRole('button', { name: 'Cerrar' }).click();
  let detailFailed = false;
  await page.route(`**/api/v1/treasury/movements/${wanted.id}`, async route => {
    if (!detailFailed) {
      detailFailed = true;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Comprobante no disponible.' } }) });
    } else await route.continue();
  });
  await treasury.getByRole('button', { name: `Ver comprobante ${wanted.receipt}` }).click();
  await expect(treasury).toContainText('Comprobante no disponible.');
  await treasury.getByRole('button', { name: 'Reintentar comprobante' }).click();
  await expect(page.getByRole('dialog', { name: `Comprobante ${wanted.receipt}` })).toBeVisible();
  await page.getByRole('dialog', { name: `Comprobante ${wanted.receipt}` }).getByRole('button', { name: 'Cerrar' }).click();
  await page.unroute(`**/api/v1/treasury/movements/${wanted.id}`);
  await form.getByLabel('Texto de búsqueda').fill(wanted.receipt);
  await form.getByRole('button', { name: 'Buscar', exact: true }).click();
  await expect(treasury.getByText('1 coincidencias en tesorería')).toBeVisible();
  await page.route('**/api/v1/treasury?*', route => route.fulfill({ status: 503, contentType: 'application/json',
    body: JSON.stringify({ error: { message: 'Fallo simulado de tesorería' } }) }));
  await form.getByRole('button', { name: 'Buscar', exact: true }).click();
  await expect(treasury.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Resultados de personas' })).toBeVisible();
  await page.unroute('**/api/v1/treasury?*');
  await treasury.getByRole('button', { name: 'Reintentar tesorería' }).click();
  await expect(treasury.getByText('1 coincidencias en tesorería')).toBeVisible();
  await page.setViewportSize({ width: 360, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();

  const viewerContext = await browser.newContext({ baseURL: process.env.SRD_TEST_URL || 'http://localhost:8080' });
  try {
    const viewer = await viewerContext.newPage();
    await login(viewer, 'viewer');
    await viewer.getByRole('button', { name: 'Buscar en la junta', exact: true }).click();
    await expect(viewer.getByRole('option', { name: 'Tesorería' })).toHaveCount(0);
    await viewer.getByLabel('Texto de búsqueda').fill(marker);
    await viewer.getByRole('button', { name: 'Buscar', exact: true }).click();
    await expect(viewer.getByRole('region', { name: 'Resultados de tesorería' })).toHaveCount(0);
    expect((await viewer.request.get('/api/v1/treasury?q=' + marker)).status()).toBe(403);
  } finally { await viewerContext.close(); }
});
