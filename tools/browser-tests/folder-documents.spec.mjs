import { test, expect } from '@playwright/test';
import fs from 'node:fs';
const fixture = JSON.parse(fs.readFileSync(process.env.SRD_BROWSER_FIXTURE));
const mailUrl = process.env.SRD_MAILPIT_URL || 'http://localhost:8025';

async function login(page) {
  await page.goto(`/j/${fixture.codeA}/login`);
  await page.getByLabel('Correo electrónico', { exact: true }).fill(fixture.users.admin.email);
  await page.getByLabel('Contraseña', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: 'términos y condiciones', exact: true }).click();
  await page.getByRole('button', { name: 'Aceptar términos', exact: true }).click();
  await page.getByRole('button', { name: 'Ingresar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ingresa tu código' })).toBeVisible();
  let message;
  await expect.poll(async () => {
    const list = await (await page.request.get(`${mailUrl}/api/v1/messages`)).json();
    message = list.messages?.find(item => item.Subject === 'Tu código de seguridad de SRD' && item.To.some(to => to.Address === fixture.users.admin.email));
    return !!message;
  }, { timeout: 85000 }).toBe(true);
  const content = await (await page.request.get(`${mailUrl}/api/v1/message/${message.ID}`)).json();
  await page.getByLabel('Código de verificación').fill(content.Text.match(/\b\d{6}\b/)[0]);
  await page.getByRole('button', { name: 'Confirmar código' }).click();
  await expect(page.locator('.sidebar').getByRole('button', { name: 'Home', exact: true })).toBeVisible();
}

