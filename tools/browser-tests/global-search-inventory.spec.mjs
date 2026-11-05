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

async function createAsset(page, code, name) {
  const token = (await (await page.request.get('/api/v1/csrf')).json()).data.token;
  const response = await page.request.post('/api/v1/assets', {
    data: { code, type: 'movable', name, category: 'Prueba', unit: 'unidad',
      location: 'Sede de prueba', condition: 'Bueno', quantity: 0, idempotency_key: crypto.randomUUID() },
    headers: { 'X-CSRF-TOKEN': token },
  });
  expect(response.status()).toBe(200);
  return (await response.json()).data.asset;
}

test('authorized inventory search is literal, independent, and hidden from viewers', async ({ page, browser }) => {
  test.setTimeout(240000);
  await login(page, 'admin');
  const marker = String(Date.now()).slice(-8);
  const code = 'FIND-' + marker;
  const wanted = await createAsset(page, code, `Equipo 50%_! ${marker}`);
  await createAsset(page, 'OTHER-' + marker, `Equipo 50ABC! ${marker}`);
  await page.getByRole('button', { name: 'Buscar en la junta', exact: true }).click();
  const form = page.getByRole('form', { name: 'Búsqueda de la junta' });
  const assets = page.getByRole('region', { name: 'Resultados de bienes' });
  await form.getByLabel('Texto de búsqueda').fill(`50%_! ${marker}`);
  await form.getByRole('button', { name: 'Buscar', exact: true }).click();
  await expect(assets.getByText('1 coincidencias en bienes')).toBeVisible();
  await expect(assets.getByRole('row').filter({ hasText: code })).toBeVisible();
  await expect(assets.getByText('OTHER-' + marker)).toHaveCount(0);
  await assets.getByRole('button', { name: `Ver bien ${code}` }).click();
  await expect(page.getByRole('dialog', { name: new RegExp(code) })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Fotografías del bien' })).toBeVisible();
  await page.getByRole('dialog', { name: new RegExp(code) }).getByRole('button', { name: 'Cerrar' }).click();
  let detailFailed = false;
  await page.route(`**/api/v1/assets/${wanted.id}`, async route => {
    if (!detailFailed) {
      detailFailed = true;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Bien no disponible.' } }) });
    } else await route.continue();
  });
  await assets.getByRole('button', { name: `Ver bien ${code}` }).click();
  await expect(assets).toContainText('Bien no disponible.');
  await assets.getByRole('button', { name: 'Reintentar bien' }).click();
  await expect(page.getByRole('dialog', { name: new RegExp(code) })).toBeVisible();
  await page.getByRole('dialog', { name: new RegExp(code) }).getByRole('button', { name: 'Cerrar' }).click();
  await page.unroute(`**/api/v1/assets/${wanted.id}`);
  await page.route('**/api/v1/assets?*', route => route.fulfill({ status: 503, contentType: 'application/json',
    body: JSON.stringify({ error: { message: 'Fallo simulado de inventario' } }) }));
  await form.getByRole('button', { name: 'Buscar', exact: true }).click();
  await expect(assets.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Resultados de personas' })).toBeVisible();
  await page.unroute('**/api/v1/assets?*');
  await assets.getByRole('button', { name: 'Reintentar bienes' }).click();
  await expect(assets.getByText('1 coincidencias en bienes')).toBeVisible();
  await page.setViewportSize({ width: 360, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();

  const viewerContext = await browser.newContext({ baseURL: process.env.SRD_TEST_URL || 'http://localhost:8080' });
  try {
    const viewer = await viewerContext.newPage();
    await login(viewer, 'viewer');
    await viewer.getByRole('button', { name: 'Buscar en la junta', exact: true }).click();
    await expect(viewer.getByRole('option', { name: 'Bienes de inventario' })).toHaveCount(0);
    await viewer.getByLabel('Texto de búsqueda').fill(code);
    await viewer.getByRole('button', { name: 'Buscar', exact: true }).click();
    await expect(viewer.getByRole('region', { name: 'Resultados de bienes' })).toHaveCount(0);
    expect((await viewer.request.get('/api/v1/assets?q=' + code)).status()).toBe(403);
  } finally { await viewerContext.close(); }
});
