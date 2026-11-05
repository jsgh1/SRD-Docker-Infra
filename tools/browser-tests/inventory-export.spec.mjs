import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

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

test('inventory Excel and PDF downloads apply filters and deny viewers', async ({ page, browser }) => {
  test.setTimeout(240000);
  await login(page, 'admin');
  const marker = String(Date.now()).slice(-8);
  const wantedCode = `EXP-${marker}`;
  const otherCode = `OTHER-${marker}`;
  const token = (await (await page.request.get('/api/v1/csrf')).json()).data.token;
  for (const [code, name] of [[wantedCode, `=2+2 & < 50%_! ${marker}`], [otherCode, `50ABC ${marker}`]]) {
    const response = await page.request.post('/api/v1/assets', { headers: { 'X-CSRF-TOKEN': token }, data: {
      code, name, type: 'movable', category: 'Prueba', unit: 'unidad',
      location: 'Sede de prueba', condition: 'Bueno', quantity: 1, idempotency_key: crypto.randomUUID(),
    } });
    expect(response.status()).toBe(200);
  }
  await page.locator('.sidebar').getByRole('button', { name: 'Inventario' }).click();
  await page.getByLabel('Buscar por código o nombre').fill(`50%_! ${marker}`);
  await expect(page.getByRole('row').filter({ hasText: wantedCode })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: otherCode })).toHaveCount(0);
  await page.getByLabel('Nombre del archivo (opcional)').fill('Lista/Comunal?.xlsx');
  await expect(page.getByRole('button', { name: 'Exportar Excel' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Exportar PDF' })).toBeDisabled();
  await page.getByLabel('Confirmo el nombre del archivo').check();
  await page.locator('.profile-trigger').click();
  await page.getByLabel('Idioma', { exact: true }).selectOption('en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export Excel' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('Lista-Comunal.xlsx');
  const bytes = fs.readFileSync(await download.path());
  expect(bytes.subarray(0, 2).toString()).toBe('PK');
  expect(bytes.includes(Buffer.from('Quantity on hand'))).toBe(true);
  expect(bytes.includes(Buffer.from('Movable asset'))).toBe(true);
  expect(bytes.includes(Buffer.from('name="Inventory"'))).toBe(true);
  const pdfPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export PDF' }).click();
  const pdfDownload = await pdfPromise;
  expect(pdfDownload.suggestedFilename()).toBe('Lista-Comunal.pdf');
  const pdfBytes = fs.readFileSync(await pdfDownload.path());
  expect(pdfBytes.subarray(0, 5).toString()).toBe('%PDF-');
  const pdf = await getDocument({ data: new Uint8Array(pdfBytes), useSystemFonts: true }).promise;
  const firstPage = await pdf.getPage(1);
  const pdfText = (await firstPage.getTextContent()).items.map(item => 'str' in item ? item.str : '').join(' ').replace(/\s+/g, ' ');
  expect(pdfText).toContain('Council inventory');
  expect(pdfText).toContain('Movable asset');
  expect(pdfText).toContain(`=2+2 & < 50%_! ${marker}`);
  expect(pdfText).not.toContain('Inventario de la junta');
  await pdf.destroy();
  fs.writeFileSync('.local/inventory-export-proof.pdf', pdfBytes);
  expect(bytes.includes(Buffer.from(wantedCode))).toBe(true);
  expect(bytes.includes(Buffer.from(otherCode))).toBe(false);
  expect(bytes.includes(Buffer.from('=2+2 &amp; &lt; 50%_!'))).toBe(true);
  expect(bytes.includes(Buffer.from('<f>'))).toBe(false);
  await page.setViewportSize({ width: 360, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.getByRole('button', { name: 'Export PDF' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: '.local/inventory-export-mobile.png' });

  const viewerContext = await browser.newContext({ baseURL: process.env.SRD_TEST_URL || 'http://localhost:8080' });
  try {
    const viewer = await viewerContext.newPage();
    await login(viewer, 'viewer');
    await expect(viewer.locator('.sidebar').getByRole('button', { name: 'Inventario' })).toHaveCount(0);
    expect((await viewer.request.get('/api/v1/assets/export')).status()).toBe(403);
    expect((await viewer.request.get('/api/v1/assets/export-pdf')).status()).toBe(403);
  } finally { await viewerContext.close(); }
});
