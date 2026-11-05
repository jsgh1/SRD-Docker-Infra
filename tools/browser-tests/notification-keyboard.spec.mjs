import { test, expect } from '@playwright/test';
import fs from 'node:fs';
const fixture = JSON.parse(fs.readFileSync(process.env.SRD_BROWSER_FIXTURE));
const mailUrl = process.env.SRD_MAILPIT_URL || 'http://localhost:8025';

async function login(page) {
  await page.goto(`/j/${fixture.codeA}/login`);
  await page.getByLabel('Correo electrónico', { exact: true }).fill(fixture.users.viewer.email);
  await page.getByLabel('Contraseña', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: 'términos y condiciones', exact: true }).click();
  await page.getByRole('button', { name: 'Aceptar términos', exact: true }).click();
  await page.getByRole('button', { name: 'Ingresar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ingresa tu código' })).toBeVisible();
  let message;
  await expect.poll(async () => {
    const list = await (await page.request.get(`${mailUrl}/api/v1/messages`)).json();
    message = list.messages?.find(item => item.Subject === 'Tu código de seguridad de SRD' && item.To.some(to => to.Address === fixture.users.viewer.email));
    return !!message;
  }, { timeout: 85000 }).toBe(true);
  const content = await (await page.request.get(`${mailUrl}/api/v1/message/${message.ID}`)).json();
  await page.getByLabel('Código de verificación').fill(content.Text.match(/\b\d{6}\b/)[0]);
  await page.getByRole('button', { name: 'Confirmar código' }).click();
  await expect(page.locator('.sidebar').getByRole('button', { name: 'Home', exact: true })).toBeVisible();
}

test('notification panel closes accessibly and never saves a discarded draft', async ({ page }) => {
  await login(page);
  const baseline = (await (await page.request.get('/api/v1/notification-preferences')).json()).data;
  let writes = 0;
  page.on('request', request => {
    if (request.url().includes('/api/v1/notification-preferences') && request.method() === 'PUT') writes++;
  });
  const bell = page.getByRole('button', { name: /^Notificaciones/ });
  const inbox = page.getByRole('region', { name: 'Bandeja de notificaciones' });
  await bell.focus();
  await bell.press('Enter');
  await expect(bell).toHaveAttribute('aria-expanded', 'true');
  await expect(bell).toHaveAttribute('aria-controls', await inbox.getAttribute('id'));
  await expect(inbox.getByRole('button', { name: 'Cerrar', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(inbox.getByRole('button', { name: 'Actualizar', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(inbox).toHaveCount(0);
  await expect(bell).toHaveAttribute('aria-expanded', 'false');
  await expect(bell).toBeFocused();

  let releasePreferences;
  const preferencesGate = new Promise(resolve => { releasePreferences = resolve; });
  await page.route('**/api/v1/notification-preferences', async route => {
    if (route.request().method() === 'GET') await preferencesGate;
    await route.continue();
  });
  await bell.press('Enter');
  await expect(inbox.getByText('Cargando preferencias…', { exact: true })).toBeVisible();
  await expect(inbox.getByRole('checkbox', { name: 'Activar horario de silencio' })).toHaveCount(0);
  releasePreferences();
  await inbox.getByRole('checkbox', { name: 'Activar horario de silencio' }).check();
  await page.unroute('**/api/v1/notification-preferences');
  await inbox.getByLabel('Silencio desde').fill('21:00');
  await inbox.getByLabel('Silencio hasta').fill('06:00');
  await expect(inbox.getByRole('button', { name: 'Guardar preferencias' })).toBeEnabled();
  await inbox.getByRole('button', { name: 'Cerrar', exact: true }).click();
  await expect(inbox).toHaveCount(0);
  await expect(bell).toBeFocused();
  await bell.press('Enter');
  await expect(inbox.getByRole('checkbox', { name: 'Activar horario de silencio' })).not.toBeChecked();
  const home = page.locator('.sidebar').getByRole('button', { name: 'Home', exact: true });
  await home.click();
  await expect(inbox).toHaveCount(0);
  await expect(home).toBeFocused();

  await page.setViewportSize({ width: 360, height: 800 });
  await bell.click();
  await expect(inbox.getByRole('button', { name: 'Cerrar', exact: true })).toBeFocused();
  await expect(inbox.getByRole('checkbox', { name: 'Activar horario de silencio' })).toBeVisible();
  const bounds = await inbox.boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(360);
  await page.screenshot({ path: '.local/notification-keyboard-mobile.png' });
  await inbox.getByRole('button', { name: 'Cerrar', exact: true }).click();
  await expect(inbox).toHaveCount(0);
  await expect(bell).toBeFocused();
  expect(writes).toBe(0);
  expect((await (await page.request.get('/api/v1/notification-preferences')).json()).data).toEqual(baseline);
});
