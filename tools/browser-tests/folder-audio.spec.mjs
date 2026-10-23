import {test,expect} from '@playwright/test';
import fs from 'node:fs';
import {createHash} from 'node:crypto';

const fixture=JSON.parse(fs.readFileSync(process.env.SRD_BROWSER_FIXTURE));
const mailUrl=process.env.SRD_MAILPIT_URL||'http://localhost:8025';

function wav(){
  const data=Buffer.alloc(1600),file=Buffer.alloc(44+data.length);
  file.write('RIFF',0);file.writeUInt32LE(file.length-8,4);file.write('WAVEfmt ',8);
  file.writeUInt32LE(16,16);file.writeUInt16LE(1,20);file.writeUInt16LE(1,22);
  file.writeUInt32LE(8000,24);file.writeUInt32LE(16000,28);file.writeUInt16LE(2,32);file.writeUInt16LE(16,34);
  file.write('data',36);file.writeUInt32LE(data.length,40);data.copy(file,44);
  return file;
}
async function login(page){
  await page.goto(`/j/${fixture.codeA}/login`);
  await page.getByLabel('Correo electrónico',{exact:true}).fill(fixture.users.admin.email);
  await page.getByLabel('Contraseña',{exact:true}).fill(fixture.password);
  await page.getByRole('button',{name:'términos y condiciones',exact:true}).click();
  await page.getByRole('button',{name:'Aceptar términos',exact:true}).click();
  await page.getByRole('button',{name:'Ingresar',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Ingresa tu código'})).toBeVisible();
  let message;
  await expect.poll(async()=>{const list=await(await page.request.get(`${mailUrl}/api/v1/messages`)).json();
    message=list.messages?.find(item=>item.Subject==='Tu código de seguridad de SRD'&&item.To.some(to=>to.Address===fixture.users.admin.email));
    return !!message;},{timeout:85000}).toBe(true);
  const content=await(await page.request.get(`${mailUrl}/api/v1/message/${message.ID}`)).json();
  await page.getByLabel('Código de verificación').fill(content.Text.match(/\b\d{6}\b/)[0]);
  await page.getByRole('button',{name:'Confirmar código'}).click();
  await expect(page.locator('.sidebar').getByRole('button',{name:'Home',exact:true})).toBeVisible();
}

test('WAV is scanned, privately played and downloaded intact',async({page})=>{
  await login(page);
  await page.locator('.sidebar').getByRole('button',{name:'Carpeta',exact:true}).click();
  const panel=page.getByRole('region',{name:'Archivos privados'}),original=wav();
  await expect(panel.getByLabel('Espacio compartido de la junta')).toContainText('disponibles');
  const before=(await(await page.request.get('/api/v1/folder-quota')).json()).data;
  await panel.getByLabel('Documento, imagen o audio',{exact:true}).setInputFiles({name:'Nota.wav',mimeType:'audio/wav',buffer:original});
  await panel.getByRole('button',{name:'Guardar archivo'}).click();
  await expect(panel.getByRole('button',{name:'Escuchar Nota.wav'})).toBeVisible();
  const after=(await(await page.request.get('/api/v1/folder-quota')).json()).data;
  expect(after.used_bytes-before.used_bytes).toBe(original.length);
  expect(after.available_bytes).toBe(after.limit_bytes-after.used_bytes);
  await panel.getByRole('button',{name:'Escuchar Nota.wav'}).click();
  const dialog=page.getByRole('dialog',{name:'Escuchar: Nota.wav'});
  await expect(dialog.getByLabel('Reproducir Nota.wav')).toBeVisible();
  await expect.poll(()=>dialog.getByLabel('Reproducir Nota.wav').evaluate(el=>el instanceof HTMLAudioElement && el.readyState>=1)).toBe(true);
  await dialog.getByRole('button',{name:'Cerrar audio'}).click();
  const [download]=await Promise.all([page.waitForEvent('download'),panel.getByRole('button',{name:'Descargar Nota.wav'}).click()]);
  const hash=createHash('sha256'),stream=await download.createReadStream();
  for await(const part of stream)hash.update(part);
  expect(hash.digest('hex')).toBe(createHash('sha256').update(original).digest('hex'));
});
