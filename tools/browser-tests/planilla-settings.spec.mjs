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

test('planilla configuration persists headings and limits optional columns', async ({ page, browser }) => {
  test.setTimeout(240000);
  await login(page);
  await page.locator('.sidebar').getByRole('button', { name: 'Configuración', exact: true }).click();
  const settings = page.getByRole('region', { name: 'Configuración de planilla' });
  await expect(settings.getByLabel('H2 de la planilla', { exact: true })).not.toHaveValue('');
  await settings.getByLabel('H1 de la planilla', { exact: true }).fill('JUNTA & COMUNIDAD');
  await settings.getByLabel('H1 de la planilla en inglés').fill('COUNCIL & COMMUNITY');
  await settings.getByLabel('H2 de la planilla', { exact: true }).fill('Sector <norte>');
  await settings.getByLabel('H2 de la planilla en inglés').fill('North <area>');
  await settings.getByLabel('H3 de la planilla', { exact: true }).fill('ASISTENCIA');
  await settings.getByLabel('H3 de la planilla en inglés').fill('ATTENDANCE');
  const logo = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAAC0lEQVQImWNgQAYAAA4AAbGa6gYAAAAASUVORK5CYII=', 'base64');
  await settings.getByLabel('Logo de la junta para la planilla (PNG, máximo 128 KB)').setInputFiles({ name: 'junta.png', mimeType: 'image/png', buffer: logo });
  await expect(settings.getByRole('img', { name: 'Vista previa del logo de la junta' })).toBeVisible();
  for (const name of ['Correo electrónico', 'Teléfono', 'Nombre del predio', 'Cargo', 'Rol descriptivo', 'Estado del registro', 'Afiliado']) {
    await settings.getByLabel(name, { exact: true }).uncheck();
  }
  await settings.getByRole('button', { name: 'Guardar configuración de planilla' }).click();
  await expect(settings.getByRole('status')).toContainText('guardada');
  await expect(page.locator('.app-header .brand-mark img')).toBeVisible();
  const publicContext = await browser.newContext();
  try {
    const publicPage = await publicContext.newPage();
    await publicPage.goto(`/j/${fixture.codeA}/login`);
    await expect(publicPage.locator('.access-top .brand-mark img')).toBeVisible();
    await publicPage.reload();
    await expect(publicPage.locator('.access-top .brand-mark img')).toBeVisible();
    await publicPage.goto(`/j/${fixture.codeB}/login`);
    await expect(publicPage.locator('.access-top .brand-mark img')).toHaveCount(0);
  } finally { await publicContext.close(); }
  const response = await page.request.get('/api/v1/planilla-settings');
  expect(response.status()).toBe(200);
  expect((await response.json()).data.allowed_columns).toEqual(['zone']);
  expect((await (await page.request.get('/api/v1/planilla-settings')).json()).data.h1_en).toBe('COUNCIL & COMMUNITY');
  expect((await (await page.request.get('/api/v1/planilla-settings')).json()).data.logo_data).toContain('data:image/png;base64,');
  await page.reload();
  await expect(page.locator('.app-header .brand-mark img')).toBeVisible();
  await page.locator('.sidebar').getByRole('button', { name: 'Lista', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Planilla de firmas' });
  await expect(panel.getByLabel('Encabezado principal')).toHaveValue('JUNTA & COMUNIDAD');
  await expect(panel.getByLabel('Segundo encabezado')).toHaveValue('Sector <norte>');
  await expect(panel.getByLabel('Tercer encabezado')).toHaveValue('ASISTENCIA');
  await expect(panel.getByLabel('Zona', { exact: true })).toBeVisible();
  await expect(panel.getByLabel('Correo electrónico', { exact: true })).toHaveCount(0);
  const denied = await page.request.get('/api/v1/persons/planilla?columns[0]=email');
  expect(denied.status()).toBe(422);
  const downloadPromise = page.waitForEvent('download');
  await panel.getByRole('button', { name: 'Descargar planilla Excel' }).click();
  const download = await downloadPromise;
  const bytes = fs.readFileSync(await download.path());
  expect(bytes.includes(Buffer.from('JUNTA &amp; COMUNIDAD'))).toBe(true);
  expect(bytes.includes(Buffer.from('Sector &lt;norte&gt;'))).toBe(true);
  expect(bytes.includes(logo)).toBe(true);
  await page.locator('.profile-trigger').click();
  await page.getByLabel('Idioma', { exact: true }).selectOption('en');
  const englishPanel = page.getByRole('region', { name: 'Signature sheet' });
  await expect(englishPanel.getByLabel('First heading')).toHaveValue('COUNCIL & COMMUNITY');
  await expect(englishPanel.getByLabel('Second heading')).toHaveValue('North <area>');
  const popupPromise = page.waitForEvent('popup');
  await englishPanel.getByRole('button', { name: 'Print or save as PDF' }).click();
  const popup = await popupPromise;
  await expect(popup.locator('html')).toHaveAttribute('lang', 'en');
  await expect(popup.getByRole('button', { name: 'Print or save as PDF' })).toBeVisible();
  await expect(popup.locator('thead')).toContainText('COUNCIL & COMMUNITY');
  await expect(popup.locator('thead')).toContainText('MONTH:');
  await expect(popup.locator('thead')).toContainText('Signature');
  await expect(popup.getByRole('img', { name: 'Council logo' })).toBeVisible();
  await expect(popup.locator('.signatures')).toContainText('PRESIDENT');
  await popup.close();
  const pdfPromise = page.waitForEvent('download');
  await englishPanel.getByRole('button', { name: 'Download PDF sheet' }).click();
  const pdf = await pdfPromise;
  expect(fs.readFileSync(await pdf.path()).subarray(0, 4).toString()).toBe('%PDF');
  await page.setViewportSize({ width: 360, height: 800 });
  await expect(page.locator('.app-header .brand-mark img')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});
