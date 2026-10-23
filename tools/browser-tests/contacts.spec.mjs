import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '../..');
const fixture = JSON.parse(fs.readFileSync(process.env.SRD_BROWSER_FIXTURE || path.join(root, '.local/e2e-fixture.json')));
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
async function navigate(page, name) { await page.locator('.sidebar').getByRole('button', { name, exact: true }).click(); }
async function mutation(page, method, url, data) {
  const token = (await (await page.request.get('/api/v1/csrf')).json()).data.token;
  return page.request.fetch(url, { method, data, headers: { 'X-CSRF-TOKEN': token } });
}


test('contacts scope directory and mask invisible presence across accounts', async ({ page, browser }) => {
  await login(page,'admin');
  await navigate(page,'Contactos');
  const directory=page.getByRole('region',{name:'Directorio de contactos'});
  await expect(directory.locator('.contact-card')).toHaveCount(5);
  await expect(directory.getByText('Prueba Admin',{exact:true})).toHaveCount(0);
  const result=(await (await page.request.get('/api/v1/contacts')).json()).data;
  expect(Object.keys(result.items[0]).sort()).toEqual(['id','name','presence','role','title','title_en']);
  await directory.getByLabel('Buscar contacto').fill('sin coincidencias');
  await directory.getByRole('button',{name:'Buscar',exact:true}).click();
  await expect(directory.getByText('Sin contactos',{exact:true})).toBeVisible();
  await expect(directory.getByLabel('Buscar contacto')).toHaveValue('sin coincidencias');
  await directory.getByRole('button',{name:'Limpiar',exact:true}).click();
  await expect(directory.locator('.contact-card')).toHaveCount(5);
  const context=await browser.newContext(); const viewer=await context.newPage();
  try {
    await login(viewer,'viewer');
    expect((await (await viewer.request.get('/api/v1/contacts')).json()).data.total).toBe(5);
    for(const [preference,publicState] of [['invisible','offline'],['away','away']]) {
      expect((await mutation(viewer,'PATCH','/api/v1/profile',{name:'Prueba Viewer',theme:'light',presence:preference})).ok()).toBeTruthy();
      expect((await mutation(viewer,'POST','/api/v1/presence/heartbeat',{})).ok()).toBeTruthy();
      await expect(directory.locator('.contact-card').filter({hasText:'Prueba Viewer'}).locator('.presence-status')).toHaveAttribute('data-state',publicState,{timeout:45000});
    }
    await page.route('**/api/v1/contacts?*', route => route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{message:'Fallo temporal de contactos'}})}));
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(directory.getByRole('alert')).toContainText('Fallo temporal');
    await expect(directory.locator('.contact-card')).toHaveCount(0);
    await page.unroute('**/api/v1/contacts?*');
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(directory.locator('.contact-card')).toHaveCount(5);
    let deniedCalls = 0;
    await page.route('**/api/v1/contacts?*', route => { deniedCalls++; return route.fulfill({status:401,contentType:'application/json',body:JSON.stringify({error:{message:'Sesion vencida'}})}); });
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(directory.getByRole('alert')).toContainText('Sesion vencida');
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForTimeout(600);
    expect(deniedCalls).toBe(1);
    await page.unroute('**/api/v1/contacts?*');
    await directory.getByRole('button',{name:'Actualizar estados',exact:true}).click();
    await expect(directory.locator('.contact-card')).toHaveCount(5);
    await page.screenshot({path:path.join(root,'.local/contacts-desktop.png')});
    await page.setViewportSize({width:360,height:800});
    await expect.poll(async () => page.locator('.sidebar').evaluate(el => el.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
    await page.screenshot({path:path.join(root,'.local/contacts-mobile.png'),fullPage:true,animations:'disabled'});
    expect((await mutation(viewer,'POST','/api/v1/auth/logout',{})).ok()).toBeTruthy();
    await directory.getByRole('button',{name:'Actualizar estados',exact:true}).click();
    await expect(directory.locator('.contact-card').filter({hasText:'Prueba Viewer'}).locator('.presence-status')).toHaveAttribute('data-state','offline');
  } finally { await context.close(); }
});
