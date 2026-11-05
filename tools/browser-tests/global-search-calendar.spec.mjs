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

test('calendar search finds past literal events for all roles and retries independently', async ({ page, browser }) => {
  test.setTimeout(240000);
  await login(page, 'admin');
  const marker = String(Date.now()).slice(-8);
  const title = `Reunión 50%_! ${marker}`;
  const token = (await (await page.request.get('/api/v1/csrf')).json()).data.token;
  let wantedId;
  for (const name of [title, `Reunión 50ABC! ${marker}`]) {
    const response = await page.request.post('/api/v1/calendar-events', { headers: { 'X-CSRF-TOKEN': token }, data: {
      type: 'meeting', title: name, location: `Salón ${marker}`,
      starts_at: '2024-01-10T09:00:00-05:00', ends_at: '2024-01-10T10:00:00-05:00',
    } });
    expect(response.status()).toBe(200);
    if (name === title) wantedId = (await response.json()).data.id;
  }
  const viewerContext = await browser.newContext({ baseURL: process.env.SRD_TEST_URL || 'http://localhost:8080' });
  try {
    const viewer = await viewerContext.newPage();
    await login(viewer, 'viewer');
    await viewer.getByRole('button', { name: 'Buscar en la junta', exact: true }).click();
    const form = viewer.getByRole('form', { name: 'Búsqueda de la junta' });
    const calendar = viewer.getByRole('region', { name: 'Resultados de calendario' });
    await form.getByLabel('Texto de búsqueda').fill(`50%_! ${marker}`);
    await form.getByRole('button', { name: 'Buscar', exact: true }).click();
    await expect(calendar.getByText('1 coincidencias en calendario')).toBeVisible();
    await expect(calendar.getByRole('row').filter({ hasText: title })).toBeVisible();
    await calendar.getByRole('button', { name: `Ver evento ${title}` }).click();
    await expect(viewer.getByRole('dialog', { name: 'Detalle del evento' }).getByText(title)).toBeVisible();
    await viewer.getByRole('dialog', { name: 'Detalle del evento' }).getByRole('button', { name: 'Cerrar' }).click();
    let detailFailed = false;
    await viewer.route(`**/api/v1/calendar-events/${wantedId}`, async route => {
      if (!detailFailed) {
        detailFailed = true;
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Evento no disponible.' } }) });
      } else await route.continue();
    });
    await calendar.getByRole('button', { name: `Ver evento ${title}` }).click();
    await expect(calendar).toContainText('Evento no disponible.');
    await calendar.getByRole('button', { name: 'Reintentar evento' }).click();
    await expect(viewer.getByRole('dialog', { name: 'Detalle del evento' }).getByText(title)).toBeVisible();
    await viewer.getByRole('dialog', { name: 'Detalle del evento' }).getByRole('button', { name: 'Cerrar' }).click();
    await viewer.unroute(`**/api/v1/calendar-events/${wantedId}`);
    await viewer.route('**/api/v1/calendar-events/search?*', route => route.fulfill({ status: 503, contentType: 'application/json',
      body: JSON.stringify({ error: { message: 'Fallo simulado de calendario' } }) }));
    await form.getByRole('button', { name: 'Buscar', exact: true }).click();
    await expect(calendar.getByRole('alert')).toBeVisible();
    await expect(viewer.getByRole('region', { name: 'Resultados de personas' })).toBeVisible();
    await viewer.unroute('**/api/v1/calendar-events/search?*');
    await calendar.getByRole('button', { name: 'Reintentar calendario' }).click();
    await expect(calendar.getByText('1 coincidencias en calendario')).toBeVisible();
    await viewer.setViewportSize({ width: 360, height: 800 });
    expect(await viewer.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await form.getByLabel('Buscar en').selectOption('calendar');
    await form.getByLabel('Texto de búsqueda').fill(`Salón ${marker}`);
    await form.getByRole('button', { name: 'Buscar', exact: true }).click();
    await expect(calendar.getByText('2 coincidencias en calendario')).toBeVisible();
  } finally { await viewerContext.close(); }
});
