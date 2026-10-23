import { test, expect } from '@playwright/test';
import fs from 'node:fs';

const fixture = JSON.parse(fs.readFileSync(process.env.SRD_BROWSER_FIXTURE));
const mailUrl = process.env.SRD_MAILPIT_URL || 'http://localhost:8025';

async function login(page) {
  await page.goto(`/j/${fixture.codeA}/login`);
  await page.getByLabel('Correo electrónico', { exact: true }).fill(fixture.users.admin.email);
  await page.getByLabel('Contraseña', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: 'términos y condiciones', exact: true }).click();
  await page.getByRole('button', { name: 'Aceptar términos', exact: true }).click();
  await page.getByRole('button', { name: 'Ingresar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ingresa tu código' })).toBeVisible();
  let message;
  await expect.poll(async () => {
    const list = await (await page.request.get(`${mailUrl}/api/v1/messages`)).json();
    message = list.messages?.find(item => item.Subject === 'Tu código de seguridad de SRD' && item.To.some(to => to.Address === fixture.users.admin.email));
    return !!message;
  }, { timeout: 85000 }).toBe(true);
  const content = await (await page.request.get(`${mailUrl}/api/v1/message/${message.ID}`)).json();
  await page.getByLabel('Código de verificación').fill(content.Text.match(/\b\d{6}\b/)[0]);
  await page.getByRole('button', { name: 'Confirmar código' }).click();
  await expect(page.locator('.sidebar').getByRole('button', { name: 'Home', exact: true })).toBeVisible();
}

