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


test('presence heartbeat protects credentials and restores saved preference', async ({ page }) => {
  await login(page, 'admin');
  await expect(page.locator('.presence-status')).toHaveAttribute('data-state','online');
  expect((await page.request.post('/api/v1/presence/heartbeat')).status()).toBe(419);
  const response = await mutation(page,'POST','/api/v1/presence/heartbeat',{token:'forged',user_id:fixture.users.auditor.id});
  expect(response.ok()).toBeTruthy();
  expect((await response.json()).data.effective).toBe('online');
  await navigate(page,'Configuración');
  await page.locator('select[name="presence"]').selectOption('invisible');
  await page.getByRole('button',{name:'Guardar perfil',exact:true}).click();
  await expect(page.locator('.presence-status')).toHaveAttribute('data-state','invisible');
  const hidden=await mutation(page,'POST','/api/v1/presence/heartbeat',{});
  expect((await hidden.json()).data.effective).toBe('offline');
  await page.reload();
  await expect(page.locator('.presence-status')).toHaveAttribute('data-state','invisible');
  await navigate(page,'Configuración');
  await page.locator('select[name="presence"]').selectOption('dnd');
  await page.getByRole('button',{name:'Guardar perfil',exact:true}).click();
  await expect(page.locator('.presence-status')).toHaveAttribute('data-state','dnd');
  await page.setViewportSize({width:360,height:800});
  await page.evaluate(()=>scrollTo(0,0));
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
  await page.screenshot({path:path.join(root,'.local/presence-mobile.png')});
  await page.route('**/api/v1/presence/heartbeat',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{message:'Temporary test failure'}})}));
  await page.reload();
  await expect(page.locator('.presence-status')).toHaveAttribute('data-state','unconfirmed');
  await page.unroute('**/api/v1/presence/heartbeat');
  await page.reload();
  await expect(page.locator('.presence-status')).toHaveAttribute('data-state','dnd');
  expect((await mutation(page,'POST','/api/v1/auth/logout',{})).ok()).toBeTruthy();
  expect((await mutation(page,'POST','/api/v1/presence/heartbeat',{})).status()).toBe(401);
});
