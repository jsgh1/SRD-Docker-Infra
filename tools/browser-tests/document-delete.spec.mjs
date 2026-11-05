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
test('private document deletion confirms version and preserves another document',async({page})=>{
 test.setTimeout(240000);await login(page);
 const token=(await(await page.request.get('/api/v1/csrf')).json()).data.token,headers={'X-CSRF-TOKEN':token};
 const bytes=fs.readFileSync('.local/office-fixture.docx'),ids=[crypto.randomUUID(),crypto.randomUUID()];
 for(const [index,id] of ids.entries()){
  const result=await page.request.post('/api/v1/folder-documents',{headers,data:{id,folder_id:null,name:`Acta ${index+1}.docx`,content:bytes.toString('base64')}});
  expect(result.status()).toBe(200);
 }
 await page.getByRole('button',{name:'Carpeta',exact:true}).click();
 const panel=page.getByRole('region',{name:'Archivos privados'});
 await expect(panel.getByText('2 archivos en esta ubicación.')).toBeVisible();
 async function open(name){await panel.getByRole('button',{name:`Eliminar documento ${name}`,exact:true}).click();return page.getByRole('dialog',{name:`Eliminar documento: ${name}`});}
 let dialog=await open('Acta 1.docx');await expect(dialog.getByRole('button',{name:'Sí, eliminar archivo',exact:true})).toBeDisabled();
 await page.keyboard.press('Escape');await expect(dialog).not.toBeVisible();
 const renamed=await page.request.patch(`/api/v1/folder-documents/${ids[0]}`,{headers,data:{name:'Acta actual.docx',version:1}});expect(renamed.status()).toBe(200);
 dialog=await open('Acta 1.docx');await dialog.getByLabel('Confirmo que quiero eliminar este archivo.').check();
 await dialog.getByRole('button',{name:'Sí, eliminar archivo',exact:true}).click();
 await expect(dialog.getByRole('alert')).toContainText('El recurso cambió o ya existe');
 await dialog.getByRole('button',{name:'Actualizar archivos y cerrar',exact:true}).click();
 dialog=await open('Acta actual.docx');await dialog.getByLabel('Confirmo que quiero eliminar este archivo.').check();
 await page.setViewportSize({width:360,height:800});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:'.local/document-delete-mobile.png'});
 let release,received;const gate=new Promise(resolve=>release=resolve),receivedResponse=new Promise(resolve=>received=resolve);
 const url=`**/api/v1/folder-documents/${ids[0]}`;
 await page.route(url,async route=>{const response=await route.fetch();received();await gate;await route.fulfill({response});});
 await dialog.getByRole('button',{name:'Sí, eliminar archivo',exact:true}).click();await receivedResponse;
 try{await page.keyboard.press('Escape');await expect(dialog).toBeVisible();await expect(dialog.getByRole('button',{name:'Eliminando archivo…',exact:true})).toBeDisabled();}finally{release();}
 await expect(dialog).not.toBeVisible();await page.unroute(url);
 await expect(panel.getByText('1 archivo en esta ubicación.')).toBeVisible();
 expect((await page.request.get(`/api/v1/folder-documents/${ids[0]}/download`)).status()).toBe(404);
 expect((await page.request.delete(`/api/v1/folder-documents/${ids[0]}`,{headers,data:{version:2,confirm:true}})).status()).toBe(404);
 const saved=await(await page.request.get(`/api/v1/folder-documents/${ids[1]}/download`)).json();expect(saved.data.content).toBe(bytes.toString('base64'));
 await expect.poll(async()=>{const events=await(await page.request.get('/api/v1/audit-events?service=files&action=document.deleted')).json();return events.data.items.filter(item=>item.resource_id===ids[0]).length;},{timeout:85000,intervals:[2000,5000]}).toBe(1);
 await page.reload();await page.getByRole('button',{name:'Abrir menú',exact:true}).click();await page.getByRole('button',{name:'Carpeta',exact:true}).click();
 await expect(panel.getByText('1 archivo en esta ubicación.')).toBeVisible();
});