test('signature workbook enforces five options and exports filtered people', async ({ page }, testInfo) => {
  test.setTimeout(240000);
  await login(page);
  const marker = String(Date.now()).slice(-8);
  const token = (await (await page.request.get('/api/v1/csrf')).json()).data.token;
  const ids = [];
  try {
    for (const [number, name] of [[`DOC-${marker}-1`, `=1+1 & < ${marker}`], [`DOC-${marker}-2`, `Otra ${marker}`]]) {
      const response = await page.request.post('/api/v1/persons', { headers: { 'X-CSRF-TOKEN': token }, data: {
        document_type: 'CC', document_number: number, first_names: name, status: 'pending',
        note: `NOTA-PRIVADA-${marker}`, authorization_basis: 'Prueba local', authorization_purpose: 'Planilla',
      } });
      expect(response.status()).toBe(200);
      ids.push((await response.json()).data.id);
    }
    await page.locator('.sidebar').getByRole('button', { name: 'Lista', exact: true }).click();
    const form = page.getByRole('form', { name: 'Filtros de personas' });
    await form.getByLabel('Buscar', { exact: true }).fill(`=1+1 & < ${marker}`);
    await form.getByRole('button', { name: 'Aplicar filtros' }).click();
    await expect(page.getByText('1 registros encontrados')).toBeVisible();
    const panel = page.getByRole('region', { name: 'Planilla de firmas' });
    for (const name of ['Correo electrónico', 'Teléfono', 'Nombre del predio', 'Zona', 'Cargo']) await panel.getByLabel(name, { exact: true }).check();
    await expect(panel.getByText('Seleccionadas: 5 / 5')).toBeVisible();
    await panel.getByLabel('Afiliado', { exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Límite de selección' });
    await expect(dialog).toContainText('Solo puedes seleccionar máximo 5 campos.');
    await dialog.getByRole('button', { name: 'Aceptar' }).click();
    await expect(panel.getByLabel('Afiliado', { exact: true })).not.toBeChecked();
    await panel.getByLabel('Encabezado principal').fill('JUNTA & COMUNIDAD');
    await panel.getByLabel('Nombre del archivo (opcional)').fill('Asistencia/Septiembre?.xlsx');
    await expect(panel.getByRole('button', { name: 'Descargar planilla Excel' })).toBeDisabled();
    await panel.getByLabel('Confirmo el nombre del archivo').check();
    const downloadPromise = page.waitForEvent('download');
    await panel.getByRole('button', { name: 'Descargar planilla Excel' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('Asistencia-Septiembre.xlsx');
    const bytes = fs.readFileSync(await download.path());
    expect(bytes.subarray(0, 2).toString()).toBe('PK');
    expect(bytes.includes(Buffer.from(`DOC-${marker}-1`))).toBe(true);
    expect(bytes.includes(Buffer.from(`DOC-${marker}-2`))).toBe(false);
    expect(bytes.includes(Buffer.from('JUNTA &amp; COMUNIDAD'))).toBe(true);
    expect(bytes.includes(Buffer.from('<c r="J6" t="inlineStr"><is><t xml:space="preserve">Firma</t>'))).toBe(true);
    expect(bytes.includes(Buffer.from('<c r="J7" t="inlineStr"><is><t xml:space="preserve"></t>'))).toBe(true);
    expect(bytes.includes(Buffer.from(`NOTA-PRIVADA-${marker}`))).toBe(false);
    const pdfDownloadPromise = page.waitForEvent('download', { timeout: 90000 });
    await panel.getByRole('button', { name: 'Descargar planilla PDF' }).click();
    const pdfDownload = await pdfDownloadPromise;
    expect(pdfDownload.suggestedFilename()).toBe('Asistencia-Septiembre.pdf');
    const directPdf = fs.readFileSync(await pdfDownload.path());
    expect(directPdf.subarray(0, 4).toString()).toBe('%PDF');
    fs.writeFileSync(testInfo.outputPath('planilla-direct.pdf'), directPdf);
    const popupPromise = page.waitForEvent('popup');
    await panel.getByRole('button', { name: 'Vista para imprimir o guardar PDF' }).click();
    const popup = await popupPromise;
    await expect(popup.getByRole('button', { name: 'Imprimir o guardar como PDF' })).toBeVisible();
    await expect(popup.locator('thead')).toContainText('JUNTA & COMUNIDAD');
    await expect(popup.locator('thead')).toContainText('Firma');
    await expect(popup.locator('tbody')).toContainText(`DOC-${marker}-1`);
    await expect(popup.locator('tbody')).not.toContainText(`DOC-${marker}-2`);
    await expect(popup.locator('body')).not.toContainText(`NOTA-PRIVADA-${marker}`);
    await expect(popup.locator('.signatures')).toContainText('PRESIDENTE');
    await expect(popup.locator('.signatures')).toContainText('SECRETARIO');
    await popup.evaluate(() => { window.__printCalls = 0; window.print = () => { window.__printCalls++; }; });
    await popup.getByRole('button', { name: 'Imprimir o guardar como PDF' }).click();
    expect(await popup.evaluate(() => window.__printCalls)).toBe(1);
    await popup.emulateMedia({ media: 'print' });
    await popup.setViewportSize({ width: 1123, height: 794 });
    await popup.screenshot({ path: testInfo.outputPath('planilla-print.png'), fullPage: true });
    const pdf = await popup.pdf({ format: 'A4', landscape: true, printBackground: true });
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    fs.writeFileSync(testInfo.outputPath('planilla-preview.pdf'), pdf);
    await popup.evaluate(() => {
      const body = document.querySelector('tbody');
      const sample = body.rows[0];
      for (let number = 2; number <= 85; number++) {
        const row = sample.cloneNode(true);
        row.cells[0].textContent = String(number);
        row.cells[1].textContent = `PERSONA DE PRUEBA ${number}`;
        body.append(row);
      }
    });
    const multiPagePdf = await popup.pdf({ format: 'A4', landscape: true, printBackground: true });
    expect(multiPagePdf.subarray(0, 4).toString()).toBe('%PDF');
    const pageCount = (multiPagePdf.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length;
    expect(pageCount).toBeGreaterThan(1);
    fs.writeFileSync(testInfo.outputPath('planilla-multipage.pdf'), multiPagePdf);
    await popup.close();
    await page.setViewportSize({ width: 360, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  } finally {
    for (const id of ids) {
      const response = await page.request.delete(`/api/v1/persons/${id}`, { headers: { 'X-CSRF-TOKEN': token }, data: { version: 1, confirmed: true } });
      expect(response.status()).toBe(200);
    }
  }
});
