import {test,expect} from '@playwright/test';
import fs from 'node:fs';
import {createHash} from 'node:crypto';

const fixture=JSON.parse(fs.readFileSync(process.env.SRD_BROWSER_FIXTURE));
const mailUrl=process.env.SRD_MAILPIT_URL||'http://localhost:8025';

async function login(page,role){
  await page.goto(`/j/${fixture.codeA}/login`);
  await page.getByLabel('Correo electrónico',{exact:true}).fill(fixture.users[role].email);
  await page.getByLabel('Contraseña',{exact:true}).fill(fixture.password);
  await page.getByRole('button',{name:'términos y condiciones',exact:true}).click();
  await page.getByRole('button',{name:'Aceptar términos',exact:true}).click();
  await page.getByRole('button',{name:'Ingresar',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Ingresa tu código'})).toBeVisible();
  let message;
  await expect.poll(async()=>{const list=await(await page.request.get(`${mailUrl}/api/v1/messages`)).json();
    message=list.messages?.find(item=>item.Subject==='Tu código de seguridad de SRD'&&item.To.some(to=>to.Address===fixture.users[role].email));
    return !!message;},{timeout:85000}).toBe(true);
  const content=await(await page.request.get(`${mailUrl}/api/v1/message/${message.ID}`)).json();
  await page.getByLabel('Código de verificación').fill(content.Text.match(/\b\d{6}\b/)[0]);
  await page.getByRole('button',{name:'Confirmar código'}).click();
  await expect(page.locator('.sidebar').getByRole('button',{name:'Home',exact:true})).toBeVisible();
}

test('folder reading may be delegated and revoked without granting writes',async({page,browser})=>{
  test.setTimeout(300000);
  await login(page,'admin');
  const headers={'X-CSRF-TOKEN':(await(await page.request.get('/api/v1/csrf')).json()).data.token};
  const folderId=crypto.randomUUID(),documentId=crypto.randomUUID(),sheetId=crypto.randomUUID();
  const original=fs.readFileSync('.local/office-fixture.docx');
  const spreadsheet=fs.readFileSync('.local/office-fixture.xlsx');
  expect((await page.request.post('/api/v1/folders',{headers,data:{id:folderId,parent_id:null,name:'Actas compartidas'}})).status()).toBe(200);
  expect((await page.request.post('/api/v1/folder-documents',{headers,data:{id:documentId,folder_id:folderId,name:'Acta.docx',content:original.toString('base64')}})).status()).toBe(200);
  expect((await page.request.post('/api/v1/folder-documents',{headers,data:{id:sheetId,folder_id:folderId,name:'Datos.xlsx',content:spreadsheet.toString('base64')}})).status()).toBe(200);
  await page.getByRole('button',{name:'Configuración',exact:true}).click();
  const permissions=page.getByRole('region',{name:'Permisos de lectura de Carpeta'});
  await expect(permissions).toBeVisible();
  await page.route('**/api/v1/members/folder-readers?*',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{message:'Miembros no disponibles.'}})}));
  await permissions.getByRole('button',{name:'Actualizar permisos'}).click();
  await expect(permissions).toContainText('Miembros no disponibles.');
  await expect(permissions.getByLabel(fixture.users.viewer.email,{exact:false})).toHaveCount(0);
  await page.unroute('**/api/v1/members/folder-readers?*');
  await permissions.getByRole('button',{name:'Reintentar miembros'}).click();
  await expect(permissions.getByLabel(fixture.users.viewer.email,{exact:false})).toBeVisible();
  await permissions.getByRole('checkbox',{name:'Consultor',exact:true}).check();
  await permissions.getByRole('button',{name:'Guardar permisos'}).click();
  await expect(permissions.getByText('Permisos de lectura de Carpeta guardados.')).toBeVisible();
  await page.getByRole('button',{name:'Carpeta',exact:true}).click();
  await expect(permissions).toHaveCount(0);
  await page.getByRole('button',{name:'Configuración',exact:true}).click();
  await expect(permissions).toBeVisible();

  const viewerContext=await browser.newContext({baseURL:process.env.SRD_TEST_URL,acceptDownloads:true});
  try{
    const viewer=await viewerContext.newPage();await login(viewer,'viewer');
    await expect(viewer.locator('.sidebar').getByRole('button',{name:'Carpeta',exact:true})).toBeVisible();
    await viewer.getByRole('button',{name:'Carpeta',exact:true}).click();
    await expect(viewer.getByRole('button',{name:'Actas compartidas',exact:true})).toBeVisible();
    await expect(viewer.getByRole('button',{name:'Nueva carpeta'})).toHaveCount(0);
    await viewer.getByRole('button',{name:'Actas compartidas',exact:true}).click();
    const files=viewer.getByRole('region',{name:'Archivos privados'});
    await expect(files.getByRole('button',{name:'Descargar Acta.docx',exact:true})).toBeVisible();
    await files.getByRole('button',{name:'Ver texto de Acta.docx',exact:true}).click();
    await expect(viewer.getByRole('dialog',{name:'Texto de Acta.docx'})).toContainText('Documento sintético SRD');
    await viewer.getByRole('button',{name:'Cerrar vista previa'}).click();
    await files.getByRole('button',{name:'Ver hoja de Datos.xlsx',exact:true}).click();
    const sheet=viewer.getByRole('dialog',{name:'Hoja de Datos.xlsx'});
    await expect(sheet.getByRole('table',{name:'Extracto de hoja de cálculo'})).toContainText('SRD sintético');
    await expect(sheet).toContainText('Hoja: Prueba');
    await sheet.getByLabel('Elegir hoja').selectOption('2');
    await expect(sheet.getByRole('table',{name:'Extracto de hoja de cálculo'})).toContainText('Anexo privado');
    await expect(sheet).toContainText('Hoja: Anexo');
    await viewer.getByRole('button',{name:'Cerrar vista previa'}).click();
    await expect(files.getByRole('button',{name:'Guardar archivo'})).toHaveCount(0);
    await expect(files.getByRole('button',{name:'Renombrar documento Acta.docx'})).toHaveCount(0);
    const [download]=await Promise.all([viewer.waitForEvent('download'),files.getByRole('button',{name:'Descargar Acta.docx',exact:true}).click()]);
    const stream=await download.createReadStream(),hash=createHash('sha256');let length=0;
    for await(const part of stream){length+=part.length;hash.update(part);}
    expect(length).toBe(original.length);expect(hash.digest('hex')).toBe(createHash('sha256').update(original).digest('hex'));
    await permissions.getByRole('checkbox',{name:'Consultor',exact:true}).uncheck();
    await permissions.getByRole('button',{name:'Guardar permisos'}).click();
    await expect(permissions.getByText('Permisos de lectura de Carpeta guardados.')).toBeVisible();
    expect((await viewer.request.get('/api/v1/folder-documents',{params:{folder_id:folderId}})).status()).toBe(403);
    expect((await viewer.request.get(`/api/v1/folder-documents/${documentId}/download`)).status()).toBe(403);
    expect((await viewer.request.get(`/api/v1/folder-documents/${documentId}/preview`)).status()).toBe(403);
    expect((await viewer.request.get(`/api/v1/folder-documents/${sheetId}/preview`)).status()).toBe(403);
    expect((await viewer.request.get(`/api/v1/folder-documents/${sheetId}/preview?sheet=2`)).status()).toBe(403);
    await viewer.reload();
    await expect(viewer.locator('.sidebar').getByRole('button',{name:'Carpeta',exact:true})).toHaveCount(0);
    await expect(permissions.getByLabel(fixture.users.viewer.email,{exact:false})).toBeVisible();
    await permissions.getByLabel(fixture.users.viewer.email,{exact:false}).check();
    await permissions.getByRole('button',{name:'Guardar permisos'}).click();
    await expect(permissions.getByText('Permisos de lectura de Carpeta guardados.')).toBeVisible();
    await viewer.reload();
    await expect(viewer.locator('.sidebar').getByRole('button',{name:'Carpeta',exact:true})).toBeVisible();
    expect((await viewer.request.get(`/api/v1/folder-documents/${sheetId}/preview?sheet=2`)).status()).toBe(200);
    await permissions.getByRole('button',{name:/Quitar acceso individual de/}).click();
    await permissions.getByRole('button',{name:'Guardar permisos'}).click();
    expect((await viewer.request.get(`/api/v1/folder-documents/${sheetId}/preview?sheet=2`)).status()).toBe(403);
    expect((await page.request.get('/api/v1/folder-documents',{params:{folder_id:folderId}})).status()).toBe(200);
    await expect.poll(async()=>{const data=await(await page.request.get('/api/v1/audit-events?service=files&action=folder.access_updated')).json();
      return data.data.items.filter(item=>item.resource_id===fixture.orgA).length;},{timeout:85000,intervals:[2000,5000]}).toBe(4);
  }finally{await viewerContext.close();}
});
