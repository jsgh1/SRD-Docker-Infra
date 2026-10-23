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

test('delegated field editor creates usable fields, preserves version conflicts and loses access on revocation',async({page,browser})=>{
  test.setTimeout(240000);
  await login(page,'admin');
  const context=await browser.newContext({baseURL:process.env.SRD_TEST_URL || 'http://127.0.0.1:5173'});
  const viewer=await context.newPage(); let personId;
  const panel=p=>p.getByRole('region',{name:'Configuración de campos adicionales'});
  async function save(p,status=200) {
    const response=p.waitForResponse(r=>r.request().method()==='PUT'&&r.url().endsWith('/api/v1/person-fields'));
    await panel(p).getByRole('button',{name:'Guardar campos adicionales',exact:true}).click();
    expect((await response).status()).toBe(status);
  }
  try {
    await login(viewer,'viewer');
    await navigate(viewer,'Configuración');
    await expect(panel(viewer)).toHaveCount(0);
    await navigate(page,'Configuración');
    await panel(page).getByRole('checkbox',{name:'Delegar campos a Consultor',exact:true}).check();
    await save(page);
    await navigate(viewer,'Home'); await navigate(viewer,'Configuración');
    await expect(panel(viewer).getByRole('button',{name:'Agregar campo',exact:true})).toBeVisible();
    await expect(panel(viewer).getByRole('checkbox',{name:'Delegar campos a Consultor',exact:true})).toHaveCount(0);
    expect((await mutation(viewer,'PUT','/api/v1/person-fields',{version:1,fields:[],delegated_roles:['viewer']})).status()).toBe(403);
    await panel(viewer).getByRole('button',{name:'Agregar campo',exact:true}).click();
    await panel(viewer).getByLabel('Etiqueta del campo').fill('Campo comunitario');
    await panel(viewer).getByLabel('Etiqueta en inglés').fill('Community field');
    await save(viewer);
    await save(page,409);
    await panel(page).getByRole('button',{name:'Descartar cambios y recargar campos'}).click();
    await expect(panel(page).getByLabel('Etiqueta del campo')).toHaveValue('Campo comunitario');
    await page.setViewportSize({width:360,height:1600});
    await expect.poll(async()=>page.locator('.sidebar').evaluate(el=>el.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
    await panel(page).evaluate(el=>{el.scrollIntoView({block:'start',behavior:'instant'});window.scrollBy({top:-100,behavior:'instant'});});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
    await panel(page).screenshot({path:path.join(root,'.local/field-delegations-mobile.png')});
    await page.setViewportSize({width:1280,height:1600});
    await panel(page).evaluate(el=>{el.scrollIntoView({block:'start',behavior:'instant'});window.scrollBy({top:-100,behavior:'instant'});});
    await panel(page).screenshot({path:path.join(root,'.local/field-delegations-desktop.png')});
    await panel(page).getByRole('checkbox',{name:'Delegar campos a Consultor',exact:true}).uncheck();
    await save(page);
    await save(viewer,403);
    await panel(viewer).getByRole('button',{name:'Descartar cambios y recargar campos'}).click();
    await expect(panel(viewer)).toHaveCount(0);
    await navigate(page,'Registro');
    await page.getByRole('combobox',{name:'Tipo de documento *',exact:true}).selectOption('CC');
    await page.getByLabel('Número de documento').fill('DELEGATED-FIELD-1');
    await page.getByLabel('Nombres',{exact:false}).fill('Registro delegado');
    await page.getByLabel('Campo comunitario',{exact:true}).fill('Valor sintético');
    await page.getByLabel('Fundamento o referencia del soporte').fill('Prueba local');
    await page.getByLabel('Finalidad de la captura').fill('Verificar campos delegados');
    const response=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/api/v1/persons'));
    await page.getByRole('button',{name:'Guardar registro',exact:true}).click();
    const saved=await response;expect(saved.status()).toBe(200);personId=(await saved.json()).data.id;
    await page.getByRole('button',{name:'Ver Registro delegado',exact:true}).click();
    await expect(page.getByRole('dialog',{name:'Detalle de persona'}).getByText('Valor sintético',{exact:true})).toBeVisible();
  } finally {
    await context.close();
    if(personId)expect((await mutation(page,'DELETE','/api/v1/persons/'+personId,{version:1,confirmed:true})).status()).toBe(200);
  }
});
