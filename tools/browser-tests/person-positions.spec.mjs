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

test('position catalog persists, protects history and rejects stale forms', async ({page, context, browser}) => {
  await login(page, 'admin'); await navigate(page, 'Configuración');
  const panel = page.getByRole('region', {name:'Catálogo de cargos'});
  await panel.getByRole('button',{name:'Agregar cargo',exact:true}).click();
  await panel.getByLabel('Cargo 7',{exact:true}).fill('Vocal histórico');
  await panel.getByLabel('Cargo 7 en inglés',{exact:true}).fill('Historical committee member');
  expect((await page.request.put('/api/v1/person-positions',{data:{version:0,items:[]}})).status()).toBe(419);
  await panel.getByRole('button',{name:'Guardar cargos',exact:true}).click();
  await expect(panel.getByRole('status')).toHaveText('Cargos guardados.');
  await page.reload(); await navigate(page, 'Configuración');
  await expect(panel.getByLabel('Cargo 7',{exact:true})).toHaveValue('Vocal histórico');
  await expect(panel.getByLabel('Cargo 7 en inglés',{exact:true})).toHaveValue('Historical committee member');
  const catalog = (await (await page.request.get('/api/v1/person-positions')).json()).data;
  await navigate(page, 'Registro');
  await page.getByRole('combobox',{name:/Tipo de documento/}).selectOption('CC');
  await page.getByLabel('Número de documento').fill('POSITION-TEST');
  await page.getByLabel('Nombres',{exact:false}).fill('Persona de cargos');
  await page.getByRole('combobox',{name:'Cargo',exact:true}).selectOption({label:'Vocal histórico'});
  await page.getByLabel('Fundamento o referencia del soporte').fill('Prueba local');
  await page.getByLabel('Finalidad de la captura').fill('Validar catálogo de cargos');
  const created = page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/persons' && r.request().method()==='POST');
  await page.getByRole('button',{name:'Guardar registro',exact:true}).click();
  const response = await created; expect(response.ok()).toBeTruthy(); const id = (await response.json()).data.id;
  let version = 1;
  const editor = await context.newPage();
  try {
    await editor.goto('/'); await navigate(editor,'Lista');
    await editor.getByRole('button',{name:'Editar Persona de cargos',exact:true}).click();
    await expect(editor.getByRole('combobox',{name:'Cargo',exact:true})).toHaveValue(catalog.items[6].code);
    await navigate(page,'Configuración');
    await panel.getByLabel('Cargo 7',{exact:true}).fill('Vocal renombrado');
    await panel.getByLabel('Cargo 7 en inglés',{exact:true}).fill('Renamed committee member');
    await panel.getByLabel('Cargo 7 activo',{exact:true}).uncheck();
    await panel.getByRole('button',{name:'Guardar cargos',exact:true}).click();
    await expect(panel.getByRole('status')).toHaveText('Cargos guardados.');
    await panel.evaluate(el=>scrollTo(0,scrollY+el.getBoundingClientRect().top-90));
    await page.screenshot({path:path.join(root,'.local/positions-desktop.png'),animations:'disabled'});
    await page.setViewportSize({width:360,height:800});
    await expect.poll(()=>page.locator('.sidebar').evaluate(e=>e.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
    await panel.evaluate(el=>scrollTo(0,scrollY+el.getBoundingClientRect().top-90));
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
    await page.screenshot({path:path.join(root,'.local/positions-mobile.png'),animations:'disabled'});
    const stale = editor.waitForResponse(r=>new URL(r.url()).pathname===`/api/v1/persons/${id}` && r.request().method()==='PATCH');
    await editor.getByRole('button',{name:'Guardar cambios',exact:true}).click(); expect((await stale).status()).toBe(409);
    await editor.getByRole('button',{name:'Recargar configuración de campos'}).click();
    await expect(editor.getByRole('option',{name:'Vocal histórico (inactivo)',exact:true})).toHaveCount(1);
    const saved = editor.waitForResponse(r=>new URL(r.url()).pathname===`/api/v1/persons/${id}` && r.request().method()==='PATCH');
    await editor.getByRole('button',{name:'Guardar cambios',exact:true}).click(); expect((await saved).status()).toBe(200); version=2;
    const viewerContext = await browser.newContext();
    try {
      const viewer = await viewerContext.newPage(); await login(viewer,'viewer');
      expect((await mutation(viewer,'PUT','/api/v1/person-positions',catalog)).status()).toBe(403);
      const detail = (await (await viewer.request.get('/api/v1/persons/'+id)).json()).data;
      expect(detail.position_label).toBe('Vocal histórico'); expect(detail.position_label_en).toBe('Historical committee member'); expect(detail.note).toBeUndefined();
      await viewer.locator('.profile-trigger').click();
      await viewer.getByLabel('Idioma', {exact:true}).selectOption('en');
      await expect(viewer.locator('html')).toHaveAttribute('lang','en');
      await navigate(viewer,'List'); await viewer.getByRole('button',{name:'View Persona de cargos',exact:true}).click();
      await expect(viewer.getByRole('dialog')).toContainText('Historical committee member');
    } finally { await viewerContext.close(); }
    await navigate(editor,'Registro');
    await expect(editor.getByRole('combobox',{name:'Cargo',exact:true})).toBeVisible();
    await expect(editor.getByRole('option',{name:/Vocal/})).toHaveCount(0);
  } finally { await editor.close(); expect((await mutation(page,'DELETE','/api/v1/persons/'+id,{version,confirmed:true})).ok()).toBeTruthy(); }
});
