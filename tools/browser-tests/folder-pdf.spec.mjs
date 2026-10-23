import {test,expect} from '@playwright/test';
import fs from 'node:fs';
import {createHash} from 'node:crypto';

const fixture=JSON.parse(fs.readFileSync(process.env.SRD_BROWSER_FIXTURE));
const mailUrl=process.env.SRD_MAILPIT_URL||'http://localhost:8025';

function pdf(){
  const first='BT /F1 12 Tf 50 80 Td (UNO) Tj ET\n';
  const second='BT /F1 12 Tf 50 80 Td (DOS) Tj ET\n';
  const objects=[
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 120] /Contents 4 0 R /Resources << /Font << /F1 7 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(first)} >>\nstream\n${first}endstream`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 120] /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(second)} >>\nstream\n${second}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body='%PDF-1.4\n';const offsets=[];
  for(const [index,object] of objects.entries()){
    offsets.push(Buffer.byteLength(body));body+=`${index+1} 0 obj\n${object}\nendobj\n`;
  }
  const startxref=Buffer.byteLength(body);
  body+='xref\n0 8\n0000000000 65535 f \n';
  for(const offset of offsets)body+=`${String(offset).padStart(10,'0')} 00000 n \n`;
  body+=`trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
  return Buffer.from(body);
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

test('private PDF pages render individually, download intact and reject a fake',async({page})=>{
  await login(page);
  await page.locator('.sidebar').getByRole('button',{name:'Carpeta',exact:true}).click();
  const panel=page.getByRole('region',{name:'Archivos privados'}),original=pdf();
  await panel.getByLabel('Documento, imagen o audio',{exact:true}).setInputFiles({name:'Acta.pdf',mimeType:'application/pdf',buffer:original});
  await panel.getByRole('button',{name:'Guardar archivo'}).click();
  await expect(panel.getByRole('button',{name:'Descargar Acta.pdf'})).toBeVisible();
  const [previewResponse]=await Promise.all([
    page.waitForResponse(response=>response.url().includes('/folder-documents/')&&response.url().endsWith('/preview?page=1')),
    panel.getByRole('button',{name:'Ver PDF Acta.pdf'}).click(),
  ]);
  const preview=(await previewResponse.json()).data;
  expect(preview.content).toBeUndefined();
  expect(preview.preview.format).toBe('image');
  expect(preview.preview.mime).toBe('image/png');
  expect(preview.preview.page).toBe(1);
  expect(preview.preview.pages).toBe(2);
  expect(Buffer.from(preview.preview.content,'base64').subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))).toBe(true);
  const dialog=page.getByRole('dialog',{name:'Vista previa PDF: Acta.pdf'});
  const image=dialog.getByRole('img',{name:'Página 1 de Acta.pdf'});
  await expect(image).toBeVisible();
  await expect.poll(()=>image.evaluate(element=>element.naturalWidth>0&&element.naturalHeight>0)).toBe(true);
  const [secondResponse]=await Promise.all([
    page.waitForResponse(response=>response.url().includes('/folder-documents/')&&response.url().endsWith('/preview?page=2')),
    dialog.getByRole('button',{name:'Página siguiente'}).click(),
  ]);
  const pageTwo=(await secondResponse.json()).data;
  expect(pageTwo.content).toBeUndefined();
  expect(pageTwo.preview.page).toBe(2);
  expect(pageTwo.preview.pages).toBe(2);
  expect(pageTwo.preview.content).not.toBe(preview.preview.content);
  await expect(dialog.getByRole('img',{name:'Página 2 de Acta.pdf'})).toBeVisible();
  await expect(dialog.getByText('Página 2 de 2')).toBeVisible();
  await expect(dialog.getByRole('button',{name:'Página siguiente'})).toBeDisabled();
  await dialog.getByRole('button',{name:'Página anterior'}).click();
  await expect(dialog.getByRole('img',{name:'Página 1 de Acta.pdf'})).toBeVisible();
  await dialog.getByRole('button',{name:'Cerrar vista previa'}).click();
  const [download]=await Promise.all([page.waitForEvent('download'),panel.getByRole('button',{name:'Descargar Acta.pdf'}).click()]);
  const hash=createHash('sha256'),stream=await download.createReadStream();
  for await(const part of stream)hash.update(part);
  expect(hash.digest('hex')).toBe(createHash('sha256').update(original).digest('hex'));
  await panel.getByLabel('Documento, imagen o audio',{exact:true}).setInputFiles({name:'Falso.pdf',mimeType:'application/pdf',buffer:Buffer.from('not a PDF')});
  await panel.getByRole('button',{name:'Guardar archivo'}).click();
  await expect(panel.getByRole('button',{name:'Descargar Falso.pdf'})).toHaveCount(0);
  await expect(panel).toContainText('Revisa los datos del formulario.');
});
