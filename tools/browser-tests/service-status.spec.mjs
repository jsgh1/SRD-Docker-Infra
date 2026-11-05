import {test,expect} from '@playwright/test';
import fs from 'node:fs';

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

test('administrators see live service availability without internal addresses',async({page})=>{
  test.setTimeout(150000);
  await login(page,'admin');
  await page.locator('.sidebar').getByRole('button',{name:'Configuración',exact:true}).click();
  const panel=page.getByRole('region',{name:'Estado de servicios'});
  await expect(panel).toContainText('10 de 10 servicios disponibles');
  await expect(panel.locator('.delivery-grid').first().locator(':scope > .delivery-card')).toHaveCount(11);
  await expect(panel).toContainText('Antivirus de archivos');
  const serviceStatus=(await(await page.request.get('/api/v1/system/services')).json()).data;
  await expect(panel).toContainText(serviceStatus.antivirus_available ? 'Disponible y firmas recientes' : 'No disponible o firmas vencidas');
  const schedulers=panel.getByRole('region',{name:'Estado de planificadores'});
  await expect(schedulers).toContainText('9 de 9 planificadores al día');
  await expect(schedulers.locator('.delivery-card')).toHaveCount(9);
  await expect(schedulers).toContainText('Ciclo: reciente');
  await expect(schedulers).toContainText('Auditoría: reciente');
  await expect(panel.getByRole('region',{name:'Entregas de calendario'})).toContainText('Avisos de calendario');
  await expect(panel.getByRole('region',{name:'Entregas de calendario'})).toContainText('Agotados');
  await expect(panel.getByRole('region',{name:'Entregas de correo'})).toContainText('Invitaciones');
  await expect(panel.getByRole('region',{name:'Entregas de correo'})).toContainText('Avisos de seguridad');
  await expect(panel).not.toContainText('http://');
  await panel.getByRole('button',{name:'Actualizar estado'}).click();
  await expect(panel).toContainText('10 de 10 servicios disponibles');
  const refreshedServiceStatus=(await(await page.request.get('/api/v1/system/services')).json()).data;
  await expect(panel).toContainText(refreshedServiceStatus.antivirus_available ? 'Disponible y firmas recientes' : 'No disponible o firmas vencidas');
  await expect(schedulers).toContainText('9 de 9 planificadores al día');
  await expect(page.getByRole('alert',{name:'Alerta de planificadores'})).toHaveCount(0);
  let degraded=true;
  await page.route('**/api/v1/system/schedulers',route=>route.fulfill({
    status:200,contentType:'application/json',body:JSON.stringify({data:{items:[
      'identity','configuration','records','files','calendar','notifications','treasury','inventory','chat',
    ].map(service=>({service,available:!degraded||service!=='files'})),checked_at:new Date().toISOString()}}),
  }));
  await page.evaluate(()=>window.dispatchEvent(new Event('online')));
  const alert=page.getByRole('alert',{name:'Alerta de planificadores'});
  await expect(alert).toContainText('Archivos');
  await expect(alert).toContainText('Algunas tareas o avisos podrían retrasarse');
  await alert.getByRole('button',{name:'Ver estado'}).click();
  await expect(page.getByRole('region',{name:'Estado de servicios'})).toBeVisible();
  await expect(page.locator('#service-status')).toBeInViewport();
  degraded=false;
  await page.evaluate(()=>window.dispatchEvent(new Event('online')));
  await expect(alert).toHaveCount(0);
  let exhausted=true;
  await page.route('**/api/v1/system/calendar-deliveries',route=>route.fulfill({
    status:200,contentType:'application/json',body:JSON.stringify({data:{exhausted:exhausted?2:0}}),
  }));
  await page.route('**/api/v1/system/mail-deliveries',route=>route.fulfill({
    status:200,contentType:'application/json',body:JSON.stringify({data:{
      invitations:{exhausted:exhausted?1:0},security_notices:{exhausted:0},
    }}),
  }));
  await page.evaluate(()=>window.dispatchEvent(new Event('online')));
  const deliveryAlert=page.getByRole('alert',{name:'Alerta de entregas'});
  await expect(deliveryAlert).toContainText('2 avisos de calendario y 1 correo');
  await deliveryAlert.getByRole('button',{name:'Ver entregas'}).click();
  await expect(page.locator('#service-status')).toBeInViewport();
  exhausted=false;
  await page.evaluate(()=>window.dispatchEvent(new Event('online')));
  await expect(deliveryAlert).toHaveCount(0);
  let auditExhausted=true;
  let auditUnavailable=true;
  await page.route('**/api/v1/system/audit-deliveries',route=>route.fulfill({
    status:200,contentType:'application/json',body:JSON.stringify({data:{items:[
      'identity','configuration','records','files','calendar','notifications','treasury','inventory','chat',
    ].map(service=>({service,available:!auditUnavailable||service!=='chat',exhausted:auditUnavailable&&service==='chat'?null:(auditExhausted&&service==='files'?2:0)}))}}),
  }));
  await page.evaluate(()=>window.dispatchEvent(new Event('online')));
  const auditAlert=page.getByRole('alert',{name:'Alerta de auditoría'});
  await expect(auditAlert).toContainText('2 eventos de auditoría con entrega agotada');
  await expect(auditAlert).toContainText('Chat');
  await auditAlert.getByRole('button',{name:'Ver auditoría'}).click();
  await expect(page.getByRole('heading',{name:'Auditoría',exact:true})).toBeVisible();
  auditExhausted=false;
  await page.evaluate(()=>window.dispatchEvent(new Event('online')));
  await expect(auditAlert).toContainText('No se pudo comprobar toda la entrega de auditoría');
  auditUnavailable=false;
  await page.evaluate(()=>window.dispatchEvent(new Event('online')));
  await expect(auditAlert).toHaveCount(0);
  await page.locator('.sidebar').getByRole('button',{name:'Configuración',exact:true}).click();
  const statusPanel=page.getByRole('region',{name:'Estado de servicios'});
  await expect(statusPanel).toContainText('10 de 10 servicios disponibles');
  let failOnce=true;
  await page.route('**/api/v1/system/services',async route=>{
    if(failOnce){failOnce=false;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{message:'Estado temporalmente no disponible.'}})});}
    else await route.continue();
  });
  await statusPanel.getByRole('button',{name:'Actualizar estado'}).click();
  await expect(statusPanel.locator('.error')).toContainText('Estado temporalmente no disponible.');
  await expect(statusPanel).not.toContainText('10 de 10 servicios disponibles');
  await statusPanel.getByRole('button',{name:'Actualizar estado'}).click();
  await expect(statusPanel).toContainText('10 de 10 servicios disponibles');
  await page.unroute('**/api/v1/system/services');
  await page.route('**/api/v1/system/services',async route=>{await new Promise(resolve=>setTimeout(resolve,31000));await route.abort().catch(()=>{});});
  await statusPanel.getByRole('button',{name:'Actualizar estado'}).click();
  await expect(statusPanel.locator('.error')).toContainText('La conexión tardó demasiado.',{timeout:34000});
  await expect(statusPanel).not.toContainText('10 de 10 servicios disponibles');
  await page.unroute('**/api/v1/system/services');
  await statusPanel.getByRole('button',{name:'Actualizar estado'}).click();
  await expect(statusPanel).toContainText('10 de 10 servicios disponibles');
});
