import {test,expect} from '@playwright/test';
import fs from 'node:fs';
const fixture=JSON.parse(fs.readFileSync(process.env.SRD_BROWSER_FIXTURE));
const mailUrl=process.env.SRD_MAILPIT_URL||'http://localhost:8025';
async function login(page){
  await page.goto(`/j/${fixture.codeA}/login`);
  await page.getByLabel('Correo electrónico',{exact:true}).fill(fixture.users.admin.email);
  await page.getByLabel('Contraseña',{exact:true}).fill(fixture.password);
  await page.getByRole('button',{name:'términos y condiciones',exact:true}).click();
  await page.getByRole('button',{name:'Aceptar términos',exact:true}).click();
  await page.getByRole('button',{name:'Ingresar',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Ingresa tu código'})).toBeVisible();
  let message;
  await expect.poll(async()=>{const list=await(await page.request.get(`${mailUrl}/api/v1/messages`)).json();message=list.messages?.find(item=>item.Subject==='Tu código de seguridad de SRD'&&item.To.some(to=>to.Address===fixture.users.admin.email));return !!message;},{timeout:85000}).toBe(true);
  const content=await(await page.request.get(`${mailUrl}/api/v1/message/${message.ID}`)).json();
  await page.getByLabel('Código de verificación').fill(content.Text.match(/\b\d{6}\b/)[0]);
  await page.getByRole('button',{name:'Confirmar código'}).click();
  await expect(page.locator('.sidebar').getByRole('button',{name:'Home',exact:true})).toBeVisible();
}
test('documents move through paginated destinations preserve bytes and clamp an emptied page',async({page})=>{
  test.setTimeout(300000);await login(page);
  const token=(await(await page.request.get('/api/v1/csrf')).json()).data.token,headers={'X-CSRF-TOKEN':token};
  const bytes=fs.readFileSync('.local/office-fixture.docx'),content=bytes.toString('base64');
  async function upload(name,folder=null){const id=crypto.randomUUID();const response=await page.request.post('/api/v1/folder-documents',{headers,data:{id,folder_id:folder,name,content}});expect(response.ok()).toBe(true);return(await response.json()).data;}
  const target=crypto.randomUUID();
  for(const [id,name] of [[target,'Z destino'],...Array.from({length:25},(_,i)=>[crypto.randomUUID(),`Archivo ${String(i).padStart(2,'0')}`])]){
    const response=await page.request.post('/api/v1/folders',{headers,data:{id,name,parent_id:null}});expect(response.ok()).toBe(true);
  }
  const original=await upload('Mover.docx'),occupied=await upload('Mover.docx',target);
  await page.getByRole('button',{name:'Carpeta',exact:true}).click();
  const panel=page.getByRole('region',{name:'Archivos privados'});
  async function chooseTarget(){
    await panel.getByRole('button',{name:'Mover documento Mover.docx',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'Mover documento: Mover.docx'});
    await expect(dialog.getByRole('button',{name:'Mover a esta ubicación',exact:true})).toBeDisabled();
    await dialog.getByRole('button',{name:'Página siguiente de destinos',exact:true}).click();
    await dialog.getByRole('button',{name:'Abrir destino Z destino',exact:true}).click();
    await expect(dialog.getByText('Destino: Z destino',{exact:true})).toBeVisible();return dialog;
  }
  let dialog=await chooseTarget();
  await dialog.getByRole('button',{name:'Mover a esta ubicación',exact:true}).click();
  await expect(dialog.getByRole('alert')).toContainText('El recurso cambió o ya existe');
  await dialog.getByRole('button',{name:'Actualizar archivos y cerrar',exact:true}).click();
  await expect(panel.getByText('1 archivo en esta ubicación.')).toBeVisible();
  const renamed=await page.request.patch(`/api/v1/folder-documents/${occupied.id}`,{headers,data:{name:'Ocupado.docx',version:1}});expect(renamed.ok()).toBe(true);
  dialog=await chooseTarget();await page.keyboard.press('Escape');await expect(dialog).not.toBeVisible();dialog=await chooseTarget();
  await page.setViewportSize({width:360,height:800});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'.local/document-move-mobile.png'});
  let release,received;const gate=new Promise(resolve=>release=resolve),receivedResponse=new Promise(resolve=>received=resolve);
  const url=`**/api/v1/folder-documents/${original.id}/move`;
  await page.route(url,async route=>{const response=await route.fetch();received();await gate;await route.fulfill({response});});
  await dialog.getByRole('button',{name:'Mover a esta ubicación',exact:true}).click();await receivedResponse;
  try{await page.keyboard.press('Escape');await expect(dialog).toBeVisible();await expect(dialog.getByRole('button',{name:'Moviendo documento…',exact:true})).toBeDisabled();}finally{release();}
  await expect(dialog).not.toBeVisible();await page.unroute(url);
  await expect(panel.getByText('0 archivos en esta ubicación.')).toBeVisible();
  const moved=(await(await page.request.get(`/api/v1/folder-documents?folder_id=${target}`)).json()).data.items.find(item=>item.id===original.id);
  expect(moved.version).toBe(2);expect(moved.folder_id).toBe(target);expect(moved.sha256).toBe(original.sha256);expect(moved.bytes).toBe(original.bytes);expect(moved.name).toBe(original.name);
  const stale=await page.request.post(`/api/v1/folder-documents/${original.id}/move`,{headers,data:{folder_id:null,version:1}});expect(stale.status()).toBe(409);
  await page.getByRole('button',{name:'Siguiente',exact:true}).click();await page.getByRole('button',{name:'Z destino',exact:true}).click();
  await expect(panel.getByText('2 archivos en esta ubicación.')).toBeVisible();
  const [download]=await Promise.all([page.waitForEvent('download'),panel.getByRole('button',{name:'Descargar Mover.docx',exact:true}).click()]);
  expect(download.suggestedFilename()).toBe('Mover.docx');const chunks=[],stream=await download.createReadStream();for await(const chunk of stream)chunks.push(chunk);expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
  await panel.getByRole('button',{name:'Mover documento Mover.docx',exact:true}).click();dialog=page.getByRole('dialog',{name:'Mover documento: Mover.docx'});
  await dialog.getByRole('button',{name:'Inicio del destino',exact:true}).click();await expect(dialog.getByText('Destino: Inicio',{exact:true})).toBeVisible();
  await dialog.getByRole('button',{name:'Mover a esta ubicación',exact:true}).click();await expect(panel.getByText('1 archivo en esta ubicación.')).toBeVisible();
  await page.getByRole('navigation',{name:'Ruta de carpetas'}).getByRole('button',{name:'Inicio',exact:true}).click();
  await expect(panel.getByRole('button',{name:'Mover documento Mover.docx',exact:true})).toBeVisible();
  for(let i=0;i<25;i++)await upload(`A ${String(i).padStart(2,'0')}.docx`);
  await panel.getByRole('button',{name:'Actualizar archivos',exact:true}).click();await expect(panel.getByText('26 archivos en esta ubicación.')).toBeVisible();
  await panel.getByRole('button',{name:'Documentos siguientes',exact:true}).click();await expect(panel.getByText('Página 2',{exact:true})).toBeVisible();
  dialog=await chooseTarget();await dialog.getByRole('button',{name:'Mover a esta ubicación',exact:true}).click();
  await expect(panel.getByText('25 archivos en esta ubicación.')).toBeVisible();await expect(panel.getByText('Página 1',{exact:true})).toBeVisible();
  await expect.poll(async()=>{const events=await(await page.request.get('/api/v1/audit-events?service=files&action=document.moved')).json();return events.data.items.filter(item=>item.resource_id===original.id).length;},{timeout:85000,intervals:[2000,5000]}).toBe(3);
  const final=(await(await page.request.get(`/api/v1/folder-documents?folder_id=${target}`)).json()).data.items.find(item=>item.id===original.id);
  expect(final.version).toBe(4);expect(final.sha256).toBe(original.sha256);
});
