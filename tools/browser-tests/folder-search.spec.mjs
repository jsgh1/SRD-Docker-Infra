import {test,expect} from '@playwright/test';
import fs from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';

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

test('folder search lists only names and downloads the authorized file',async({page})=>{
  await login(page,'admin');
  const documentId=randomUUID(),parentId=randomUUID(),folderId=randomUUID(),original=fs.readFileSync('.local/office-fixture.docx');
  const headers={'X-CSRF-TOKEN':(await(await page.request.get('/api/v1/csrf')).json()).data.token};
  const name=`Acta 50%_! ${documentId}.docx`;
  expect((await page.request.post('/api/v1/folders',{headers,data:{id:parentId,parent_id:null,name:'Archivo'}})).status()).toBe(200);
  expect((await page.request.post('/api/v1/folders',{headers,data:{id:folderId,parent_id:parentId,name:'Actas'}})).status()).toBe(200);
  expect((await page.request.post('/api/v1/folder-documents',{headers,data:{id:documentId,folder_id:folderId,name,content:original.toString('base64')}})).status()).toBe(200);
  await page.getByRole('button',{name:'Buscar en la junta',exact:true}).click();
  const form=page.getByRole('form',{name:'Búsqueda de la junta'});
  await form.getByRole('combobox',{name:'Buscar en',exact:true}).selectOption('files');
  await form.getByLabel('Texto de búsqueda').fill('50%_!');
  await form.getByRole('button',{name:'Buscar',exact:true}).click();
  const results=page.getByRole('region',{name:'Resultados de archivos'});
  await expect(results.getByRole('button',{name:`Descargar ${name}`})).toBeVisible();
  await expect(results.getByText('Inicio / Archivo / Actas',{exact:true})).toBeVisible();
  await expect(results).not.toContainText('Documento sintético SRD');
  const [download]=await Promise.all([page.waitForEvent('download'),results.getByRole('button',{name:`Descargar ${name}`}).click()]);
  const stream=await download.createReadStream(),hash=createHash('sha256');
  for await(const part of stream)hash.update(part);
  expect(hash.digest('hex')).toBe(createHash('sha256').update(original).digest('hex'));
  const listed=await page.request.get('/api/v1/folder-documents/search',{params:{q:'50%_!'}});
  expect(listed.status()).toBe(200);
  expect((await listed.json()).data.items.some(item=>item.id===documentId)).toBe(true);
  await results.getByRole('button',{name:`Abrir ubicación de ${name}`}).click();
  await expect(page.getByRole('heading',{name:'Carpeta',exact:true})).toBeVisible();
  await expect(page.getByRole('navigation',{name:'Ruta de carpetas'}).getByRole('button',{name:'Actas'})).toBeVisible();
  await expect(page.getByRole('region',{name:'Archivos privados'}).getByRole('button',{name:`Descargar ${name}`})).toBeVisible();
});
