import { test, expect } from '@playwright/test';
import fs from 'node:fs';

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

async function mutation(page, method, url, data) {
  const token = (await (await page.request.get('/api/v1/csrf')).json()).data.token;
  return page.request.fetch(url, { method, data, headers: { 'X-CSRF-TOKEN': token } });
}

test('asset photos use private storage, signed authorization, and readonly retirement', async ({ page }) => {
  test.setTimeout(240000);
  await login(page, 'admin');
  const created = await mutation(page, 'POST', '/api/v1/assets', {
    code: 'PHOTO-' + crypto.randomUUID().slice(0, 8), type: 'real_estate', name: 'Bien de prueba fotográfica',
    location: 'Sede de prueba', condition: 'Bueno', quantity: 1, idempotency_key: crypto.randomUUID(),
  });
  expect(created.status()).toBe(200);
  const asset = (await created.json()).data.asset;
  const png = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 30; canvas.height = 20;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#245bce'; ctx.fillRect(0, 0, 30, 20);
    return canvas.toDataURL('image/png').split(',')[1];
  }), 'base64');
  {
    await page.locator('.sidebar').getByRole('button', { name: 'Inventario' }).click();
    await expect(page.getByRole('heading', { name: 'Inventario' })).toBeVisible();
    await page.getByRole('row').filter({ hasText: asset.code }).getByRole('button', { name: 'Ver bien' }).click();
    const photos = page.getByRole('region', { name: 'Fotografías del bien' });
    await expect(photos).toBeVisible();
    const front = photos.getByRole('article', { name: 'Vista frontal' });
    await expect(front.getByText('Sin fotografía')).toBeVisible({ timeout: 90000 });
    await front.getByLabel('Agregar fotografía').setInputFiles({ name: 'bien.png', mimeType: 'image/png', buffer: png });
    await expect(front.getByRole('status')).toHaveText('Fotografía guardada.', { timeout: 90000 });
    await expect(front.getByRole('img')).toBeVisible();
    const read = await page.request.get(`/api/v1/assets/${asset.id}/photos/front`);
    expect(read.status()).toBe(200);
    expect((await read.json()).data.content).toBeTruthy();
    const retired = await mutation(page, 'POST', `/api/v1/assets/${asset.id}/retire`, {
      version: 1, reason: 'Fin de prueba fotográfica', idempotency_key: crypto.randomUUID(),
    });
    expect(retired.status()).toBe(200);
    expect((await mutation(page, 'PUT', `/api/v1/assets/${asset.id}/photos/side`, {
      name: 'bien.png', content: png.toString('base64'), version: 0,
    })).status()).toBe(404);
    expect((await page.request.get(`/api/v1/assets/${asset.id}/photos/front`)).status()).toBe(200);
  }
});
