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

test('private photos through authenticated gateway, conflict, permissions and mobile', async ({page, context, browser}) => {
  test.setTimeout(240000);
  await login(page, 'admin');
  const created = await mutation(page,'POST','/api/v1/persons',{document_type:'CC',document_number:'PHOTO-BROWSER',first_names:'Persona de fotos',status:'pending',authorization_basis:'Prueba local sintética',authorization_purpose:'Verificar fotos'});
  expect(created.status()).toBe(200); const id=(await created.json()).data.id;
  const png=Buffer.from(await page.evaluate(()=>{const c=document.createElement('canvas');c.width=80;c.height=60;const g=c.getContext('2d');g.fillStyle='#245bce';g.fillRect(0,0,80,60);g.fillStyle='#ffffff';g.fillRect(15,15,50,30);return c.toDataURL('image/png').split(',')[1];}),'base64');
  const payload={name:'synthetic.png',mimeType:'image/png',buffer:Buffer.concat([png,Buffer.alloc(1100000,32)])};
  const open=async p=>{await navigate(p,'Lista');await p.getByRole('button',{name:'Ver Persona de fotos',exact:true}).click();await expect(p.getByRole('region',{name:'Fotografías de la ficha'})).toBeVisible();};
  let editor; let viewerContext;
  try {
    await open(page);
    const card=page.getByRole('article',{name:'Foto de la persona',exact:true});
    await expect(card.getByText('Sin fotografía',{exact:true})).toBeVisible({timeout:90000});
    expect((await page.request.put(`/api/v1/persons/${id}/photos/person`,{data:{name:'x.png',content:png.toString('base64'),version:0}})).status()).toBe(419);
    await card.getByLabel('Agregar fotografía').setInputFiles(payload);
    await expect(card.getByRole('status')).toHaveText('Fotografía guardada.',{timeout:90000});
    await expect(card.getByRole('img')).toBeVisible();
    const thumbnailWidth=await card.getByRole('img').evaluate(e=>e.getBoundingClientRect().width);
    await card.getByRole('button',{name:'Ampliar foto de la persona'}).click();
    const expanded=page.getByRole('dialog',{name:'Foto de la persona',exact:true});
    await expect(expanded.getByRole('img')).toBeVisible();
    expect(await expanded.getByRole('img').evaluate(e=>e.getBoundingClientRect().width)).toBeGreaterThan(thumbnailWidth);
    await page.keyboard.press('Escape'); await expect(page.getByRole('dialog',{name:'Detalle de persona'})).toBeVisible();
    for(const label of ['Foto del documento','Foto del predio']) {
      const target=page.getByRole('article',{name:label,exact:true});
      await target.getByLabel('Agregar fotografía').setInputFiles({name:'synthetic.png',mimeType:'image/png',buffer:png});
      await expect(target.getByRole('status')).toHaveText('Fotografía guardada.',{timeout:90000});
    }
    editor=await context.newPage(); await editor.goto('/'); await open(editor);
    const stale=editor.getByRole('article',{name:'Foto de la persona',exact:true});await expect(stale.getByRole('img')).toBeVisible();
    await card.getByLabel('Reemplazar fotografía').setInputFiles({name:'updated.png',mimeType:'image/png',buffer:png});
    await expect(card.getByRole('status')).toHaveText('Fotografía guardada.',{timeout:90000});
    await stale.getByLabel('Reemplazar fotografía').setInputFiles({name:'stale.png',mimeType:'image/png',buffer:png});
    await expect(stale.getByRole('alert')).toContainText('cambió',{timeout:90000});
    await expect(stale.locator('input[type=file]')).toBeDisabled();
    await stale.getByRole('button',{name:'Recargar fotografía'}).click();await expect(stale.locator('input[type=file]')).toBeEnabled();
    await card.getByLabel('Reemplazar fotografía').setInputFiles({name:'invalid.svg',mimeType:'image/svg+xml',buffer:Buffer.from('<svg/>')});
    await expect(card.getByRole('alert')).toContainText('JPEG, PNG o WebP');
    await card.getByRole('button',{name:'Recargar fotografía'}).click();
    await expect(card.getByRole('img')).toBeVisible();
    await page.getByRole('region',{name:'Fotografías de la ficha'}).scrollIntoViewIfNeeded();
    await page.screenshot({path:path.join(root,'.local/photos-desktop.png'),animations:'disabled'});
    await page.setViewportSize({width:360,height:800});
    await card.scrollIntoViewIfNeeded();
    expect(await page.getByRole('dialog',{name:'Detalle de persona'}).evaluate(e=>e.scrollWidth<=e.clientWidth)).toBeTruthy();
    await page.screenshot({path:path.join(root,'.local/photos-mobile.png'),animations:'disabled'});
    viewerContext=await browser.newContext(); const viewer=await viewerContext.newPage(); await login(viewer,'viewer');await open(viewer);
    const readonly=viewer.getByRole('region',{name:'Fotografías de la ficha'});await expect(readonly.getByRole('img')).toHaveCount(3);await expect(readonly.locator('input[type=file]')).toHaveCount(0);
    expect((await mutation(viewer,'PUT',`/api/v1/persons/${id}/photos/person`,{name:'x.png',content:png.toString('base64'),version:2})).status()).toBe(403);
    await card.getByRole('button',{name:'Eliminar fotografía',exact:true}).click();
    await card.getByRole('button',{name:'Cancelar',exact:true}).click();await expect(card.getByRole('img')).toBeVisible();
    await card.getByRole('button',{name:'Eliminar fotografía',exact:true}).click();await card.getByRole('button',{name:'Confirmar eliminación'}).click();
    await expect(card.getByText('Sin fotografía',{exact:true})).toBeVisible();
    await page.setViewportSize({width:1280,height:900}); await page.reload(); await open(page);await expect(page.getByRole('article',{name:'Foto de la persona',exact:true}).getByText('Sin fotografía',{exact:true})).toBeVisible();
  } finally {
    if(editor)await editor.close();if(viewerContext)await viewerContext.close();
    const photos=await page.request.get(`/api/v1/persons/${id}/photos`);
    if(photos.ok())for(const photo of (await photos.json()).data.items)if(photo.present)expect((await mutation(page,'DELETE',`/api/v1/persons/${id}/photos/${photo.slot}`,{confirmed:true,version:photo.version})).status()).toBe(200);
    expect((await mutation(page,'DELETE',`/api/v1/persons/${id}`,{version:1,confirmed:true})).status()).toBe(200);
  }
});
