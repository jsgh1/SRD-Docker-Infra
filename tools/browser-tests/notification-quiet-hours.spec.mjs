import { test, expect } from '@playwright/test';
import fs from 'node:fs';
const fixture = JSON.parse(fs.readFileSync(process.env.SRD_BROWSER_FIXTURE));
const mailUrl = process.env.SRD_MAILPIT_URL || 'http://localhost:8025';

async function login(page, role) {
  await page.goto(`/j/${fixture.codeA}/login`);
  await page.getByLabel('Correo electrónico', { exact: true }).fill(fixture.users[role].email);
  await page.getByLabel('Contraseña', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: 'términos y condiciones', exact: true }).click();
  await page.getByRole('button', { name: 'Aceptar términos', exact: true }).click();
  await page.getByRole('button', { name: 'Ingresar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ingresa tu código' })).toBeVisible();
  let message;
  await expect.poll(async () => {
    const list = await (await page.request.get(`${mailUrl}/api/v1/messages`)).json();
    message = list.messages?.find(item => item.Subject === 'Tu código de seguridad de SRD' && item.To.some(to => to.Address === fixture.users[role].email));
    return !!message;
  }, { timeout: 85000 }).toBe(true);
  const content = await (await page.request.get(`${mailUrl}/api/v1/message/${message.ID}`)).json();
  await page.getByLabel('Código de verificación').fill(content.Text.match(/\b\d{6}\b/)[0]);
  await page.getByRole('button', { name: 'Confirmar código' }).click();
  await expect(page.locator('.sidebar').getByRole('button', { name: 'Home', exact: true })).toBeVisible();
}

test('personal quiet hours preserve inbox and resume the badge automatically', async ({ page, browser }) => {
  test.setTimeout(240000);
  await login(page,'admin');
  const token=(await (await page.request.get('/api/v1/csrf')).json()).data.token;
  const title=`Silencio de prueba ${Date.now()}`;
  const starts=new Date(Date.now()+48*3600000),ends=new Date(starts.getTime()+3600000);
  const created=await page.request.post('/api/v1/calendar-events',{headers:{'X-CSRF-TOKEN':token},data:{
    type:'meeting',title,starts_at:starts.toISOString().replace('.000Z','+00:00').replace(/\.\d{3}Z$/,'+00:00'),
    ends_at:ends.toISOString().replace(/\.\d{3}Z$/,'+00:00'),participants:[fixture.users.viewer.id],
  }});
  expect(created.status()).toBe(200);
  const event=(await created.json()).data;
  const context=await browser.newContext({baseURL:process.env.SRD_TEST_URL || 'http://localhost:8080'});
  try {
    const viewer=await context.newPage();
    await login(viewer,'viewer');
    await viewer.clock.install({time:new Date('2026-09-26T23:30:00-05:00')});
    await viewer.reload();
    await expect.poll(async()=>{
      const data=(await (await viewer.request.get('/api/v1/notifications')).json()).data;
      return data.items.some(item=>item.title===title);
    },{timeout:90000,intervals:[1000,2000,5000]}).toBe(true);
    await viewer.getByRole('button',{name:/^Notificaciones/}).click();
    const inbox=viewer.getByRole('region',{name:'Bandeja de notificaciones'});
    await expect(inbox.getByText(`Te invitaron al evento: ${title}`)).toBeVisible();
    await expect(inbox.getByRole('checkbox',{name:'Activar horario de silencio'})).not.toBeChecked();
    await inbox.getByRole('checkbox',{name:'Activar horario de silencio'}).check();
    await inbox.getByRole('button',{name:'Guardar preferencias'}).click();
    await expect(viewer.getByRole('button',{name:'Notificaciones, Horario de silencio',exact:true})).toBeVisible();
    await expect(inbox.getByText('1 sin leer',{exact:true})).toBeVisible();
    await expect(viewer.locator('.notification-count')).toHaveCount(0);
    const saved=(await (await viewer.request.get('/api/v1/notification-preferences')).json()).data;
    expect(saved.quiet_start).toBe('22:00');expect(saved.quiet_end).toBe('07:00');
    expect((await (await page.request.get('/api/v1/notification-preferences')).json()).data.quiet_start).toBeNull();
    let preferenceRequests=0;
    viewer.on('request',request=>{if(request.url().includes('/api/v1/notification-preferences'))preferenceRequests++;});
    await viewer.clock.fastForward(7.5*3600000+60000);
    await expect(viewer.getByRole('button',{name:'Notificaciones, 1 sin leer',exact:true})).toBeVisible();
    await expect(viewer.locator('.notification-count')).toHaveText('1');
    expect(preferenceRequests).toBe(0);
    await viewer.getByRole('button',{name:/^Notificaciones/}).click();
    await viewer.locator('.sidebar').getByRole('button',{name:'Configuración',exact:true}).click();
    await viewer.getByLabel('Preferencia de presencia').selectOption('dnd');
    await viewer.getByRole('button',{name:'Guardar perfil',exact:true}).click();
    await expect(viewer.getByRole('button',{name:'Notificaciones, No molestar',exact:true})).toBeVisible();
    await viewer.reload();
    await viewer.getByRole('button',{name:/^Notificaciones/}).click();
    await expect(inbox.getByLabel('Silencio desde')).toHaveValue('22:00');
    await expect(inbox.getByLabel('Silencio hasta')).toHaveValue('07:00');
    await viewer.setViewportSize({width:360,height:800});
    await inbox.getByRole('button',{name:'Guardar preferencias'}).scrollIntoViewIfNeeded();
    expect(await viewer.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
    const panelBounds=await inbox.boundingBox();
    expect(panelBounds.x).toBeGreaterThanOrEqual(0);
    expect(panelBounds.x+panelBounds.width).toBeLessThanOrEqual(360);
    await viewer.screenshot({path:'.local/notification-quiet-hours-mobile.png'});
    await inbox.getByRole('checkbox',{name:'Activar horario de silencio'}).uncheck();
    await inbox.getByRole('button',{name:'Guardar preferencias'}).click();
    await expect.poll(async()=> (await (await viewer.request.get('/api/v1/notification-preferences')).json()).data.quiet_start).toBeNull();
    expect((await (await viewer.request.get('/api/v1/notifications')).json()).data.unread).toBe(1);
    await expect(viewer.getByRole('button',{name:'Notificaciones, No molestar',exact:true})).toBeVisible();
  } finally {
    await context.close();
    const cancelled=await page.request.post(`/api/v1/calendar-events/${event.id}/cancel`,{
      headers:{'X-CSRF-TOKEN':token},data:{version:event.version},
    });
    expect(cancelled.status()).toBe(200);
  }
});
