import { test, expect } from '@playwright/test';
import fs from 'node:fs';
const fixture = JSON.parse(fs.readFileSync(process.env.SRD_BROWSER_FIXTURE));
const mailUrl = process.env.SRD_MAILPIT_URL || 'http://localhost:8025';

async function login(page) {
  await page.goto(`/j/${fixture.codeA}/login`);
  await page.getByLabel('Correo electrónico', { exact: true }).fill(fixture.users.admin.email);
  await page.getByLabel('Contraseña', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: 'términos y condiciones', exact: true }).click();
  await page.getByRole('button', { name: 'Aceptar términos', exact: true }).click();
  await page.getByRole('button', { name: 'Ingresar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ingresa tu código' })).toBeVisible();
  let message;
  await expect.poll(async () => {
    const list = await (await page.request.get(`${mailUrl}/api/v1/messages`)).json();
    message = list.messages?.find(item => item.Subject === 'Tu código de seguridad de SRD' && item.To.some(to => to.Address === fixture.users.admin.email));
    return !!message;
  }, { timeout: 85000 }).toBe(true);
  const content = await (await page.request.get(`${mailUrl}/api/v1/message/${message.ID}`)).json();
  await page.getByLabel('Código de verificación').fill(content.Text.match(/\b\d{6}\b/)[0]);
  await page.getByRole('button', { name: 'Confirmar código' }).click();
  await expect(page.locator('.sidebar').getByRole('button', { name: 'Home', exact: true })).toBeVisible();
}

test('contact search refreshes visibly, stops on lost access and cleans up', async ({ page }) => {
  test.setTimeout(240000);
  await login(page);
  await page.clock.install({ time: new Date() });
  let calls = 0, presence = 'online', denied = false;
  let gate, captured;
  const queries = [];
  await page.route('**/api/v1/contacts?*', async route => {
    calls++; queries.push(new URL(route.request().url()).searchParams);
    if (gate) { captured(); await gate; }
    return route.fulfill(denied ? { status: 403, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Acceso retirado simulado' } }) }
      : { status: 200, contentType: 'application/json', body: JSON.stringify({ data: { items: [{ id: crypto.randomUUID(), name: 'Contacto sintético', role: 'viewer', presence }], total: 26, page_size: 25 } }) });
  });
  await page.getByRole('button', { name: 'Buscar en la junta', exact: true }).click();
  const form = page.getByRole('form', { name: 'Búsqueda de la junta' });
  await form.getByLabel('Buscar en').selectOption('contacts');
  await form.getByLabel('Texto de búsqueda').fill('Sintético');
  await form.getByRole('button', { name: 'Buscar', exact: true }).click();
  const results = page.getByRole('region', { name: 'Resultados de contactos' });
  await expect(results.locator('.presence-status')).toHaveAttribute('data-state', 'online');
  await form.getByLabel('Texto de búsqueda').fill('Borrador sin aplicar');
  presence = 'away';
  await page.clock.runFor(30000);
  await expect(results.locator('.presence-status')).toHaveAttribute('data-state', 'away');
  expect(calls).toBe(2);
  expect(queries[1].get('q')).toBe('Sintético');
  await page.evaluate(() => Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }));
  presence = 'offline';
  await page.clock.runFor(60000);
  expect(calls).toBe(2);
  await page.evaluate(() => { delete document.visibilityState; document.dispatchEvent(new Event('visibilitychange')); });
  await expect(results.locator('.presence-status')).toHaveAttribute('data-state', 'offline');
  expect(calls).toBe(3);
  await results.getByRole('button', { name: 'Siguiente', exact: true }).click();
  await expect(results.getByText('Página 2', { exact: true })).toBeVisible();
  await expect(results.getByRole('button', { name: 'Actualizar contactos', exact: true })).toBeEnabled();
  expect(queries.at(-1).get('page')).toBe('2');
  denied = true;
  await page.clock.runFor(30000);
  await expect(results.getByRole('alert')).toContainText('Acceso retirado simulado');
  await expect(results.locator('.contact-card')).toHaveCount(0);
  const stoppedCalls = calls;
  await page.clock.runFor(60000);
  expect(calls).toBe(stoppedCalls);
  denied = false; presence = 'dnd';
  await results.getByRole('button', { name: 'Actualizar contactos', exact: true }).click();
  await expect(results.locator('.presence-status')).toHaveAttribute('data-state', 'dnd');
  expect(queries.at(-1).get('page')).toBe('2');
  let release;
  gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { captured = resolve; });
  const beforeSlow = calls;
  presence = 'online';
  await page.clock.runFor(30000);
  await started;
  await page.clock.runFor(60000);
  expect(calls).toBe(beforeSlow + 1);
  release(); gate = undefined;
  await expect(results.locator('.presence-status')).toHaveAttribute('data-state', 'online');
  await page.setViewportSize({ width: 360, height: 800 });
  await results.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: '.local/search-contact-presence-mobile.png' });
  await form.getByRole('button', { name: 'Limpiar búsqueda', exact: true }).click();
  const before = calls;
  await page.clock.runFor(60000);
  expect(calls).toBe(before);
  let personCalls = 0;
  await page.route('**/api/v1/persons?*', route => {
    personCalls++;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { items: [], total: 0, page_size: 10 } }) });
  });
  await form.getByLabel('Buscar en').selectOption('persons');
  await form.getByLabel('Texto de búsqueda').fill('Persona sintética');
  await form.getByRole('button', { name: 'Buscar', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Resultados de personas' }).getByText('Sin coincidencias en personas', { exact: true })).toBeVisible();
  await page.clock.runFor(60000);
  expect(personCalls).toBe(1);
  expect(calls).toBe(before);
});
