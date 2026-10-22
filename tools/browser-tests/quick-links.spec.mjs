import { test, expect } from '@playwright/test';
import fs from 'node:fs';
const fixture = JSON.parse(fs.readFileSync(process.env.SRD_BROWSER_FIXTURE || new URL('../../.local/e2e-fixture.json', import.meta.url)));
async function login(page, role) {
  await page.goto(`/j/${fixture.codeA || 'srd-e2e-a'}/login`);
  await page.getByLabel('Correo electrónico', { exact: true }).fill(fixture.users[role].email);
  await page.getByLabel('Contraseña', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: 'términos y condiciones', exact: true }).click();
  await page.getByRole('button', { name: 'Aceptar términos', exact: true }).click();
  await page.getByRole('button', { name: 'Ingresar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ingresa tu código' })).toBeVisible();
  let message;
  const url = process.env.SRD_MAILPIT_URL || 'http://127.0.0.1:8125';
  await expect.poll(async () => {
    const list = await (await page.request.get(`${url}/api/v1/messages`)).json();
    message = list.messages?.find(m => m.Subject === 'Tu código de seguridad de SRD' && m.To.some(t => t.Address === fixture.users[role].email));
    return !!message;
  }).toBe(true);
  const content = await (await page.request.get(`${url}/api/v1/message/${message.ID}`)).json();
  await page.getByLabel('Código de verificación').fill(content.Text.match(/\b\d{6}\b/)[0]);
  await page.getByRole('button', { name: 'Confirmar código' }).click();
  await expect(page.locator('.sidebar').getByRole('button', { name: 'Home', exact: true })).toBeVisible();
}
async function read(page) { return (await (await page.request.get('/api/v1/quick-links')).json()).data; }
async function patch(page, scope, data) {
  const csrf = (await (await page.request.get('/api/v1/csrf')).json()).data.token;
  return page.request.patch(`/api/v1/quick-links/${scope}`, { data, headers: { 'X-CSRF-TOKEN': csrf } });
}
async function settings(page) { await page.locator('.sidebar').getByRole('button', { name: 'Configuración', exact: true }).click(); }
async function home(page) { await page.locator('.sidebar').getByRole('button', { name: 'Home', exact: true }).click(); }

