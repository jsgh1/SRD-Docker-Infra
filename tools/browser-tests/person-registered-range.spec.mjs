import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '../..');
const fixture = JSON.parse(fs.readFileSync(process.env.SRD_BROWSER_FIXTURE || path.join(root, '.local/e2e-fixture.json')));
async function login(page) {
  await page.goto(`/j/${fixture.codeA || 'srd-e2e-a'}/login`);
  await page.getByLabel('Correo electrónico', { exact:true }).fill(fixture.users.admin.email);
  await page.getByLabel('Contraseña', { exact:true }).fill(fixture.password);
  await page.getByRole('button', { name:'términos y condiciones', exact:true }).click();
  await page.getByRole('button', { name:'Aceptar términos', exact:true }).click();
  await page.getByRole('button', { name:'Ingresar', exact:true }).click();
  await expect(page.getByRole('heading', { name:'Ingresa tu código' })).toBeVisible();
  let message;
  const url = process.env.SRD_MAILPIT_URL || 'http://127.0.0.1:8125';
  await expect.poll(async () => {
    const list = await (await page.request.get(`${url}/api/v1/messages`)).json();
    message = list.messages?.find(m => m.Subject === 'Tu código de seguridad de SRD' && m.To.some(t => t.Address === fixture.users.admin.email));
    return !!message;
  }).toBe(true);
  const content = await (await page.request.get(`${url}/api/v1/message/${message.ID}`)).json();
  await page.getByLabel('Código de verificación').fill(content.Text.match(/\b\d{6}\b/)[0]);
  await page.getByRole('button', { name:'Confirmar código' }).click();
  await expect(page.locator('.sidebar').getByRole('button', { name:'Home', exact:true })).toBeVisible();
}
async function mutation(page, method, url, data) {
  const token = (await (await page.request.get('/api/v1/csrf')).json()).data.token;
  return page.request.fetch(url, { method, data, headers:{'X-CSRF-TOKEN':token} });
}
function bogotaDate(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {timeZone:'America/Bogota',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date).map(p=>[p.type,p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
test('registration interval follows the Bogota calendar and visibility policy', async ({page}) => {
  await login(page);
  const ids=[];
  const suffix=Date.now().toString(36).toUpperCase();
  const name=`RegistroFecha${suffix}`;
  const today=bogotaDate(new Date());
  const yesterday=bogotaDate(new Date(Date.now()-86400000));
  async function create(gender) {
    const result=await mutation(page,'POST','/api/v1/persons',{
      document_type:'CC',document_number:`REG-${suffix}-${ids.length}`,first_names:name,
      status:'pending',gender,authorization_basis:'Prueba sintética',authorization_purpose:'Verificar filtro de registro',
    });
    expect(result.status()).toBe(200);
    ids.push((await result.json()).data.id);
  }
  try {
    await create('female');await create('female');await create('male');
    await page.locator('.sidebar').getByRole('button',{name:'Lista',exact:true}).click();
    const form=page.getByRole('form',{name:'Filtros de personas'});
    await form.locator('.person-advanced summary').click();
    await expect(form.getByLabel('Registro desde',{exact:true})).toBeVisible();
    await form.getByLabel('Buscar',{exact:true}).fill(name);
    await form.getByLabel('Registro desde',{exact:true}).fill(today);
    await form.getByLabel('Registro hasta',{exact:true}).fill(today);
    await form.getByRole('combobox',{name:'Género',exact:true}).selectOption('female');
    await page.getByRole('button',{name:'Aplicar filtros',exact:true}).click();
    await expect(page.getByText('2 registros encontrados',{exact:true})).toBeVisible();
    await form.getByLabel('Registro desde',{exact:true}).fill(yesterday);
    await form.getByLabel('Registro hasta',{exact:true}).fill(yesterday);
    await page.getByRole('button',{name:'Aplicar filtros',exact:true}).click();
    await expect(page.getByText('0 registros encontrados',{exact:true})).toBeVisible();
    const invalid=new URLSearchParams({registered_from:today,registered_to:yesterday});
    expect((await page.request.get('/api/v1/persons?'+invalid)).status()).toBe(422);
    expect((await page.request.get('/api/v1/persons?registered_from='+today)).status()).toBe(422);
    await form.getByLabel('Registro desde',{exact:true}).fill(today);
    await form.getByLabel('Registro hasta',{exact:true}).fill(today);
    await page.getByRole('button',{name:'Aplicar filtros',exact:true}).click();
    await expect(page.getByText('2 registros encontrados',{exact:true})).toBeVisible();
    for(const [label,width] of [['desktop',1280],['mobile',360]]) {
      await page.setViewportSize({width,height:1600});
      if(width===360) await expect.poll(async()=>page.locator('.sidebar').evaluate(el=>el.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
      const group=page.getByRole('group',{name:'Más filtros de la ficha'});
      await group.evaluate(el=>{el.scrollIntoView({block:'start',behavior:'instant'});window.scrollBy({top:-100,behavior:'instant'});});
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await group.screenshot({path:path.join(root,`.local/registered-range-${label}.png`)});
    }
    await page.setViewportSize({width:1280,height:800});
    await page.locator('.sidebar').getByRole('button',{name:'Configuración',exact:true}).click();
    const settings=page.getByRole('region',{name:'Configuración de filtros de personas'});
    await expect(settings.getByRole('checkbox',{name:'Intervalo de registro'})).toBeChecked();
    await settings.getByRole('checkbox',{name:'Intervalo de registro'}).uncheck();
    const saved=page.waitForResponse(r=>r.request().method()==='PUT'&&r.url().endsWith('/api/v1/person-filter-settings'));
    await settings.getByRole('button',{name:'Guardar filtros visibles'}).click();
    expect((await saved).status()).toBe(200);
    await page.locator('.sidebar').getByRole('button',{name:'Lista',exact:true}).click();
    await expect(page.getByLabel('Registro desde',{exact:true})).toHaveCount(0);
    const direct=new URLSearchParams({q:name,registered_from:today,registered_to:today});
    expect((await (await page.request.get('/api/v1/persons?'+direct)).json()).data.total).toBe(3);
  } finally {
    for(const id of ids) expect((await mutation(page,'DELETE','/api/v1/persons/'+id,{version:1,confirmed:true})).status()).toBe(200);
  }
});
