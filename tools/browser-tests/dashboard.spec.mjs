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


test('dashboard refreshes confirmed counts, retries failures and uses server date', async ({ page }) => {
  test.setTimeout(120000);
  await login(page,'admin');
  const total=page.locator('.stat').filter({has:page.getByText('Personas registradas',{exact:true})}).locator('strong');
  await expect(total).toHaveText('0');
  const created=await mutation(page,'POST','/api/v1/persons',{document_type:'CC',document_number:'DASHBOARD-TEST',first_names:'Indicador sintetico',status:'pending',gender:'female',authorization_basis:'Prueba local',authorization_purpose:'Indicadores'});
  expect(created.ok()).toBeTruthy();const id=(await created.json()).data.id;
  try {
    await expect(total).toHaveText('0');
    await page.getByRole('button',{name:'Actualizar indicadores',exact:true}).click();
    await expect(total).toHaveText('1');
    await expect(page.locator('.bar-chart')).toHaveAttribute('aria-label',/: 1/);
    await expect(page.getByText(/Datos consultados:/)).toBeVisible();
    await page.route('**/api/v1/dashboard',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{message:'Fallo temporal de indicadores'}})}));
    await page.getByRole('button',{name:'Actualizar indicadores',exact:true}).click();
    await expect(page.getByRole('alert')).toContainText('Fallo temporal');
    await expect(page.locator('.stat')).toHaveCount(0);
    await expect(page.getByRole('button',{name:'Actualizar indicadores',exact:true})).toBeEnabled();
    await page.unroute('**/api/v1/dashboard');
    await page.route('**/api/v1/dashboard',async route=>{await new Promise(resolve=>setTimeout(resolve,20000));await route.abort().catch(()=>{});});
    await page.getByRole('button',{name:'Actualizar indicadores',exact:true}).click();
    await expect(page.getByRole('alert')).toContainText('La conexión tardó demasiado.',{timeout:19000});
    await expect(page.locator('.stat')).toHaveCount(0);
    await page.unroute('**/api/v1/dashboard');
    await page.route('**/api/v1/dashboard',async route=>{const response=await route.fetch();const body=await response.json();body.data.date='2030-01-02';body.data.generated_at='2030-01-02T12:00:00+00:00';await route.fulfill({response,json:body});});
    await page.getByRole('button',{name:'Actualizar indicadores',exact:true}).click();
    await expect(page.locator('.today-card strong')).toContainText('2030');
    await expect(page.locator('.today-card strong')).toContainText('enero');
    await page.unroute('**/api/v1/dashboard');
    await page.getByRole('button',{name:'Actualizar indicadores',exact:true}).click();
    await expect(total).toHaveText('1');
    await page.screenshot({path:path.join(root,'.local/dashboard-refresh-desktop.png'),animations:'disabled'});
    await page.setViewportSize({width:360,height:800});
    await expect.poll(()=>page.locator('.sidebar').evaluate(el=>el.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
    await page.evaluate(()=>scrollTo(0,0));
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
    await page.screenshot({path:path.join(root,'.local/dashboard-refresh-mobile.png'),fullPage:true,animations:'disabled'});
  } finally { expect((await mutation(page,'DELETE','/api/v1/persons/'+id,{version:1,confirmed:true})).ok()).toBeTruthy(); }
  await page.getByRole('button',{name:'Actualizar indicadores',exact:true}).click();
  await expect(total).toHaveText('0');
});
