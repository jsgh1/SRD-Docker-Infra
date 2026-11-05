import { test, expect } from '@playwright/test';
import fs from 'node:fs';

const fixture = JSON.parse(fs.readFileSync(process.env.SRD_BROWSER_FIXTURE));
const mailUrl = process.env.SRD_MAILPIT_URL || 'http://127.0.0.1:8025';

test('folder access permissions translate and persist for roles and members', async ({ page }) => {
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
  await expect(page.locator('.sidebar').getByRole('button', { name: 'Home', exact: true })).toBeVisible();

  await page.locator('.profile-trigger').click();
  await page.getByLabel('Idioma', { exact: true }).selectOption('en');
  await page.locator('.profile-trigger').click();
  await page.locator('.sidebar').getByRole('button', { name: 'Settings', exact: true }).click();
  let access = page.getByRole('region', { name: 'Folder read permissions' });
  await expect(access.getByRole('heading', { name: 'Folder access' })).toBeVisible();
  await expect(access).toContainText('Individual read access does not allow editing');
  await expect(access.getByRole('checkbox', { name: 'Viewer', exact: true })).not.toBeChecked();
  await access.getByRole('checkbox', { name: 'Viewer', exact: true }).check();
  await access.getByLabel('Find member for Folders').fill(fixture.users.viewer.email);
  await access.getByRole('button', { name: 'Search', exact: true }).click();
  await access.getByLabel(fixture.users.viewer.email, { exact: false }).check();
  await access.getByRole('button', { name: 'Save permissions' }).click();
  await expect(access.getByRole('status')).toContainText('Folder read permissions saved.');
  expect((await (await page.request.get('/api/v1/folder-access')).json()).data.reader_roles).toContain('viewer');
  await page.reload();
  await page.locator('.sidebar').getByRole('button', { name: 'Settings', exact: true }).click();
  access = page.getByRole('region', { name: 'Folder read permissions' });
  await expect(access.getByRole('checkbox', { name: 'Viewer', exact: true })).toBeChecked();
  await expect(access.getByRole('button', { name: new RegExp(`Remove individual access for .*`) })).toBeVisible();
  await page.setViewportSize({ width: 360, height: 800 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(2);
  await access.getByRole('checkbox', { name: 'Viewer', exact: true }).uncheck();
  await access.getByRole('button', { name: /Remove individual access for/ }).click();
  await access.getByRole('button', { name: 'Save permissions' }).click();
  await expect(access.getByRole('status')).toContainText('Folder read permissions saved.');
  const saved = (await (await page.request.get('/api/v1/folder-access')).json()).data;
  expect(saved.reader_roles).not.toContain('viewer');
  expect(saved.reader_memberships).toHaveLength(0);
});
