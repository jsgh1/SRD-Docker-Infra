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

test('birth dates filter inclusively and the visibility setting controls the list',async({page})=>{
  await login(page,'admin');
  const ids=[];
  async function create(date,gender='female') {
    const result=await mutation(page,'POST','/api/v1/persons',{
      document_type:'CC',document_number:'BIRTH-'+ids.length,first_names:'Persona nacimiento',
      status:'pending',gender,birth_date:date,authorization_basis:'Prueba sintética',authorization_purpose:'Verificar filtro de nacimiento',
    });
    expect(result.status()).toBe(200);ids.push((await result.json()).data.id);
  }
  try {
    await create('2000-02-28');await create('2000-02-29');await create('2000-03-01');
    await create('2000-03-01','male');await create(null);
    await navigate(page,'Lista');
    const form=page.getByRole('form',{name:'Filtros de personas'});
    await form.locator('.person-advanced summary').click();
    await expect(form.getByLabel('Nacimiento desde',{exact:true})).toBeVisible();
    await form.getByLabel('Nacimiento desde',{exact:true}).fill('2000-02-29');
    await form.getByLabel('Nacimiento hasta',{exact:true}).fill('2000-03-01');
    await form.getByRole('combobox',{name:'Género',exact:true}).selectOption('female');
    await page.getByRole('button',{name:'Aplicar filtros',exact:true}).click();
    await expect(page.getByText('2 registros encontrados',{exact:true})).toBeVisible();
    await form.getByLabel('Nacimiento hasta',{exact:true}).fill('2000-02-29');
    await page.getByRole('button',{name:'Aplicar filtros',exact:true}).click();
    await expect(page.getByText('1 registros encontrados',{exact:true})).toBeVisible();
    await form.getByLabel('Nacimiento desde',{exact:true}).fill('2001-01-01');
    await form.getByLabel('Nacimiento hasta',{exact:true}).fill('2001-12-31');
    await page.getByRole('button',{name:'Aplicar filtros',exact:true}).click();
    await expect(page.getByText('0 registros encontrados',{exact:true})).toBeVisible();
    const invalid=new URLSearchParams({birth_date_from:'2000-03-01',birth_date_to:'2000-02-29'});
    expect((await page.request.get('/api/v1/persons?'+invalid)).status()).toBe(422);
    await form.getByLabel('Nacimiento desde',{exact:true}).fill('2000-02-29');
    await form.getByLabel('Nacimiento hasta',{exact:true}).fill('2000-03-01');
    await page.getByRole('button',{name:'Aplicar filtros',exact:true}).click();
    await expect(page.getByText('2 registros encontrados',{exact:true})).toBeVisible();
    for(const [name,width] of [['desktop',1280],['mobile',360]]) {
      await page.setViewportSize({width,height:1600});
      if(width===360)await expect.poll(async()=>page.locator('.sidebar').evaluate(el=>el.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
      const group=page.getByRole('group',{name:'Más filtros de la ficha'});
      await group.evaluate(el=>{el.scrollIntoView({block:'start',behavior:'instant'});window.scrollBy({top:-100,behavior:'instant'});});
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await group.screenshot({path:path.join(root,`.local/birth-date-range-${name}.png`)});
    }
    await page.setViewportSize({width:1280,height:800});
    await navigate(page,'Configuración');
    const settings=page.getByRole('region',{name:'Configuración de filtros de personas'});
    await expect(settings.getByRole('checkbox',{name:'Intervalo de nacimiento'})).toBeChecked();
    await settings.getByRole('checkbox',{name:'Intervalo de nacimiento'}).uncheck();
    const response=page.waitForResponse(r=>r.request().method()==='PUT'&&r.url().endsWith('/api/v1/person-filter-settings'));
    await settings.getByRole('button',{name:'Guardar filtros visibles'}).click();
    expect((await response).status()).toBe(200);
    await navigate(page,'Lista');
    await expect(page.getByLabel('Nacimiento desde',{exact:true})).toHaveCount(0);
    const params=new URLSearchParams({birth_date_from:'2000-02-29',birth_date_to:'2000-03-01'});
    expect((await (await page.request.get('/api/v1/persons?'+params)).json()).data.total).toBe(3);
  } finally {
    for(const id of ids)expect((await mutation(page,'DELETE','/api/v1/persons/'+id,{version:1,confirmed:true})).status()).toBe(200);
  }
});
