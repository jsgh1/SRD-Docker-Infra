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


test('global search separates modules, paginates, protects notes and retries independently', async ({ page, browser }) => {
  await login(page,'admin');
  const ids=[];
  for(let i=0;i<11;i++) {
    const response=await mutation(page,'POST','/api/v1/persons',{document_type:'CC',document_number:'SEARCH-'+i,first_names:'Prueba Busqueda '+i+(i===0?' 50%_!':''),status:'pending',note:'SECRET-NOTE-MARKER',authorization_basis:'Prueba local',authorization_purpose:'Busqueda sintetica'});
    expect(response.ok()).toBeTruthy(); ids.push((await response.json()).data.id);
  }
  const context=await browser.newContext();const viewer=await context.newPage();
  try {
    await login(viewer,'viewer');
    await viewer.getByRole('button',{name:'Buscar en la junta',exact:true}).click();
    const form=viewer.getByRole('form',{name:'Búsqueda de la junta'});
    const persons=viewer.getByRole('region',{name:'Resultados de personas'});
    const contacts=viewer.getByRole('region',{name:'Resultados de contactos'});
    await form.getByLabel('Texto de búsqueda').fill('Prueba');
    await form.getByRole('button',{name:'Buscar',exact:true}).click();
    await expect(persons.getByText('11 coincidencias en personas',{exact:true})).toBeVisible();
    await expect(contacts.locator('.contact-card')).toHaveCount(5);
    await persons.getByRole('button',{name:'Siguiente',exact:true}).click();
    await expect(persons.locator('tbody tr')).toHaveCount(1);
    await expect(contacts.getByText('Página 1',{exact:true})).toBeVisible();
    await persons.getByRole('button',{name:/^Ver Prueba/}).click();
    await expect(viewer.getByRole('dialog')).toBeVisible();
    await expect(viewer.getByRole('dialog').getByText('SECRET-NOTE-MARKER')).toHaveCount(0);
    await viewer.getByRole('dialog').getByRole('button',{name:'Cerrar',exact:true}).click();
    await form.getByLabel('Texto de búsqueda').fill('SECRET-NOTE-MARKER');
    await form.getByRole('button',{name:'Buscar',exact:true}).click();
    await expect(persons.getByText('Sin coincidencias en personas',{exact:true})).toBeVisible();
    await expect(contacts.getByText('Sin coincidencias en contactos',{exact:true})).toBeVisible();
    await expect(form.getByLabel('Texto de búsqueda')).toHaveValue('SECRET-NOTE-MARKER');
    await form.getByLabel('Texto de búsqueda').fill('Prueba');
    await form.getByLabel('Texto de búsqueda').fill('50%_!');
    await form.getByRole('button',{name:'Buscar',exact:true}).click();
    await expect(persons.getByText('1 coincidencias en personas',{exact:true})).toBeVisible();
    await form.getByLabel('Texto de búsqueda').fill('Prueba');
    await viewer.route('**/api/v1/contacts?*',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{message:'Fallo simulado de contactos'}})}));
    await form.getByRole('button',{name:'Buscar',exact:true}).click();
    await expect(persons.locator('tbody tr')).toHaveCount(10);
    await expect(contacts.getByRole('alert')).toBeVisible();
    await viewer.unroute('**/api/v1/contacts?*');
    await contacts.getByRole('button',{name:'Reintentar contactos',exact:true}).click();
    await expect(contacts.locator('.contact-card')).toHaveCount(5);
    await form.getByRole('combobox',{name:'Buscar en',exact:true}).selectOption('contacts');
    await form.getByRole('button',{name:'Buscar',exact:true}).click();
    await expect(persons).toHaveCount(0);
    await expect(contacts.locator('.contact-card')).toHaveCount(5);
    await viewer.screenshot({path:path.join(root,'.local/global-search-desktop.png'),animations:'disabled'});
    await viewer.setViewportSize({width:360,height:800});
    await expect.poll(()=>viewer.locator('.sidebar').evaluate(el=>el.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
    await viewer.evaluate(()=>scrollTo(0,0));
    expect(await viewer.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
    await viewer.screenshot({path:path.join(root,'.local/global-search-mobile.png'),fullPage:true,animations:'disabled'});
    await form.getByRole('button',{name:'Limpiar búsqueda',exact:true}).click();
    await expect(contacts).toHaveCount(0);
    await expect(form.getByLabel('Texto de búsqueda')).toHaveValue('');
  } finally {
    await context.close();
    for(const id of ids) expect((await mutation(page,'DELETE','/api/v1/persons/'+id,{version:1,confirmed:true})).ok()).toBeTruthy();
  }
});
