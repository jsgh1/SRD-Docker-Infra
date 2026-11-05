import { test, expect } from '@playwright/test';
import fs from 'node:fs';

const fixture = JSON.parse(fs.readFileSync(process.env.SRD_BROWSER_FIXTURE));
const mailUrl = process.env.SRD_MAILPIT_URL || 'http://localhost:8025';

async function login(page, role, code = fixture.codeA) {
  const previous = await (await page.request.get(`${mailUrl}/api/v1/messages`)).json();
  const seen = new Set(previous.messages?.map(item => item.ID) ?? []);
  await page.goto(`/j/${code}/login`);
  await page.getByLabel('Correo electrónico', { exact: true }).fill(fixture.users[role].email);
  await page.getByLabel('Contraseña', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: 'términos y condiciones', exact: true }).click();
  await page.getByRole('button', { name: 'Aceptar términos', exact: true }).click();
  await page.getByRole('button', { name: 'Ingresar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ingresa tu código' })).toBeVisible();
  let message;
  await expect.poll(async () => {
    const list = await (await page.request.get(`${mailUrl}/api/v1/messages`)).json();
    message = list.messages?.find(item => !seen.has(item.ID) && item.Subject === 'Tu código de seguridad de SRD' && item.To.some(to => to.Address === fixture.users[role].email));
    return !!message;
  }, { timeout: 85000 }).toBe(true);
  const content = await (await page.request.get(`${mailUrl}/api/v1/message/${message.ID}`)).json();
  await page.getByLabel('Código de verificación').fill(content.Text.match(/\b\d{6}\b/)[0]);
  await page.getByRole('button', { name: 'Confirmar código' }).click();
  await expect(page.locator('.sidebar').getByRole('button', { name: 'Home', exact: true })).toBeVisible();
}

async function mutation(page, method, url, data) {
  const token = (await (await page.request.get('/api/v1/csrf')).json()).data.token;
  return page.request.fetch(url, { method, data, headers: { 'X-CSRF-TOKEN': token } });
}

test('profile photo stays private to council, persists, and only its owner changes it', async ({ page, browser }) => {
  test.setTimeout(240000);
  await login(page, 'admin');
  const path = `/api/v1/users/${fixture.users.admin.id}/photos/avatar`;
  await page.locator('.sidebar').getByRole('button', { name: 'Configuración', exact: true }).click();
  await expect(page.getByText('Sin foto de perfil')).toBeVisible();
  const png = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 48; canvas.height = 48;
    const context = canvas.getContext('2d'); context.fillStyle = '#1c63aa'; context.fillRect(0, 0, 48, 48);
    return canvas.toDataURL('image/png').split(',')[1];
  }), 'base64');
  await page.getByLabel('Agregar fotografía').setInputFiles({ name: 'avatar.png', mimeType: 'image/png', buffer: png });
  await expect(page.locator('.profile-trigger .avatar img')).toBeVisible({ timeout: 90000 });
  await expect(page.getByRole('img', { name: 'Mi foto de perfil' })).toBeVisible();
  const saved = await page.request.get(path);
  expect(saved.status()).toBe(200);
  expect((await saved.json()).data.mime).toBe('image/png');
  await page.reload();
  await expect(page.locator('.profile-trigger .avatar img')).toBeVisible();
  await page.locator('.profile-trigger').click();
  await expect(page.locator('.profile-menu').getByRole('img', { name: 'Mi foto de perfil' })).toBeVisible();
  await page.locator('.profile-trigger').click();
  await page.setViewportSize({ width: 360, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  const peerContext = await browser.newContext();
  const peer = await peerContext.newPage();
  try {
    await login(peer, 'viewer');
    expect((await peer.request.get(path)).status()).toBe(200);
    await peer.locator('.sidebar').getByRole('button', { name: 'Contactos', exact: true }).click();
    const adminCard = peer.locator('.contact-card').filter({ hasText: 'Prueba Admin' });
    await expect(adminCard.locator('.avatar img')).toBeVisible();
    await adminCard.getByRole('button', { name: 'Abrir chat' }).click();
    await expect(peer.locator('.chat-contact-heading .avatar img')).toBeVisible();
    await expect(peer.locator('.chat-conversations .avatar img')).toBeVisible();
    await peer.setViewportSize({ width: 360, height: 800 });
    await expect(peer.locator('.chat-contact-heading .avatar img')).toBeVisible();
    expect(await peer.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await peer.screenshot({ path: '.local/contact-chat-mobile.png', fullPage: true });
    expect((await mutation(peer, 'PUT', path, { name: 'avatar.png', content: png.toString('base64'), version: 1 })).status()).toBe(404);
  } finally { await peerContext.close(); }

  const otherContext = await browser.newContext();
  const other = await otherContext.newPage();
  try {
    await login(other, 'superadmin', fixture.codeB);
    expect((await other.request.get(path)).status()).toBe(404);
  } finally { await otherContext.close(); }

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator('.sidebar').getByRole('button', { name: 'Configuración', exact: true }).click();
  await page.getByRole('button', { name: 'Eliminar foto de perfil' }).click();
  await page.getByRole('button', { name: 'Confirmar eliminación' }).click();
  await expect(page.getByText('Sin foto de perfil')).toBeVisible();
  await expect(page.locator('.profile-trigger .avatar img')).toHaveCount(0);
});
