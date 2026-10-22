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

test('filtered people download keeps documents as text and excludes notes', async ({ page }) => {
  test.setTimeout(240000);
  await login(page);
  const marker = String(Date.now()).slice(-8);
  const token = (await (await page.request.get('/api/v1/csrf')).json()).data.token;
  const ids = [];
  try {
    for (const [number, name] of [[`DOC-${marker}-1`, `=2+2 & < 50%_! ${marker}`], [`DOC-${marker}-2`, `Otro 50ABC! ${marker}`]]) {
      const response = await page.request.post('/api/v1/persons', { headers: { 'X-CSRF-TOKEN': token }, data: {
        document_type: 'CC', document_number: number, first_names: name, status: 'pending',
        note: `NOTA-PRIVADA-${marker}`, authorization_basis: 'Prueba local',
        authorization_purpose: 'Verificar exportación',
      } });
      expect(response.status()).toBe(200);
      ids.push((await response.json()).data.id);
    }
    for (const [slot, width, height, color] of [['person', 100, 400, '#245bce'], ['document', 500, 100, '#12834b'], ['property', 400, 400, '#d45722']]) {
      const png = await page.evaluate(({width, height, color}) => {
        const c = document.createElement('canvas'); c.width = width; c.height = height;
        const g = c.getContext('2d'); g.fillStyle = color; g.fillRect(0, 0, width, height);
        g.fillStyle = '#fff'; g.fillRect(width / 4, height / 4, width / 2, height / 2);
        return c.toDataURL('image/png').split(',')[1];
      }, {width, height, color});
      const response = await page.request.put(`/api/v1/persons/${ids[0]}/photos/${slot}`, {
        headers: { 'X-CSRF-TOKEN': token }, data: { name: 'synthetic.png', content: png, version: 0 }, timeout: 90000,
      });
      expect(response.status()).toBe(200);
    }
    await page.locator('.sidebar').getByRole('button', { name: 'Lista', exact: true }).click();
    const form = page.getByRole('form', { name: 'Filtros de personas' });
    await form.getByLabel('Buscar', { exact: true }).fill(`50%_! ${marker}`);
    await form.getByRole('button', { name: 'Aplicar filtros' }).click();
    await expect(page.getByText('1 registros encontrados')).toBeVisible();
    await page.getByRole('button', { name: `Ver =2+2 & < 50%_! ${marker}`, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Detalle de persona' });
    const individualPanel = dialog.getByRole('region', { name: 'Exportar ficha individual' });
    await expect(individualPanel.getByLabel('Incluir fotografías en el PDF')).not.toBeChecked();
    await individualPanel.getByLabel('Nombre del archivo (opcional)').fill('Ficha/Septiembre?.xlsx');
    await expect(individualPanel.getByRole('button', { name: 'Descargar ficha Excel' })).toBeDisabled();
    await expect(individualPanel.getByRole('button', { name: 'Descargar ficha PDF' })).toBeDisabled();
    await individualPanel.getByLabel('Confirmo el nombre del archivo').check();
    const individualPromise = page.waitForEvent('download');
    await individualPanel.getByRole('button', { name: 'Descargar ficha Excel' }).click();
    const individualDownload = await individualPromise;
    expect(individualDownload.suggestedFilename()).toBe('Ficha-Septiembre.xlsx');
    const individualBytes = fs.readFileSync(await individualDownload.path());
    expect(individualBytes.subarray(0, 2).toString()).toBe('PK');
    expect(individualBytes.includes(Buffer.from(ids[0]))).toBe(true);
    expect(individualBytes.includes(Buffer.from(`DOC-${marker}-1`))).toBe(true);
    expect(individualBytes.includes(Buffer.from(ids[1]))).toBe(false);
    expect(individualBytes.includes(Buffer.from(`NOTA-PRIVADA-${marker}`))).toBe(false);
    expect(individualBytes.includes(Buffer.from('Verificar exportación'))).toBe(false);
    expect(individualBytes.includes(Buffer.from('<f>'))).toBe(false);
    fs.writeFileSync('.local/person-individual-proof.xlsx', individualBytes);
    const individualPdfPromise = page.waitForEvent('download');
    await individualPanel.getByRole('button', { name: 'Descargar ficha PDF' }).click();
    const individualPdfDownload = await individualPdfPromise;
    expect(individualPdfDownload.suggestedFilename()).toBe('Ficha-Septiembre.pdf');
    const individualPdfBytes = fs.readFileSync(await individualPdfDownload.path());
    expect(individualPdfBytes.subarray(0, 5).toString()).toBe('%PDF-');
    fs.writeFileSync('.local/person-individual-proof.pdf', individualPdfBytes);
    await expect(dialog.getByRole('region', { name: 'Fotografías de la ficha' }).getByRole('img')).toHaveCount(3);
    await individualPanel.getByLabel('Incluir fotografías en el PDF').check();
    const photoRoute = `**/api/v1/persons/${ids[0]}/photos/document`;
    await page.route(photoRoute, route => route.fulfill({status: 503, contentType: 'application/json', body: JSON.stringify({error: {code: 'unavailable', message: 'Fotografía temporalmente no disponible'}})}));
    let pdfRequests = 0;
    const observePdf = request => { if (request.url().includes(`/persons/${ids[0]}/pdf`)) pdfRequests++; };
    page.on('request', observePdf);
    await individualPanel.getByRole('button', { name: 'Descargar ficha PDF' }).click();
    await expect(individualPanel.getByRole('alert')).toBeVisible();
    expect(pdfRequests).toBe(0);
    await page.unroute(photoRoute);
    const photoPdfPromise = page.waitForEvent('download');
    await individualPanel.getByRole('button', { name: 'Descargar ficha PDF' }).click();
    const photoPdfDownload = await photoPdfPromise;
    expect(photoPdfDownload.suggestedFilename()).toBe('Ficha-Septiembre.pdf');
    fs.writeFileSync('.local/person-individual-photos-proof.pdf', fs.readFileSync(await photoPdfDownload.path()));
    expect(pdfRequests).toBe(1);
    page.off('request', observePdf);
    await page.setViewportSize({ width: 360, height: 800 });
    await individualPanel.getByRole('button', { name: 'Descargar ficha PDF' }).scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await page.screenshot({ path: '.local/person-individual-mobile.png' });
    await dialog.getByRole('button', { name: 'Cerrar', exact: true }).click();
    await page.setViewportSize({ width: 1280, height: 900 });
    const exportPanel = page.getByRole('region', { name: 'Exportación de personas' });
    await exportPanel.getByLabel('Nombre del archivo (opcional)').fill('Personas/Septiembre?.xlsx');
    await expect(exportPanel.getByRole('button', { name: 'Exportar Excel' })).toBeDisabled();
    await exportPanel.getByLabel('Confirmo el nombre del archivo').check();
    const downloadPromise = page.waitForEvent('download');
    await exportPanel.getByRole('button', { name: 'Exportar Excel' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('Personas-Septiembre.xlsx');
    const bytes = fs.readFileSync(await download.path());
    expect(bytes.subarray(0, 2).toString()).toBe('PK');
    expect(bytes.includes(Buffer.from(`DOC-${marker}-1`))).toBe(true);
    expect(bytes.includes(Buffer.from(`DOC-${marker}-2`))).toBe(false);
    expect(bytes.includes(Buffer.from(`=2+2 &amp; &lt; 50%_! ${marker}`))).toBe(true);
    expect(bytes.includes(Buffer.from(`NOTA-PRIVADA-${marker}`))).toBe(false);
    expect(bytes.includes(Buffer.from('<f>'))).toBe(false);
    const pdfPromise = page.waitForEvent('download');
    await exportPanel.getByRole('button', { name: 'Exportar PDF' }).click();
    const pdfDownload = await pdfPromise;
    expect(pdfDownload.suggestedFilename()).toBe('Personas-Septiembre.pdf');
    const pdfBytes = fs.readFileSync(await pdfDownload.path());
    expect(pdfBytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdfBytes.length).toBeGreaterThan(2000);
    fs.writeFileSync('.local/person-export-proof.pdf', pdfBytes);
    await page.setViewportSize({ width: 360, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  } finally {
    for (const id of ids) {
      const response = await page.request.delete(`/api/v1/persons/${id}`, { headers: { 'X-CSRF-TOKEN': token }, data: { version: 1, confirmed: true } });
      expect(response.status()).toBe(200);
    }
  }
});
