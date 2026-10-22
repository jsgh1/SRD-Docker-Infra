import { test, expect } from '@playwright/test';

test.use({ channel: 'chrome' });

test('inventory blocks unchanged adjustments and requires zero stock before retirement', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const id = '77777777-7777-4777-8777-777777777777';
  let quantity = 2;
  let movementPosts = 0;
  const asset = () => ({ id, code: 'INV-TEST', type: 'movable', name: 'Sillas', name_en: 'Chairs',
    category: 'Muebles', category_en: 'Furniture', unit: 'unidad', unit_en: 'unit',
    description: null, location: 'Salón', location_en: 'Hall', condition: 'Buena', condition_en: 'Good',
    responsible_name: null, quantity, status: 'active', version: 1, retired_at: null });
  const principal = { user_id: '22222222-2222-4222-8222-222222222222', role: 'admin', terms_required: false,
    user: { name: 'Test admin', email: 'admin@example.test', theme: 'light', presence: 'online', language: 'es' },
    organization: { id: '11111111-1111-4111-8111-111111111111', code: 'test', name: 'Junta de prueba', accent: '#276065', version: 1,
      terms: { id: '66666666-6666-4666-8666-666666666666', version: 1, body: 'Términos', body_en: 'Terms' } } };
  await page.route('**/api/v1/**', async route => {
    const request = route.request();
    const endpoint = new URL(request.url()).pathname.replace('/api/v1/', '');
    let data = null;
    if (endpoint === 'me') data = principal;
    else if (endpoint === 'csrf') data = { token: 'test' };
    else if (endpoint === 'assets' && request.method() === 'GET') data = { items: [asset()], total: 1 };
    else if (endpoint === `assets/${id}`) data = { asset: asset(), movements: [], movement_page: 1, movement_page_size: 25, movement_total: 0 };
    else if (endpoint === `assets/${id}/photos`) data = { items: [] };
    else if (endpoint === `assets/${id}/movements` && request.method() === 'POST') {
      movementPosts++;
      const body = request.postDataJSON();
      expect(body.type).toBe('adjust');
      expect(body.quantity).toBe(0);
      quantity = 0;
      data = { asset: asset() };
    }
    await route.fulfill({ status: data === null ? 503 : 200, contentType: 'application/json',
      body: JSON.stringify(data === null ? { error: { message: 'Not used in this test' } } : { data }) });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Abrir menú' }).click();
  await page.locator('.sidebar').getByRole('button', { name: 'Inventario', exact: true }).click();
  await page.getByRole('listitem').filter({ hasText: 'INV-TEST' }).getByRole('button', { name: 'Ver bien' }).click();
  let detail = page.getByRole('dialog', { name: 'INV-TEST · Sillas' });
  await expect(detail.getByRole('button', { name: 'Dar de baja' })).toBeDisabled();
  await expect(detail.getByText('Registra una salida o ajusta la existencia a cero antes de dar de baja.')).toBeVisible();
  await detail.getByRole('button', { name: 'Registrar movimiento' }).click();
  const movement = page.getByRole('dialog', { name: 'Movimiento de Sillas' });
  await movement.getByLabel('Operación').selectOption('adjust');
  await movement.getByLabel('Nueva existencia').fill('2');
  await movement.getByLabel('Motivo (ES)').fill('Conteo de prueba');
  await movement.getByLabel('Motivo (EN)').fill('Test count');
  await movement.getByRole('button', { name: 'Confirmar movimiento' }).click();
  await expect(movement.getByRole('alert')).toContainText('El ajuste debe cambiar la existencia.');
  expect(movementPosts).toBe(0);
  await movement.getByLabel('Nueva existencia').fill('0');
  await movement.getByRole('button', { name: 'Confirmar movimiento' }).click();
  detail = page.getByRole('dialog', { name: 'INV-TEST · Sillas' });
  await expect(detail.getByRole('button', { name: 'Dar de baja' })).toBeEnabled();
  expect(movementPosts).toBe(1);
  quantity = 2;
  principal.user.language = 'en';
  await page.reload();
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.locator('.sidebar').getByRole('button', { name: 'Inventory', exact: true }).click();
  await page.getByRole('listitem').filter({ hasText: 'INV-TEST' }).getByRole('button', { name: 'View asset' }).click();
  const englishDetail = page.getByRole('dialog', { name: 'INV-TEST · Chairs' });
  await expect(englishDetail.getByRole('button', { name: 'Retire asset' })).toBeDisabled();
  await expect(englishDetail.getByText('Record a stock out or adjust the quantity to zero before retirement.')).toBeVisible();
  await englishDetail.getByRole('button', { name: 'Record transaction' }).click();
  const englishMovement = page.getByRole('dialog', { name: 'Movement for Chairs' });
  await englishMovement.getByLabel('Operation').selectOption('adjust');
  await englishMovement.getByLabel('New quantity').fill('2');
  await englishMovement.getByLabel('Reason (ES)').fill('Conteo de prueba');
  await englishMovement.getByLabel('Reason (EN)').fill('Test count');
  await englishMovement.getByRole('button', { name: 'Confirm movement' }).click();
  await expect(englishMovement.getByRole('alert')).toContainText('The adjustment must change the stock quantity.');
  expect(movementPosts).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