test('quick links persist, filter roles and allow isolated personal preferences', async ({ page, browser }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await login(page, 'superadmin');
  const initial = await read(page);
  const guestContext = await browser.newContext({ baseURL: process.env.SRD_TEST_URL || 'http://127.0.0.1:5173' });
  const guest = await guestContext.newPage();
  const adminContext = await browser.newContext({ baseURL: process.env.SRD_TEST_URL || 'http://127.0.0.1:5173' });
  const admin = await adminContext.newPage();
  let originalPersonal;
  guest.on('pageerror', e => errors.push(e.message));
  try {
    await login(admin, 'admin');
    await settings(admin);
    await expect(admin.getByLabel('Modo de accesos rápidos')).toHaveCount(0);
    await expect(admin.getByText(/Solo el superadministrador puede cambiarla/)).toBeVisible();
    expect((await patch(admin, 'organization', {version: initial.common_version, mode: 'personal', items: initial.common_items})).status()).toBe(403);
    await admin.getByLabel('Común · Etiqueta 1').fill('Alta comunitaria');
    await admin.getByLabel('Común · Etiqueta en inglés 1').fill('Community enrollment');
    await admin.getByRole('button', {name:'Guardar accesos de la junta',exact:true}).click();
    await expect(admin.getByRole('status').filter({hasText:'Accesos rápidos guardados'})).toBeVisible();
    expect((await read(admin)).mode).toBe('common');
    const adminPanel = admin.locator('section').filter({has:admin.getByRole('heading',{name:'Accesos rápidos del panel',exact:true})});
    await admin.setViewportSize({width:360,height:1600});
    await expect.poll(async()=>admin.locator('.sidebar').evaluate(el=>el.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
    await adminPanel.evaluate(el=>{el.scrollIntoView({block:'start',behavior:'instant'});window.scrollBy({top:-100,behavior:'instant'});});
    expect(await admin.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await adminPanel.screenshot({path:'.local/quick-policy-admin-mobile.png'});
    await admin.setViewportSize({width:1280,height:1600});
    await adminPanel.evaluate(el=>{el.scrollIntoView({block:'start',behavior:'instant'});window.scrollBy({top:-100,behavior:'instant'});});
    await adminPanel.screenshot({path:'.local/quick-policy-admin-desktop.png'});
    await settings(page);
    await page.getByLabel('Modo de accesos rápidos').selectOption('common');
    for (const [i, key, label] of [[1, 'list', 'Censo comunitario'], [2, 'lookup', 'Buscar vecino'], [3, 'audit', 'Actividad de la junta']]) {
      // Clear existing slots first so distinct selections can be reordered.
      await page.getByLabel(`Común · Función ${i}`).selectOption('');
    }
    for (const [i, key, label, english] of [[1, 'list', 'Censo comunitario', 'Community census'], [2, 'lookup', 'Buscar vecino', 'Find a neighbor'], [3, 'audit', 'Actividad de la junta', 'Council activity']]) {
      await page.getByLabel(`Común · Función ${i}`).selectOption(key);
      await page.getByLabel(`Común · Etiqueta ${i}`).fill(label);
      await page.getByLabel(`Común · Etiqueta en inglés ${i}`).fill(english);
    }
    await page.getByRole('button', { name: 'Guardar accesos de la junta' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Accesos rápidos guardados' })).toBeVisible();
    await home(page);
    await expect(page.locator('.quick-links button')).toHaveCount(3);
    await page.getByRole('button', { name: 'Censo comunitario', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Lista de personas' })).toBeVisible();
    await settings(page);
    await page.getByLabel('Modo de accesos rápidos').selectOption('personal');
    await page.getByRole('button', { name: 'Guardar accesos de la junta' }).click();
    await expect(page.getByRole('heading', { name: 'Mis accesos rápidos' })).toBeVisible();
    const policy = await read(admin);
    expect((await patch(admin, 'organization', {version: policy.common_version, mode: 'common', items: policy.common_items})).status()).toBe(403);
    await admin.getByLabel('Común · Etiqueta 1').fill('Edición antigua');
    await admin.getByLabel('Común · Etiqueta en inglés 1').fill('Outdated edit');
    const stale = admin.waitForResponse(r=>r.request().method()==='PATCH'&&r.url().endsWith('/quick-links/organization'));
    await admin.getByRole('button', {name:'Guardar accesos de la junta',exact:true}).click();
    expect((await stale).status()).toBe(409);
    await login(guest, 'viewer');
    originalPersonal = await read(guest);
    if (!originalPersonal.inherited) {
      expect((await patch(guest, 'personal', { version: originalPersonal.personal_version, common_version: originalPersonal.common_version, inherit: true, items: [] })).ok()).toBe(true);
      await guest.reload();
    }
    await expect(guest.locator('.quick-links button')).toHaveCount(2);
    await expect(guest.locator('.quick-links')).not.toContainText('Actividad de la junta');
    await settings(guest);
    await expect(guest.getByLabel('Modo de accesos rápidos')).toHaveCount(0);
    await guest.getByLabel('Usar los accesos de la junta').uncheck();
    for (let i = 1; i <= 3; i++) await guest.getByLabel(`Personal · Función ${i}`).selectOption('');
    await guest.getByLabel('Personal · Función 1').selectOption('list');
    await guest.getByLabel('Personal · Etiqueta 1').fill('Mis personas');
    await guest.getByLabel('Personal · Etiqueta en inglés 1').fill('My people');
    await guest.getByRole('button', { name: 'Guardar mis accesos' }).click();
    await expect(guest.getByRole('status').filter({ hasText: 'Accesos rápidos guardados' })).toBeVisible();
    await home(guest);
    await expect(guest.locator('.quick-links button')).toHaveCount(1);
    await expect(guest.getByRole('button', { name: 'Mis personas', exact: true })).toBeVisible();
    await guest.reload();
    await expect(guest.getByRole('button', { name: 'Mis personas', exact: true })).toBeVisible();
    const current = await read(guest);
    expect((await patch(guest, 'personal', { version: current.personal_version, common_version: current.common_version, inherit: false, items: [{ function: 'audit', label: 'Prohibido' }] })).status()).toBe(422);
    expect((await patch(guest, 'organization', { version: current.common_version, mode: 'common', items: [] })).status()).toBe(403);
    await settings(guest);
    await guest.getByLabel('Personal · Función 1').selectOption('');
    await guest.getByRole('button', { name: 'Guardar mis accesos' }).click();
    await expect(guest.getByRole('status').filter({ hasText: 'Accesos rápidos guardados' })).toBeVisible();
    await home(guest);
    await expect(guest.locator('.quick-links button')).toHaveCount(0);
    expect((await read(guest)).items).toHaveLength(0);
    await expect(guest.locator('.sidebar').getByRole('button', { name: 'Lista', exact: true })).toBeVisible();
    await settings(guest);
    await guest.getByLabel('Usar los accesos de la junta').check();
    await guest.getByRole('button', { name: 'Guardar mis accesos' }).click();
    await expect(guest.getByRole('status').filter({ hasText: 'Accesos rápidos guardados' })).toBeVisible();
    await home(guest);
    await expect(guest.locator('.quick-links button')).toHaveCount(2);
    await guest.emulateMedia({ reducedMotion: 'reduce' });
    await guest.setViewportSize({ width: 360, height: 800 });
    await guest.screenshot({ path: '.local/quick-links-mobile.png', animations: 'disabled' });
    expect(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const panel = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Accesos rápidos del panel', exact: true }) });
    await panel.evaluate(el => window.scrollTo(0, scrollY + el.getBoundingClientRect().top - 90));
    await page.screenshot({ path: '.local/quick-links-settings.png', animations: 'disabled' });
    expect(errors).toEqual([]);
  } finally {
    // Restore synthetic users' settings; versions advance rather than being rolled back.
    if (originalPersonal) {
      const now = await read(guest);
      const result = await patch(guest, 'personal', { version: now.personal_version, common_version: now.common_version, inherit: originalPersonal.inherited, items: originalPersonal.personal_items || [] });
      expect(result.ok()).toBe(true);
    }
    const now = await read(page);
    const result = await patch(page, 'organization', { version: now.common_version, mode: initial.mode, items: initial.common_items });
    expect(result.ok()).toBe(true);
    await guestContext.close();
    await adminContext.close();
  }
});
