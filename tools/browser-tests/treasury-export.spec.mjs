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

test('treasury Excel and PDF downloads apply literal search and deny viewers', async ({ page, browser }) => {
  test.setTimeout(240000);
  await login(page, 'admin');
  const token = (await (await page.request.get('/api/v1/csrf')).json()).data.token;
  const marker = String(Date.now()).slice(-8);
  const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const summary = await (await page.request.get('/api/v1/treasury')).json();
  if (!summary.data.opened) {
    const opening = await page.request.post('/api/v1/treasury/opening', { headers: { 'X-CSRF-TOKEN': token }, data: {
      amount: '100.00', effective_date: date, concept: 'Apertura de prueba', idempotency_key: crypto.randomUUID(),
    } });
    expect(opening.status()).toBe(200);
  }
  for (const concept of [`=2+2 & < 50%_! ${marker}`, `Otro 50ABC! ${marker}`]) {
    const response = await page.request.post('/api/v1/treasury/movements', { headers: { 'X-CSRF-TOKEN': token }, data: {
      kind: 'income', amount: '1.25', effective_date: date, concept, idempotency_key: crypto.randomUUID(),
    } });
    expect(response.status()).toBe(200);
  }
  await page.locator('.sidebar').getByRole('button', { name: 'Tesorería' }).click();
  await page.getByLabel('Concepto o comprobante').fill(`50%_! ${marker}`);
  await expect(page.getByRole('row').filter({ hasText: marker })).toHaveCount(1);
  await page.getByLabel('Nombre del archivo (opcional)').fill('Tesorería/Septiembre?.xlsx');
  await expect(page.getByRole('button', { name: 'Exportar Excel' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Exportar PDF' })).toBeDisabled();
  await page.getByLabel('Confirmo el nombre del archivo').check();
  await page.locator('.profile-trigger').click();
  await page.getByLabel('Idioma', { exact: true }).selectOption('en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export Excel' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('Tesoreria-Septiembre.xlsx');
  const bytes = fs.readFileSync(await download.path());
  expect(bytes.subarray(0, 2).toString()).toBe('PK');
  expect(bytes.includes(Buffer.from(`=2+2 &amp; &lt; 50%_! ${marker}`))).toBe(true);
  expect(bytes.includes(Buffer.from('Effective date'))).toBe(true);
  expect(bytes.includes(Buffer.from('Income'))).toBe(true);
  expect(bytes.includes(Buffer.from('name="Treasury"'))).toBe(true);
  expect(bytes.includes(Buffer.from('Fecha efectiva'))).toBe(false);
  expect(bytes.includes(Buffer.from(`Otro 50ABC! ${marker}`))).toBe(false);
  expect(bytes.includes(Buffer.from('<f>'))).toBe(false);
  const pdfPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export PDF' }).click();
  const pdf = await pdfPromise;
  expect(pdf.suggestedFilename()).toBe('Tesoreria-Septiembre.pdf');
  const pdfBytes = fs.readFileSync(await pdf.path());
  expect(pdfBytes.subarray(0, 5).toString()).toBe('%PDF-');
  fs.writeFileSync('.local/treasury-history-proof.pdf', pdfBytes);
  fs.writeFileSync('.local/treasury-history-proof-marker.txt', marker);
  const document = await getDocument({ data: new Uint8Array(pdfBytes), useSystemFonts: true }).promise;
  const firstPage = await document.getPage(1);
  const englishText = (await firstPage.getTextContent()).items.map(item => 'str' in item ? item.str : '').join(' ').replace(/\s+/g, ' ');
  expect(englishText).toContain('Treasury history');
  expect(englishText).toContain('Income');
  expect(englishText).toContain(`=2+2 & < 50%_! ${marker}`);
  expect(englishText).not.toContain('Historial de Tesorería');
  await document.destroy();
  await page.setViewportSize({ width: 360, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.getByRole('button', { name: 'Export PDF' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: '.local/treasury-history-mobile.png' });

  const viewerContext = await browser.newContext({ baseURL: process.env.SRD_TEST_URL || 'http://localhost:8080' });
  try {
    const viewer = await viewerContext.newPage();
    await login(viewer, 'viewer');
    await expect(viewer.locator('.sidebar').getByRole('button', { name: 'Tesorería' })).toHaveCount(0);
    expect((await viewer.request.get('/api/v1/treasury/export')).status()).toBe(403);
    expect((await viewer.request.get('/api/v1/treasury/export-pdf')).status()).toBe(403);
  } finally { await viewerContext.close(); }
});
