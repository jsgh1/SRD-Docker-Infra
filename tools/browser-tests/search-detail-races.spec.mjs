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

test('search details ignore obsolete success, errors, close and unmount responses', async ({ page }) => {
  test.setTimeout(240000);
  await login(page);
  await page.getByRole('button', { name: 'Buscar en la junta', exact: true }).click();
  const form = page.getByRole('form', { name: 'Búsqueda de la junta' });
  const ids = [crypto.randomUUID(), crypto.randomUUID()];
  const calendar = ids.map((id, i) => ({ id, title: `Evento ${i}`, type: 'meeting',
    starts_at: '2030-01-01T12:00:00Z', ends_at: '2030-01-01T13:00:00Z', cancelled_at: null,
    state: 'scheduled', remind_24h: true, remind_1h: false, description: null, location: null, participants: [] }));
  const assets = ids.map((id, i) => ({ id, code: `BIEN-${i}`, name: `Bien ${i}`, type: 'movable', quantity: 26,
    unit: 'unidad', location: 'Sede sintética', condition: 'Bueno', status: 'active', category: 'Prueba', description: null, responsible_name: null }));
  const receipts = ids.map((id, i) => ({ id, receipt: `TES-00000${i + 1}`, kind: 'income', sign: 1,
    amount: '1.00', balance_after: '1.00', effective_date: '2026-09-26', concept: `Asiento ${i}`, actor_name: 'Prueba', support_note: null, reverses_id: null, reversed_by_id: null }));
  const rows = Array.from({ length: 25 }, (_, i) => ({ id: crypto.randomUUID(), sequence: 26 - i, type: 'in', delta: 1, quantity_after: 26 - i, reason: `Movimiento ${26 - i}`, performer_name: 'Prueba' }));
  const groups = [
    { scope: 'calendar', region: 'Resultados de calendario', list: 'calendar-events/search', detail: 'calendar-events', items: calendar, names: calendar.map(item => `Ver evento ${item.title}`), data: calendar },
    { scope: 'assets', region: 'Resultados de bienes', list: 'assets', detail: 'assets', items: assets, names: assets.map(item => `Ver bien ${item.code}`), data: assets.map(asset => ({ asset, movements: rows, movement_page: 1, movement_page_size: 25, movement_total: 26 })) },
    { scope: 'treasury', region: 'Resultados de tesorería', list: 'treasury', detail: 'treasury/movements', items: receipts, names: receipts.map(item => `Ver comprobante ${item.receipt}`), data: receipts },
  ];
  const json = data => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ data }) });
  await page.route('**/api/v1/assets/*/photos', route => route.fulfill(json({ items: ['front', 'side', 'detail'].map(slot => ({ slot, version: 0, present: false, size: 0, width: null, height: null })) })));
  for (const group of groups) {
    await page.route(`**/api/v1/${group.list}?*`, route => route.fulfill(json({ items: group.items, total: 2, page_size: 25 })));
    await page.route(`**/api/v1/${group.detail}/${ids[1]}`, route => route.fulfill(json(group.data[1])));
    const search = async () => {
      await form.getByLabel('Buscar en').selectOption(group.scope);
      await form.getByLabel('Texto de búsqueda').fill('Sintético');
      await form.getByRole('button', { name: 'Buscar', exact: true }).click();
      await expect(page.getByRole('region', { name: group.region }).getByRole('button', { name: group.names[1], exact: true })).toBeVisible();
    };
    for (const scenario of ['success', 'error', 'close', 'unmount']) {
      await search();
      let release, captured;
      const gate = new Promise(resolve => { release = resolve; });
      const started = new Promise(resolve => { captured = resolve; });
      const url = `**/api/v1/${group.detail}/${ids[0]}`;
      await page.route(url, async route => {
        captured(); await gate;
        await route.fulfill(scenario === 'error' ? { status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Error antiguo simulado' } }) } : json(group.data[0]));
      });
      const region = page.getByRole('region', { name: group.region });
      await region.getByRole('button', { name: group.names[0], exact: true }).click();
      await started;
      if (scenario === 'unmount') await form.getByRole('button', { name: 'Limpiar búsqueda', exact: true }).click();
      else {
        await region.getByRole('button', { name: group.names[1], exact: true }).click();
        await expect(page.getByRole('dialog')).toBeVisible();
        const text = group.scope === 'calendar' ? calendar[1].title : group.scope === 'assets' ? assets[1].name : receipts[1].concept;
        await expect(page.getByRole('dialog').getByText(text, { exact: group.scope !== 'assets' })).toBeVisible();
        if (scenario === 'close') await page.getByRole('dialog').getByRole('button', { name: 'Cerrar', exact: true }).click();
      }
      const settled = page.waitForResponse(response => response.url().endsWith(`/${ids[0]}`));
      release(); await settled; await page.waitForLoadState('networkidle');
      if (scenario === 'close' || scenario === 'unmount') await expect(page.getByRole('dialog')).toHaveCount(0);
      else {
        const text = group.scope === 'calendar' ? calendar[1].title : group.scope === 'assets' ? assets[1].name : receipts[1].concept;
        await expect(page.getByRole('dialog').getByText(text, { exact: group.scope !== 'assets' })).toBeVisible();
        await expect(region.getByRole('alert')).toHaveCount(0);
        await page.getByRole('dialog').getByRole('button', { name: 'Cerrar', exact: true }).click();
      }
      await page.unroute(url);
    }
    if (group.scope === 'assets') {
      await search();
      const region = page.getByRole('region', { name: group.region });
      await region.getByRole('button', { name: group.names[1], exact: true }).click();
      let release, captured;
      const gate = new Promise(resolve => { release = resolve; });
      const started = new Promise(resolve => { captured = resolve; });
      const url = `**/api/v1/assets/${ids[1]}?movement_page=2`;
      await page.route(url, async route => {
        captured(); await gate;
        await route.fulfill(json({ ...group.data[1], movement_page: 2, movements: [{ ...rows[0], sequence: 1, reason: 'Página antigua demorada' }] }));
      });
      await page.getByRole('dialog').getByRole('button', { name: 'Movimientos más antiguos', exact: true }).click();
      await started;
      await page.getByRole('dialog').getByRole('button', { name: 'Cerrar', exact: true }).click();
      await region.getByRole('button', { name: group.names[1], exact: true }).click();
      await expect(page.getByRole('dialog').getByText('Página 1', { exact: true })).toBeVisible();
      await expect(page.getByRole('dialog').getByRole('button', { name: 'Movimientos más antiguos', exact: true })).toBeEnabled();
      const settled = page.waitForResponse(response => response.url().endsWith('movement_page=2'));
      release(); await settled; await page.waitForLoadState('networkidle');
      await expect(page.getByRole('dialog').getByText('Página 1', { exact: true })).toBeVisible();
      await expect(page.getByRole('dialog').getByText('Página antigua demorada', { exact: true })).toHaveCount(0);
      await page.getByRole('dialog').getByRole('button', { name: 'Cerrar', exact: true }).click();
      await page.unroute(url);
    }
  }
});
