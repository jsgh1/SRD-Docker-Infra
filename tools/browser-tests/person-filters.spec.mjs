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


test('person filters combine exact values and affiliation, paginate and reset', async ({ page }) => {
  await login(page, 'admin');
  const field = { id: crypto.randomUUID(), label: 'Referencia de prueba', label_en: 'Test reference', type: 'text', active: true, required: false, options: [] };
  expect((await mutation(page, 'PUT', '/api/v1/person-fields', { version: 0, fields: [field] })).ok()).toBeTruthy();
  const ids=[];
  for (let i=0;i<12;i++) {
    const response=await mutation(page,'POST','/api/v1/persons',{document_type:'CC',document_number:'FILTER-'+i,first_names:'Persona filtro',status:'pending',zone:'urban',affiliated:i!==11,schema_version:1,custom_values:{[field.id]:"50%_ O'Reilly"},authorization_basis:'Prueba local',authorization_purpose:'Verificar filtros'});
    expect(response.ok()).toBeTruthy(); ids.push((await response.json()).data.id);
  }
  await navigate(page,'Lista');
  await page.locator('details.person-advanced summary').click();
  await page.getByRole('button',{name:'Agregar filtro adicional',exact:true}).click();
  await page.getByLabel('Valor del filtro 1').fill("50%_ O'Reilly");
  await page.getByRole('combobox',{name:'Afiliación',exact:true}).selectOption('1');
  await page.getByRole('button',{name:'Aplicar filtros',exact:true}).click();
  await expect(page.getByText('11 registros encontrados',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Siguiente',exact:true}).click();
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await page.getByRole('combobox',{name:'Afiliación',exact:true}).selectOption('0');
  await page.getByRole('button',{name:'Aplicar filtros',exact:true}).click();
  await expect(page.getByText('1 registros encontrados',{exact:true})).toBeVisible();
  await page.setViewportSize({width:360,height:800});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
  await page.screenshot({path:path.join(root,'.local/person-filters-mobile.png'),fullPage:true});
  await page.getByRole('button',{name:'Limpiar filtros',exact:true}).click();
  await expect(page.getByText('12 registros encontrados',{exact:true})).toBeVisible();
  await expect(page.getByLabel('Valor del filtro 1')).toHaveCount(0);
  for(const id of ids) expect((await mutation(page,'DELETE','/api/v1/persons/'+id,{version:1,confirmed:true})).ok()).toBeTruthy();
});
