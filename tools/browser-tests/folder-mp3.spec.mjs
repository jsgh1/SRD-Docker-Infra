import {test,expect} from '@playwright/test';
import fs from 'node:fs';
import {createHash} from 'node:crypto';

const fixture=JSON.parse(fs.readFileSync(process.env.SRD_BROWSER_FIXTURE));
const mailUrl=process.env.SRD_MAILPIT_URL||'http://localhost:8025';
const source=fs.readFileSync(new URL('./silence.mp3',import.meta.url));
const tagSize=((source[6]&127)<<21)|((source[7]&127)<<14)|((source[8]&127)<<7)|(source[9]&127);
const frames=source.subarray(10+tagSize);

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

test('MP3 strips tags, plays privately and downloads only approved frames',async({page})=>{
  await login(page);
  await page.locator('.sidebar').getByRole('button',{name:'Carpeta',exact:true}).click();
  const panel=page.getByRole('region',{name:'Archivos privados'});
  const before=(await(await page.request.get('/api/v1/folder-quota')).json()).data;
  const tagged=Buffer.concat([source,Buffer.from('TAG'),Buffer.alloc(125,65)]);
  await panel.getByLabel('Documento, imagen o audio',{exact:true}).setInputFiles({name:'Mensaje.mp3',mimeType:'audio/mpeg',buffer:tagged});
  await panel.getByRole('button',{name:'Guardar archivo'}).click();
  await expect(panel.getByRole('button',{name:'Escuchar Mensaje.mp3'})).toBeVisible();
  const after=(await(await page.request.get('/api/v1/folder-quota')).json()).data;
  expect(after.used_bytes-before.used_bytes).toBe(frames.length);
  await panel.getByRole('button',{name:'Escuchar Mensaje.mp3'}).click();
  const dialog=page.getByRole('dialog',{name:'Escuchar: Mensaje.mp3'});
  await expect(dialog.getByLabel('Reproducir Mensaje.mp3')).toBeVisible();
  await expect.poll(()=>dialog.getByLabel('Reproducir Mensaje.mp3').evaluate(el=>el instanceof HTMLAudioElement && el.readyState>=1)).toBe(true);
  await dialog.getByRole('button',{name:'Cerrar audio'}).click();
  const [download]=await Promise.all([page.waitForEvent('download'),panel.getByRole('button',{name:'Descargar Mensaje.mp3'}).click()]);
  const hash=createHash('sha256'),stream=await download.createReadStream();
  for await(const part of stream)hash.update(part);
  expect(hash.digest('hex')).toBe(createHash('sha256').update(frames).digest('hex'));
  const malformed=Buffer.alloc(417*3,255);
  for(let offset=0;offset<malformed.length;offset+=417)Buffer.from([255,251,144,0]).copy(malformed,offset);
  await panel.getByLabel('Documento, imagen o audio',{exact:true}).setInputFiles({name:'Tramas falsas.mp3',mimeType:'audio/mpeg',buffer:malformed});
  await panel.getByRole('button',{name:'Guardar archivo'}).click();
  await expect(panel.getByRole('button',{name:'Escuchar Tramas falsas.mp3'})).toHaveCount(0);
  await expect(panel).toContainText('Revisa los datos del formulario.');
  const rejected=(await(await page.request.get('/api/v1/folder-quota')).json()).data;
  expect(rejected.used_bytes).toBe(after.used_bytes);
});
