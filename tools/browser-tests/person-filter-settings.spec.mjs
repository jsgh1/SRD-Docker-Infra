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
  const token = (await (await page.request.get('/api/v1/csrf', { timeout: 10000 })).json()).data.token;
  return page.request.fetch(url, { method, data, headers: { 'X-CSRF-TOKEN': token }, timeout: 10000 });
}

test('junta filter selection persists, delegates cannot grant and revocation rejects an open form',async({page,browser})=>{
  test.setTimeout(240000);
  await login(page,'admin');
  const fields=[['Sector visible','Visible sector'],['Referencia oculta','Hidden reference']].map(([label,label_en])=>({id:crypto.randomUUID(),label,label_en,type:'text',active:true,required:false,options:[]}));
  expect((await mutation(page,'PUT','/api/v1/person-fields',{version:0,fields})).status()).toBe(200);
  const created=await mutation(page,'POST','/api/v1/persons',{document_type:'CC',document_number:'VISIBLE-1',first_names:'Persona sintética',status:'pending',gender:'female',zone:'urban',schema_version:1,custom_values:{[fields[0].id]:'Norte'},authorization_basis:'Prueba',authorization_purpose:'Filtros visibles'});
  expect(created.status()).toBe(200);const id=(await created.json()).data.id;
  const viewerContext=await browser.newContext({baseURL:process.env.SRD_TEST_URL || 'http://127.0.0.1:5173'});
  const viewer=await viewerContext.newPage();
  const stale=await page.context().newPage();
  const panel=p=>p.getByRole('region',{name:'Configuración de filtros de personas'});
  async function save(p,status=200){
    const response=p.waitForResponse(r=>r.request().method()==='PUT'&&r.url().endsWith('/api/v1/person-filter-settings'), { timeout: 10000 });
    await panel(p).getByRole('button',{name:'Guardar filtros visibles',exact:true}).click({ timeout: 10000 });
    expect((await response).status()).toBe(status);
  }
  try {
    await navigate(page,'Configuración');
    await expect(panel(page).getByRole('checkbox',{name:'Género',exact:true})).toBeChecked();
    await stale.goto('/');
    await expect(stale.locator('.sidebar').getByRole('button',{name:'Home',exact:true})).toBeVisible();
    await navigate(stale,'Configuración');
    await expect(panel(stale).getByRole('checkbox',{name:'Género',exact:true})).toBeChecked();
    for(const label of ['Estado','Zona','Afiliación','Tipo de documento','Rol en la comunidad','Cargo','Intervalo de nacimiento','Intervalo de registro','Referencia oculta']) await panel(page).getByRole('checkbox',{name:label,exact:true}).uncheck({timeout:10000});
    await panel(page).getByRole('checkbox',{name:'Permitir a Consultor',exact:true}).check();
    await save(page);
    await save(stale,409);
    await expect(panel(stale).getByRole('alert')).toBeVisible();
    expect((await page.request.put('/api/v1/person-filter-settings',{data:{version:1,base:[],custom:[]}})).status()).toBe(419);
    await login(viewer,'viewer');
    await navigate(viewer,'Configuración');
    await expect(panel(viewer).getByRole('checkbox',{name:'Género',exact:true})).toBeChecked();
    await expect(panel(viewer).getByRole('checkbox',{name:'Permitir a Consultor',exact:true})).toHaveCount(0);
    expect((await mutation(viewer,'PUT','/api/v1/person-filter-settings',{version:1,base:[],custom:[],delegated_roles:['viewer']})).status()).toBe(403);
    await panel(viewer).getByRole('checkbox',{name:'Zona',exact:true}).check();
    await save(viewer);
    await panel(page).getByRole('button',{name:'Descartar cambios y recargar filtros'}).click();
    await expect(panel(page).getByRole('checkbox',{name:'Zona',exact:true})).toBeChecked();
    await page.setViewportSize({width:1280,height:1600});
    await panel(page).evaluate(el=>{el.scrollIntoView({block:'start',behavior:'instant'});window.scrollBy({top:-100,behavior:'instant'});});
    await panel(page).screenshot({path:path.join(root,'.local/filter-settings-desktop.png')});
    await page.setViewportSize({width:360,height:1600});
    await expect.poll(async()=>page.locator('.sidebar').evaluate(el=>el.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
    await panel(page).evaluate(el=>{el.scrollIntoView({block:'start',behavior:'instant'});window.scrollBy({top:-100,behavior:'instant'});});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
    await panel(page).screenshot({path:path.join(root,'.local/filter-settings-mobile.png')});
    await page.setViewportSize({width:1280,height:900});
    await panel(page).getByRole('checkbox',{name:'Permitir a Consultor',exact:true}).uncheck();
    await save(page);
    await save(viewer,403);
    await panel(viewer).getByRole('button',{name:'Descartar cambios y recargar filtros'}).click();
    await expect(panel(viewer)).toHaveCount(0);
    await navigate(page,'Lista');
    const form=page.getByRole('form',{name:'Filtros de personas'});
    await form.locator('summary').filter({hasText:'Más filtros de la ficha'}).click();
    await expect(form.getByRole('combobox',{name:'Género',exact:true})).toBeVisible();
    await expect(form.getByRole('combobox',{name:'Zona',exact:true})).toBeVisible();
    for(const name of ['Estado','Afiliación','Tipo de documento','Rol en la comunidad','Cargo']) await expect(form.getByRole('combobox',{name,exact:true})).toHaveCount(0);
    await page.getByRole('button',{name:'Agregar filtro adicional',exact:true}).click();
    await expect(page.getByLabel('Campo adicional 1').locator('option')).toHaveCount(1);
    await page.getByLabel('Valor del filtro 1').fill('Norte');
    await form.getByRole('combobox',{name:'Género',exact:true}).selectOption('female');
    await page.getByRole('button',{name:'Aplicar filtros',exact:true}).click();
    await expect(page.getByText('1 registros encontrados',{exact:true})).toBeVisible();
    await page.setViewportSize({width:360,height:800});
    await expect.poll(async()=>page.locator('.sidebar').evaluate(el=>el.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
    await page.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
    await page.screenshot({path:path.join(root,'.local/filter-settings-list-mobile.png'),fullPage:true});
    await page.reload();
    await page.setViewportSize({width:1280,height:900});
    await expect(page.locator('.sidebar').getByRole('button',{name:'Home',exact:true})).toBeAttached();
    await navigate(page,'Lista');
    await form.locator('summary').filter({hasText:'Más filtros de la ficha'}).click();
    await expect(form.getByRole('combobox',{name:'Género',exact:true})).toBeVisible();
    await expect(form.getByRole('combobox',{name:'Cargo',exact:true})).toHaveCount(0);
    await navigate(page,'Configuración');
    await page.locator('.profile-trigger').click();
    await page.getByLabel('Idioma', { exact: true }).selectOption('en');
    await page.locator('.profile-trigger').click();
    const englishPanel=page.getByRole('region',{name:'People filter settings'});
    await expect(englishPanel.getByRole('heading',{name:'Visible people filters'})).toBeVisible();
    await expect(englishPanel.getByRole('checkbox',{name:'Gender',exact:true})).toBeChecked();
    await expect(englishPanel.getByRole('checkbox',{name:'Visible sector',exact:true})).toBeVisible();
    await expect(englishPanel.getByRole('button',{name:'Save visible filters'})).toBeVisible();
    expect((await mutation(page,'DELETE','/api/v1/persons/'+id,{version:1,confirmed:true})).status()).toBe(200);
  } finally {
    await stale.close(); await viewerContext.close();
  }
});
