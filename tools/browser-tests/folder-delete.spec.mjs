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
test('empty folder deletion requires confirmation preserves contents and handles stale versions and pages',async({page})=>{
 test.setTimeout(240000);await login(page);
 const token=(await(await page.request.get('/api/v1/csrf')).json()).data.token,headers={'X-CSRF-TOKEN':token};
 const folders=[];
 for(let i=0;i<26;i++){
  const item={id:crypto.randomUUID(),name:`Carpeta ${String(i).padStart(2,'0')}`,parent_id:null};
  expect((await page.request.post('/api/v1/folders',{headers,data:item})).ok()).toBe(true);folders.push(item);
 }
 expect((await page.request.post('/api/v1/folders',{headers,data:{id:crypto.randomUUID(),name:'Hija',parent_id:folders[0].id}})).ok()).toBe(true);
 const bytes=fs.readFileSync('.local/office-fixture.docx'),documentId=crypto.randomUUID();
 expect((await page.request.post('/api/v1/folder-documents',{headers,data:{id:documentId,folder_id:folders[1].id,name:'Protegido.docx',content:bytes.toString('base64')}})).ok()).toBe(true);
 await page.getByRole('button',{name:'Carpeta',exact:true}).click();
 async function open(name){await page.getByRole('button',{name:`Eliminar carpeta ${name}`,exact:true}).click();return page.getByRole('dialog',{name:`Eliminar carpeta: ${name}`});}
 let dialog=await open(folders[0].name);await expect(dialog.getByRole('button',{name:'Sí, eliminar',exact:true})).toBeDisabled();
 await page.keyboard.press('Escape');await expect(dialog).not.toBeVisible();
 for(const folder of folders.slice(0,2)){
  dialog=await open(folder.name);await dialog.getByLabel('Confirmo que quiero eliminar esta carpeta vacía.').check();
  await dialog.getByRole('button',{name:'Sí, eliminar',exact:true}).click();
  await expect(dialog.getByRole('alert')).toContainText('La carpeta contiene subcarpetas o documentos');
  await dialog.getByRole('button',{name:'Cancelar eliminación',exact:true}).click();
 }
 const preserved=await(await page.request.get(`/api/v1/folder-documents/${documentId}/download`)).json();expect(preserved.data.content).toBe(bytes.toString('base64'));
 await page.getByRole('button',{name:'Siguiente',exact:true}).click();dialog=await open(folders[25].name);
 await dialog.getByLabel('Confirmo que quiero eliminar esta carpeta vacía.').check();
 await page.setViewportSize({width:360,height:800});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:'.local/folder-delete-mobile.png'});
 let release,received;const gate=new Promise(resolve=>release=resolve),receivedResponse=new Promise(resolve=>received=resolve);
 const url=`**/api/v1/folders/${folders[25].id}`;
 await page.route(url,async route=>{const response=await route.fetch();received();await gate;await route.fulfill({response});});
 await dialog.getByRole('button',{name:'Sí, eliminar',exact:true}).click();await receivedResponse;
 try{await page.keyboard.press('Escape');await expect(dialog).toBeVisible();await expect(dialog.getByRole('button',{name:'Eliminando carpeta…',exact:true})).toBeDisabled();}finally{release();}
 await expect(dialog).not.toBeVisible();await page.unroute(url);
 await expect(page.getByText('25 carpetas en esta ubicación.',{exact:true})).toBeVisible();await expect(page.getByText('Página 1 de 1',{exact:true})).toBeVisible();
 const renamed=await page.request.patch(`/api/v1/folders/${folders[2].id}`,{headers,data:{name:'Carpeta 02 actual',version:1}});expect(renamed.ok()).toBe(true);
 dialog=await open(folders[2].name);await dialog.getByLabel('Confirmo que quiero eliminar esta carpeta vacía.').check();await dialog.getByRole('button',{name:'Sí, eliminar',exact:true}).click();
 await expect(dialog.getByRole('alert')).toContainText('El recurso cambió o ya existe');
 await dialog.getByRole('button',{name:'Actualizar carpetas y cerrar',exact:true}).click();
 dialog=await open('Carpeta 02 actual');await dialog.getByLabel('Confirmo que quiero eliminar esta carpeta vacía.').check();await dialog.getByRole('button',{name:'Sí, eliminar',exact:true}).click();
 await expect(page.getByText('24 carpetas en esta ubicación.',{exact:true})).toBeVisible();
 expect((await page.request.delete(`/api/v1/folders/${folders[2].id}`,{headers,data:{version:2,confirm:true}})).status()).toBe(404);
 await expect.poll(async()=>{const events=await(await page.request.get('/api/v1/audit-events?service=files&action=folder.deleted')).json();return events.data.items.filter(item=>[folders[2].id,folders[25].id].includes(item.resource_id)).length;},{timeout:85000,intervals:[2000,5000]}).toBe(2);
 await page.reload();await page.getByRole('button',{name:'Abrir menú',exact:true}).click();await page.getByRole('button',{name:'Carpeta',exact:true}).click();
 await expect(page.getByText('24 carpetas en esta ubicación.',{exact:true})).toBeVisible();
});
