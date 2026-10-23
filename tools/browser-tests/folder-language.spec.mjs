import { test, expect } from '@playwright/test';
import fs from 'node:fs';

const fixture = JSON.parse(fs.readFileSync(process.env.SRD_BROWSER_FIXTURE));
const mailUrl = process.env.SRD_MAILPIT_URL || 'http://127.0.0.1:8025';

test('folder names and navigation use saved ES/EN text across reloads', async ({ page }) => {
  await page.goto(`/j/${fixture.codeA}/login`);
  await page.getByLabel('Correo electrónico', { exact: true }).fill(fixture.users.admin.email);
  await page.getByLabel('Contraseña', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: 'términos y condiciones' }).click();
  await page.getByRole('button', { name: 'Aceptar términos' }).click();
  const started = Date.now();
  await page.getByRole('button', { name: 'Ingresar', exact: true }).click();
  let message;
  await expect.poll(async () => {
    const list = await (await page.request.get(`${mailUrl}/api/v1/messages`)).json();
    message = list.messages?.filter(item => item.Subject === 'Tu código de seguridad de SRD'
      && item.To.some(to => to.Address === fixture.users.admin.email) && Date.parse(item.Created) >= started - 5000)
      .sort((a, b) => Date.parse(b.Created) - Date.parse(a.Created))[0];
    return Boolean(message);
  }, { timeout: 85000 }).toBe(true);
  const content = await (await page.request.get(`${mailUrl}/api/v1/message/${message.ID}`)).json();
  await page.getByLabel('Código de verificación').fill(content.Text.match(/\b\d{6}\b/)[0]);
  await page.getByRole('button', { name: 'Confirmar código' }).click();

  await page.locator('.sidebar').getByRole('button', { name: 'Carpeta', exact: true }).click();
  await expect(page.getByText('Seleccionar archivo')).toBeVisible();
  await page.getByRole('button', { name: 'Nueva carpeta', exact: true }).click();
  await page.getByLabel('Nombre de carpeta (ES)').fill('Actas bilingües');
  await page.getByLabel('Nombre de carpeta (EN)').fill('Bilingual minutes');
  await page.getByRole('button', { name: 'Guardar carpeta' }).click();
  await expect(page.getByRole('button', { name: 'Actas bilingües', exact: true })).toBeVisible();
  const folders = (await (await page.request.get('/api/v1/folders')).json()).data.items;
  expect(folders.find(item => item.name === 'Actas bilingües')?.name_en).toBe('Bilingual minutes');

  await page.locator('.profile-trigger').click();
  await page.getByLabel('Idioma', { exact: true }).selectOption('en');
  await page.locator('.profile-trigger').click();
  await expect(page.getByRole('button', { name: 'Bilingual minutes', exact: true })).toBeVisible();
  const files = page.getByRole('region', { name: 'Private files' });
  await expect(files.getByRole('heading', { name: 'Private files' })).toBeVisible();
  await expect(files.getByLabel('Document, image or audio')).toHaveAttribute('type', 'file');
  await expect(files.getByText('Choose file')).toBeVisible();
  await expect(files.getByText('No file selected')).toBeVisible();
  await expect(files.getByRole('button', { name: 'Refresh files' })).toBeVisible();
  await page.getByRole('button', { name: 'Bilingual minutes', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Folder path' }).getByRole('button', { name: 'Bilingual minutes' })).toBeVisible();
  await page.reload();
  await page.locator('.sidebar').getByRole('button', { name: 'Folders', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Bilingual minutes', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 360, height: 800 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(2);
  await files.scrollIntoViewIfNeeded();
  await page.screenshot({ path: '.local/folder-language-mobile.png' });
});
