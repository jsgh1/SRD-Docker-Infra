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

test('date intervals include both endpoints, paginate and preserve exact filters',async({page})=>{
  await login(page,'admin');
  const ids=[];
  const field={id:crypto.randomUUID(),label:'Fecha comunitaria',label_en:'Community date',type:'date',active:true,required:false,options:[]};
  expect((await mutation(page,'PUT','/api/v1/person-fields',{version:0,fields:[field]})).status()).toBe(200);
  async function create(date,gender='female') {
    const result=await mutation(page,'POST','/api/v1/persons',{
      document_type:'CC',document_number:'RANGE-'+ids.length,first_names:'Persona intervalo',status:'pending',gender,
      schema_version:1,custom_values:date?{[field.id]:date}:{},authorization_basis:'Prueba sintética',authorization_purpose:'Verificar intervalos',
    });
    expect(result.status()).toBe(200);ids.push((await result.json()).data.id);
  }
  async function apply(total) {
    await page.getByRole('button',{name:'Aplicar filtros',exact:true}).click();
    await expect(page.getByText(`${total} registros encontrados`,{exact:true})).toBeVisible();
  }
  try {
    for(let i=0;i<9;i++)await create('2024-03-01');
    await create('2024-02-29');await create('2024-03-02');
    await create('2024-02-28');await create('2024-03-03');await create(null);await create('2024-03-01','male');
    field.active=false;
    expect((await mutation(page,'PUT','/api/v1/person-fields',{version:1,fields:[field]})).status()).toBe(200);
    await navigate(page,'Lista');
    const form=page.getByRole('form',{name:'Filtros de personas'});
    await form.locator('summary').filter({hasText:'Más filtros de la ficha'}).click();
    await form.getByRole('combobox',{name:'Género',exact:true}).selectOption('female');
    await page.getByRole('button',{name:'Agregar filtro adicional',exact:true}).click();
    await page.getByLabel('Comparación del filtro 1').selectOption('between');
    await page.getByLabel('Desde (filtro 1)',{exact:true}).fill('2024-02-29');
    await page.getByLabel('Hasta (filtro 1)',{exact:true}).fill('2024-03-02');
    await apply(11);
    await expect(page.locator('tbody tr')).toHaveCount(10);
    await page.getByRole('button',{name:'Siguiente',exact:true}).click();
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await page.getByLabel('Hasta (filtro 1)',{exact:true}).fill('2024-02-29');
    await apply(1);
    await expect(page.getByText('Página 1',{exact:true})).toBeVisible();
    await page.getByLabel('Desde (filtro 1)',{exact:true}).fill('2024-04-01');
    await page.getByLabel('Hasta (filtro 1)',{exact:true}).fill('2024-04-02');
    await apply(0);
    const params=new URLSearchParams({'custom_filters[0][field_id]':field.id,'custom_filters[0][value]':'2024-03-02','custom_filters[0][operator]':'between','custom_filters[0][value_to]':'2024-02-29'});
    expect((await page.request.get('/api/v1/persons?'+params)).status()).toBe(422);
    await page.getByLabel('Desde (filtro 1)',{exact:true}).fill('2024-02-29');
    await page.getByLabel('Hasta (filtro 1)',{exact:true}).fill('2024-03-02');
    await apply(11);
    const filters=page.getByRole('group',{name:'Filtros por campos adicionales',exact:true});
    for(const [name,width] of [['desktop',1280],['mobile',360]]) {
      await page.setViewportSize({width,height:1600});
      if(width===360)await expect.poll(async()=>page.locator('.sidebar').evaluate(el=>el.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
      await filters.evaluate(el=>{el.scrollIntoView({block:'start',behavior:'instant'});window.scrollBy({top:-100,behavior:'instant'});});
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await filters.screenshot({path:path.join(root,`.local/date-ranges-${name}.png`)});
    }
    await page.setViewportSize({width:1280,height:800});
    await page.getByLabel('Comparación del filtro 1').selectOption('eq');
    await expect(page.getByLabel('Hasta (filtro 1)',{exact:true})).toHaveCount(0);
    await page.getByLabel('Valor del filtro 1').fill('2024-03-01');
    await apply(9);
    await page.getByRole('button',{name:'Limpiar filtros',exact:true}).click();
    await expect(page.getByText('15 registros encontrados',{exact:true})).toBeVisible();
    await expect(page.getByLabel('Comparación del filtro 1')).toHaveCount(0);
  } finally {
    for(const id of ids)expect((await mutation(page,'DELETE','/api/v1/persons/'+id,{version:1,confirmed:true})).status()).toBe(200);
  }
});
