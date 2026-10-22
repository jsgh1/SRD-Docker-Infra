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
const csrfTokens=new WeakMap();
async function mutation(page, method, url, data) {
  let token=csrfTokens.get(page);
  if(!token){token=(await (await page.request.get('/api/v1/csrf')).json()).data.token;csrfTokens.set(page,token);}
  return page.request.fetch(url, { method, data, headers: { 'X-CSRF-TOKEN': token } });
}

test('base filters combine with custom fields, recover catalog and preserve historical cargos', async ({ page }) => {
  await login(page, 'admin');
  const ids=[];
  const field={id:crypto.randomUUID(),label:'Sector sintético',label_en:'Synthetic sector',type:'text',active:true,required:false,options:[]};
  expect((await mutation(page,'PUT','/api/v1/person-fields',{version:0,fields:[field]})).status()).toBe(200);
  const catalog=(await (await page.request.get('/api/v1/person-positions')).json()).data;
  const code=crypto.randomUUID();
  catalog.items.push({code,label:'Vocal de prueba',label_en:'Test committee member',active:true});
  expect((await mutation(page,'PUT','/api/v1/person-positions',{version:0,items:catalog.items})).status()).toBe(200);
  async function create(extra={}) {
    const result=await mutation(page,'POST','/api/v1/persons',{
      document_type:'CC',document_number:'BASE-'+ids.length,first_names:'Persona filtro base',status:'pending',
      affiliated:true,zone:'urban',gender:'female',descriptive_role:'viewer',position_code:code,
      positions_version:1,schema_version:1,custom_values:{[field.id]:'Norte'},
      authorization_basis:'Prueba sintética',authorization_purpose:'Verificar filtros combinados',...extra,
    });
    expect(result.status()).toBe(200); ids.push((await result.json()).data.id);
  }
  let testFailure;
  try {
    for(let i=0;i<11;i++) await create();
    await create({gender:'male'});
    await create({document_type:'TI'});
    await create({descriptive_role:'registrar'});
    await create({position_code:'fiscal'});
    await create({custom_values:{[field.id]:'Sur'}});
    catalog.items.find(item=>item.code===code).active=false;
    expect((await mutation(page,'PUT','/api/v1/person-positions',{version:1,items:catalog.items})).status()).toBe(200);
    await page.route('**/api/v1/person-positions',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{message:'Catálogo temporalmente no disponible'}})}));
    await navigate(page,'Lista');
    const form=page.getByRole('form',{name:'Filtros de personas'});
    await form.locator('summary').filter({hasText:'Más filtros de la ficha'}).click();
    await expect(page.getByRole('button',{name:'Reintentar cargos'})).toBeVisible();
    await page.unroute('**/api/v1/person-positions');
    await page.getByRole('button',{name:'Reintentar cargos'}).click();
    await expect(form.getByRole('combobox',{name:'Cargo',exact:true})).toBeEnabled();
    await form.getByRole('combobox',{name:'Cargo',exact:true}).selectOption({label:'Vocal de prueba (inactivo)'});
    await form.getByRole('combobox',{name:'Tipo de documento',exact:true}).selectOption('CC');
    await form.getByRole('combobox',{name:'Género',exact:true}).selectOption('female');
    await form.getByRole('combobox',{name:'Rol en la comunidad',exact:true}).selectOption('viewer');
    await form.getByRole('combobox',{name:'Afiliación',exact:true}).selectOption('1');
    await page.getByRole('button',{name:'Agregar filtro adicional',exact:true}).click();
    await page.getByLabel('Valor del filtro 1').fill('Norte');
    await page.getByRole('button',{name:'Aplicar filtros',exact:true}).click();
    await expect(page.getByText('11 registros encontrados',{exact:true})).toBeVisible();
    await expect(page.locator('tbody tr')).toHaveCount(10);
    await page.getByRole('button',{name:'Siguiente',exact:true}).click();
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await expect(page.getByText('Página 2',{exact:true})).toBeVisible();
    await form.getByRole('combobox',{name:'Género',exact:true}).selectOption('other');
    await page.getByRole('button',{name:'Aplicar filtros',exact:true}).click();
    await expect(page.getByText('No encontramos registros',{exact:true})).toBeVisible();
    await expect(page.getByText('Página 1',{exact:true})).toBeVisible();
    await form.getByRole('combobox',{name:'Género',exact:true}).selectOption('female');
    await page.getByRole('button',{name:'Aplicar filtros',exact:true}).click();
    await expect(page.getByText('11 registros encontrados',{exact:true})).toBeVisible();
    await page.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));
    await page.screenshot({path:path.join(root,'.local/person-base-filters-desktop.png'),fullPage:true});
    await page.setViewportSize({width:360,height:800});
    await expect.poll(async()=>page.locator('.sidebar').evaluate(el=>el.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
    await page.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
    await page.screenshot({path:path.join(root,'.local/person-base-filters-mobile.png'),fullPage:true});
    await page.getByRole('button',{name:'Limpiar filtros',exact:true}).click();
    await expect(page.getByText('16 registros encontrados',{exact:true})).toBeVisible();
    await form.locator('summary').filter({hasText:'Más filtros de la ficha'}).click();
    for(const name of ['Cargo','Género','Tipo de documento','Rol en la comunidad']) await expect(form.getByRole('combobox',{name,exact:true})).toHaveValue('');
    await expect(page.getByLabel('Valor del filtro 1')).toHaveCount(0);
    await page.locator('.profile-trigger').click();
    await page.getByLabel('Idioma', { exact: true }).selectOption('en');
    await page.locator('.profile-trigger').click();
    await expect(page.getByRole('heading', { name: 'People', exact: true })).toBeVisible();
    await expect(page.locator('.person-mobile-list dt').filter({hasText:'Registration date'}).first()).toBeVisible();
    await expect(page.getByText('16 records found', { exact: true })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Additional field filters' })).toBeVisible();
    await page.getByRole('button', { name: 'Add additional filter' }).click();
    await expect(page.getByRole('combobox', { name: 'Additional field 1' })).toContainText('Synthetic sector');
    await page.getByRole('button', { name: 'Remove filter 1' }).click();
    await page.getByRole('form',{name:'People filters'}).getByRole('combobox',{name:'Position',exact:true}).selectOption(code);
    await page.getByRole('button',{name:'Apply filters'}).click();
    await expect(page.getByText('15 records found',{exact:true})).toBeVisible();
    await page.getByRole('button', { name: 'View Persona filtro base' }).first().click();
    const detail = page.getByRole('dialog', { name: 'Person details' });
    await expect(detail.getByText('Test committee member')).toBeVisible();
    await expect(detail.getByText('Download record', { exact: true })).toBeVisible();
    const photos = detail.getByRole('region', { name: 'Record photos' });
    await expect(photos.getByRole('heading', { name: 'Photos' })).toBeVisible();
    await expect(photos.getByRole('article', { name: 'Person photo' }).getByText('No photo')).toBeVisible();
    await detail.getByRole('button', { name: 'Close' }).click();
  } catch(error) {
    testFailure=error;
    throw error;
  } finally {
    try {
      const token=csrfTokens.get(page);
      for(const id of ids) expect((await page.request.delete('/api/v1/persons/'+id,{data:{version:1,confirmed:true},headers:{'X-CSRF-TOKEN':token},timeout:10000})).status()).toBe(200);
    } catch(error) { if(!testFailure) throw error; }
  }
});
