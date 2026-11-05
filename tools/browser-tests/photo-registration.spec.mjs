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

test('new person can continue with photos without duplicate creation, recover upload and skip',async({page})=>{
  test.setTimeout(240000);
  await login(page,'admin');
  let creates=0;const ids=[];
  page.on('request',r=>{if(r.method()==='POST'&&new URL(r.url()).pathname==='/api/v1/persons')creates++;});
  async function register(document,name,button){
    await page.getByRole('button',{name:'Nuevo registro',exact:true}).click();
    await page.getByLabel('Tipo de documento').selectOption('CC');
    await page.getByLabel('Número de documento').fill(document);
    await page.getByLabel('Nombres',{exact:false}).fill(name);
    await page.getByLabel('Fundamento o referencia del soporte').fill('Prueba sintética local');
    await page.getByLabel('Finalidad de la captura').fill('Verificar fotografías durante registro');
    const response=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/v1/persons');
    await page.getByRole('button',{name:button,exact:true}).click();
    const saved=await response;expect(saved.status()).toBe(200);const id=(await saved.json()).data.id;ids.push(id);return id;
  }
  try{
    const id=await register('PHOTO-REGISTER-1','Registro con fotos','Guardar y añadir fotos');
    await expect(page.getByRole('heading',{name:'Fotografías del nuevo registro'})).toBeVisible();
    const card=page.getByRole('article',{name:'Foto de la persona',exact:true});
    await expect(card.getByText('Sin fotografía',{exact:true})).toBeVisible({timeout:90000});
    await expect(page.getByRole('button',{name:'Guardar y añadir fotos',exact:true})).toHaveCount(0);
    const bytes=Buffer.from(await page.evaluate(()=>{const c=document.createElement('canvas');c.width=60;c.height=40;const g=c.getContext('2d');g.fillStyle='#245bce';g.fillRect(0,0,60,40);return c.toDataURL('image/png').split(',')[1];}),'base64');
    const payload={name:'synthetic.png',mimeType:'image/png',buffer:bytes};
    const uploadPath=`**/api/v1/persons/${id}/photos/person`;
    await page.route(uploadPath,route=>route.request().method()==='PUT'?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{message:'Servicio temporalmente no disponible'}})}):route.continue());
    await card.getByLabel('Agregar fotografía').setInputFiles(payload);
    await expect(card.getByRole('alert')).toContainText('temporalmente');
    expect(creates).toBe(1);
    expect((await page.request.get(`/api/v1/persons/${id}`)).status()).toBe(200);
    await page.unroute(uploadPath);
    await card.getByRole('button',{name:'Recargar fotografía'}).click();
    await card.getByLabel('Agregar fotografía').setInputFiles(payload);
    await expect(card.getByRole('status')).toHaveText('Fotografía guardada.',{timeout:90000});
    await expect(card.getByRole('img')).toBeVisible();
    await page.screenshot({path:path.join(root,'.local/photo-registration-desktop.png'),fullPage:true});
    await page.setViewportSize({width:360,height:800});
    await expect.poll(async()=>page.locator('.sidebar').evaluate(el=>el.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
    await page.screenshot({path:path.join(root,'.local/photo-registration-mobile.png'),fullPage:true});
    await page.getByRole('button',{name:'Terminar e ir a la lista'}).click();
    await expect(page.getByRole('heading',{name:'Lista de personas'})).toBeVisible();
    await page.getByRole('button',{name:'Ver Registro con fotos',exact:true}).click();
    await expect(page.getByRole('article',{name:'Foto de la persona',exact:true}).getByRole('img')).toBeVisible();
    await page.getByRole('dialog',{name:'Detalle de persona'}).getByRole('button',{name:'Cerrar',exact:true}).click();
    await page.setViewportSize({width:1280,height:900});
    await register('PHOTO-REGISTER-2','Registro sin fotos','Guardar y añadir fotos');
    await page.getByRole('button',{name:'Terminar e ir a la lista'}).click();
    await expect(page.getByRole('heading',{name:'Lista de personas'})).toBeVisible();
    await register('PHOTO-REGISTER-3','Registro directo','Guardar registro');
    await expect(page.getByRole('heading',{name:'Lista de personas'})).toBeVisible();
    expect(creates).toBe(3);
  }finally{
    for(const id of ids)expect((await mutation(page,'DELETE',`/api/v1/persons/${id}`,{confirmed:true,version:1})).status()).toBe(200);
  }
});
