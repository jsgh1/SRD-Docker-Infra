import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const fixture = JSON.parse(readFileSync(process.env.SRD_BROWSER_FIXTURE, 'utf8'));
const run = promisify(execFile);
const mailpit = process.env.SRD_MAILPIT_URL || 'http://localhost:8025';

test('folders and files recover after the actual Files service stops and starts', async ({ page }) => {
  test.setTimeout(180000);
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
  await page.locator('.sidebar').getByRole('button', { name: 'Carpeta', exact: true }).click();
  const folders = page.locator('.folders-page');
  const files = page.getByRole('region', { name: 'Archivos privados' });
  await expect(folders.getByRole('button', { name: 'Actualizar carpetas' })).toBeVisible();
  await expect(files.getByRole('button', { name: 'Actualizar archivos' })).toBeVisible();
  let stopped = false;
  try {
    await run('docker', ['compose', 'stop', 'files'], { cwd: process.cwd(), timeout: 60000 });
    stopped = true;
    await files.getByRole('button', { name: 'Actualizar archivos' }).click();
    await expect(files.getByRole('alert').last()).toContainText('Un servicio necesario no está disponible.', { timeout: 30000 });
    await folders.getByRole('button', { name: 'Actualizar carpetas' }).click();
    await expect(files).toHaveCount(0);
    await expect(folders.locator('.error')).toContainText('Un servicio necesario no está disponible.', { timeout: 30000 });
  } finally {
    if (stopped) await run('docker', ['compose', 'start', 'files'], { cwd: process.cwd(), timeout: 90000 });
  }
  await expect.poll(async () => {
    const result = await run('docker', ['inspect', '--format', '{{.State.Health.Status}}', 'srd-files-1'], { timeout: 10000 });
    return result.stdout.trim();
  }, { timeout: 90000, intervals: [2000, 3000, 5000] }).toBe('healthy');
  await folders.getByRole('button', { name: 'Actualizar carpetas' }).click();
  await files.getByRole('button', { name: 'Actualizar archivos' }).click();
  await expect(folders.locator('.error')).toHaveCount(0);
  await expect(files.locator('.error')).toHaveCount(0);
});
