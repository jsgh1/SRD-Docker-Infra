import { test, expect } from '@playwright/test';
import fs from 'node:fs';
const fixture=JSON.parse(fs.readFileSync(process.env.SRD_BROWSER_FIXTURE));

async function login(page) {
  await page.goto(`/j/${fixture.codeA}/login`);
  await page.getByLabel('Correo electrónico',{exact:true}).fill(fixture.users.admin.email);
  await page.getByLabel('Contraseña',{exact:true}).fill(fixture.password);
  await page.getByRole('button',{name:'términos y condiciones',exact:true}).click();
  await page.getByRole('button',{name:'Aceptar términos',exact:true}).click();
  await page.getByRole('button',{name:'Ingresar',exact:true}).click();
  const mailUrl=process.env.SRD_MAILPIT_URL || 'http://localhost:8025';
  let message;
  await expect.poll(async()=>{
    const list=await (await page.request.get(`${mailUrl}/api/v1/messages`)).json();
    message=list.messages?.find(item=>item.Subject==='Tu código de seguridad de SRD'&&item.To.some(to=>to.Address===fixture.users.admin.email));
    return !!message;
  }).toBe(true);
  const content=await (await page.request.get(`${mailUrl}/api/v1/message/${message.ID}`)).json();
  await page.getByLabel('Código de verificación').fill(content.Text.match(/\b\d{6}\b/)[0]);
  await page.getByRole('button',{name:'Confirmar código'}).click();
  await expect(page.locator('.sidebar').getByRole('button',{name:'Home',exact:true})).toBeVisible();
}

test('english people export keeps council-authored text and downloads a PDF',async({page})=>{
  await login(page);
  const token=(await (await page.request.get('/api/v1/csrf')).json()).data.token;
  const number=`LANG-${crypto.randomUUID().slice(0,8)}`;
  const created=await page.request.post('/api/v1/persons',{headers:{'X-CSRF-TOKEN':token},data:{
    document_type:'CC',document_number:number,first_names:'Nombre propio',status:'pending',
    authorization_basis:'Prueba sintética',authorization_purpose:'Verificar idioma de exportaciones',
  }});
  expect(created.status()).toBe(200);
  const id=(await created.json()).data.id;
  try {
    await page.locator('.profile-trigger').click();
    await page.getByLabel('Idioma',{exact:true}).selectOption('en');
    await page.locator('.profile-trigger').click();
    await page.locator('.sidebar').getByRole('button',{name:'List',exact:true}).click();
    const filters=page.getByRole('form',{name:'People filters'});
    await filters.getByLabel('Search',{exact:true}).fill(number);
    await filters.getByRole('button',{name:'Apply filters'}).click();
    await expect(page.getByText('1 records found',{exact:true})).toBeVisible();
    const response=await page.request.get(`/api/v1/persons/export-pdf?q=${number}&language=en`);
    expect(response.status()).toBe(200);
    const data=(await response.json()).data;
    expect(data.headers[1]).toBe('First names');
    expect(data.rows[0][1]).toBe('Nombre propio');
    const requestPromise=page.waitForRequest(request=>request.url().includes('/persons/export-pdf?'));
    const downloadPromise=page.waitForEvent('download');
    await page.getByRole('button',{name:'Export PDF'}).click();
    expect(new URL((await requestPromise).url()).searchParams.get('language')).toBe('en');
    expect(fs.readFileSync(await (await downloadPromise).path()).subarray(0,5).toString()).toBe('%PDF-');
    await page.getByRole('button',{name:'View Nombre propio'}).click();
    const detail=page.getByRole('dialog',{name:'Person details'});
    const individualRequest=page.waitForRequest(request=>request.url().includes(`/persons/${id}/pdf?`));
    const individualDownload=page.waitForEvent('download');
    await detail.getByRole('button',{name:'Download PDF record'}).click();
    expect(new URL((await individualRequest).url()).searchParams.get('language')).toBe('en');
    expect(fs.readFileSync(await (await individualDownload).path()).subarray(0,5).toString()).toBe('%PDF-');
  } finally {
    const removed=await page.request.delete(`/api/v1/persons/${id}`,{headers:{'X-CSRF-TOKEN':token},data:{version:1,confirmed:true}});
    expect(removed.status()).toBe(200);
  }
});