test('private Office documents upload rename and download with version guards', async ({ page }) => {
  test.setTimeout(240000);
  await login(page);
  await page.getByRole('button',{name:'Carpeta',exact:true}).click();
  const panel=page.getByRole('region',{name:'Archivos privados'});
  await expect(panel.getByRole('heading', { name: 'No hay archivos en esta ubicación' })).toBeVisible();
  for(const ext of ['docx','xlsx']){
    const bytes=fs.readFileSync(`.local/office-fixture.${ext}`);
    await panel.locator('input.folder-file-input').setInputFiles({name:`Prueba.${ext}`,mimeType:'application/octet-stream',buffer:bytes});
    if(ext==='docx'){
      await Promise.all([page.waitForResponse(response=>new URL(response.url()).pathname==='/api/v1/folders'&&response.request().method()==='GET'),page.getByRole('button',{name:'Actualizar carpetas',exact:true}).click()]);
      await expect(panel.getByLabel('Nombre del archivo')).toHaveValue('Prueba.docx');
      await expect(panel.getByRole('button',{name:'Guardar archivo',exact:true})).toBeEnabled();
    }
    await panel.getByRole('button',{name:'Guardar archivo',exact:true}).click();
    await expect(panel.getByText('Documento guardado y analizado.')).toBeVisible({timeout:35000});
    await expect(panel.getByRole('button',{name:`Descargar Prueba.${ext}`,exact:true})).toBeVisible();
    const [download]=await Promise.all([page.waitForEvent('download'),panel.getByRole('button',{name:`Descargar Prueba.${ext}`,exact:true}).click()]);
    expect(download.suggestedFilename()).toBe(`Prueba.${ext}`);
    const stream=await download.createReadStream();const chunks=[];for await(const c of stream)chunks.push(c);
    expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
  }
  await page.reload();
  await page.getByRole('button',{name:'Carpeta',exact:true}).click();
  await expect(panel.getByText('2 archivos en esta ubicación.')).toBeVisible();
  const list=await (await page.request.get('/api/v1/folder-documents')).json();
  const original=list.data.items.find(item=>item.name==='Prueba.docx');
  const token=(await (await page.request.get('/api/v1/csrf')).json()).data.token;
  await panel.getByRole('button',{name:'Renombrar documento Prueba.docx',exact:true}).click();
  const rename=page.getByRole('dialog',{name:'Renombrar documento: Prueba.docx'});
  await expect(rename).toBeVisible();await page.keyboard.press('Escape');await expect(rename).not.toBeVisible();
  await panel.getByRole('button',{name:'Renombrar documento Prueba.docx',exact:true}).click();
  await rename.getByLabel('Nuevo nombre del archivo').fill('Informe.pdf');
  await rename.getByRole('button',{name:'Guardar nuevo nombre',exact:true}).click();
  await expect(rename.getByRole('alert')).toContainText('Conserva la extensión .docx');
  await rename.getByLabel('Nuevo nombre del archivo').fill('Prueba.xlsx');
  await rename.getByRole('button',{name:'Guardar nuevo nombre',exact:true}).click();
  await expect(rename.getByRole('alert')).toBeVisible();
  await rename.getByLabel('Nuevo nombre del archivo').fill('Informe final.docx');
  await page.setViewportSize({width:360,height:800});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.screenshot({path:'.local/document-rename-mobile.png'});
  let release,received;const gate=new Promise(resolve=>release=resolve),responseReceived=new Promise(resolve=>received=resolve);
  const renameUrl=`**/api/v1/folder-documents/${original.id}`;
  await page.route(renameUrl,async route=>{const response=await route.fetch();received();await gate;await route.fulfill({response});});
  await rename.getByRole('button',{name:'Guardar nuevo nombre',exact:true}).click();
  await responseReceived;
  try{await page.keyboard.press('Escape');await expect(rename).toBeVisible();await expect(rename.getByRole('button',{name:'Guardando nombre…',exact:true})).toBeDisabled();}finally{release();}
  await expect(rename).not.toBeVisible();await page.unroute(renameUrl);
  await expect(panel.getByRole('button',{name:'Descargar Informe final.docx',exact:true})).toBeVisible();
  const renamed=(await (await page.request.get('/api/v1/folder-documents')).json()).data.items.find(item=>item.id===original.id);
  expect(renamed.version).toBe(2);expect(renamed.sha256).toBe(original.sha256);expect(renamed.bytes).toBe(original.bytes);expect(renamed.folder_id).toBe(original.folder_id);
  const stale=await page.request.patch(`/api/v1/folder-documents/${original.id}`,{headers:{'X-CSRF-TOKEN':token},data:{name:'Obsolete.docx',version:1}});expect(stale.status()).toBe(409);
  const [renamedDownload]=await Promise.all([page.waitForEvent('download'),panel.getByRole('button',{name:'Descargar Informe final.docx',exact:true}).click()]);
  expect(renamedDownload.suggestedFilename()).toBe('Informe final.docx');
  const renamedStream=await renamedDownload.createReadStream(),chunks=[];for await(const chunk of renamedStream)chunks.push(chunk);
  expect(Buffer.concat(chunks).equals(fs.readFileSync('.local/office-fixture.docx'))).toBe(true);
  await panel.getByRole('button',{name:'Renombrar documento Informe final.docx',exact:true}).click();
  const staleDialog=page.getByRole('dialog',{name:'Renombrar documento: Informe final.docx'});
  const remote=await page.request.patch(`/api/v1/folder-documents/${original.id}`,{headers:{'X-CSRF-TOKEN':token},data:{name:'Informe vigente.docx',version:2}});expect(remote.ok()).toBe(true);
  await staleDialog.getByLabel('Nuevo nombre del archivo').fill('Cambio desactualizado.docx');
  await staleDialog.getByRole('button',{name:'Guardar nuevo nombre',exact:true}).click();
  await expect(staleDialog.getByRole('alert')).toContainText('El recurso cambió o ya existe');
  await staleDialog.getByRole('button',{name:'Actualizar archivos y cerrar',exact:true}).click();
  await expect(staleDialog).not.toBeVisible();
  await expect(panel.getByRole('button',{name:'Descargar Informe vigente.docx',exact:true})).toBeVisible();
  await expect.poll(async()=>{const result=await (await page.request.get('/api/v1/audit-events?service=files&action=document.renamed')).json();return result.data.items.filter(item=>item.resource_id===original.id).length;},{timeout:85000,intervals:[2000,5000]}).toBe(2);
  await page.reload();await page.getByRole('button',{name:'Abrir menú',exact:true}).click();
  await page.getByRole('button',{name:'Carpeta',exact:true}).click();
  await expect(panel.getByRole('button',{name:'Descargar Informe vigente.docx',exact:true})).toBeVisible();
  await panel.locator('input.folder-file-input').setInputFiles({name:'falso.docx',mimeType:'application/octet-stream',buffer:Buffer.from('fake Office document')});
  await panel.getByRole('button',{name:'Guardar archivo',exact:true}).click();
  await expect(panel.getByRole('alert')).toBeVisible();
  await expect(panel.getByText('2 archivos en esta ubicación.')).toBeVisible();
  await page.setViewportSize({width:360,height:800});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.screenshot({path:'.local/folder-documents-mobile.png',fullPage:true});
});
