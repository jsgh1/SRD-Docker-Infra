import { test, expect } from '@playwright/test';
import fs from 'node:fs';

const fixture = JSON.parse(fs.readFileSync(process.env.SRD_BROWSER_FIXTURE));
const mailUrl = process.env.SRD_MAILPIT_URL || 'http://localhost:8025';

async function login(page, role) {
  const email = fixture.users[role].email;
  const before = await (await page.request.get(`${mailUrl}/api/v1/messages`)).json();
  const oldIds = new Set(before.messages?.map(message => message.ID) || []);
  await page.goto(`/j/${fixture.codeA}/login`);
  await page.getByLabel('Correo electrónico', { exact: true }).fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: 'términos y condiciones', exact: true }).click();
  await page.getByRole('button', { name: 'Aceptar términos', exact: true }).click();
  await page.getByRole('button', { name: 'Ingresar', exact: true }).click();
  let message;
  await expect.poll(async () => {
    const list = await (await page.request.get(`${mailUrl}/api/v1/messages`)).json();
    message = list.messages?.find(item => !oldIds.has(item.ID) && item.Subject === 'Tu código de seguridad de SRD'
      && item.To.some(to => to.Address === email));
    return !!message;
  }, { timeout: 85000 }).toBe(true);
  const content = await (await page.request.get(`${mailUrl}/api/v1/message/${message.ID}`)).json();
  await page.getByLabel('Código de verificación').fill(content.Text.match(/\b\d{6}\b/)[0]);
  await page.getByRole('button', { name: 'Confirmar código' }).click();
  await expect(page.locator('.profile-trigger')).toBeVisible();
}

test('los seis roles reciben navegación y API coherentes', async ({ browser }) => {
  test.setTimeout(420000);
  const cases = [
    { role: 'superadmin', visible: ['Registro', 'Tesorería', 'Inventario', 'Auditoría'], hidden: [] },
    { role: 'admin', visible: ['Registro', 'Tesorería', 'Inventario', 'Auditoría'], hidden: [] },
    { role: 'registrar', visible: ['Registro'], hidden: ['Tesorería', 'Inventario', 'Auditoría'] },
    { role: 'treasurer', visible: ['Tesorería', 'Inventario'], hidden: ['Registro', 'Auditoría'] },
    { role: 'auditor', visible: ['Auditoría'], hidden: ['Registro', 'Tesorería', 'Inventario'] },
    { role: 'viewer', visible: [], hidden: ['Registro', 'Tesorería', 'Inventario', 'Auditoría'] },
  ];
  for (const item of cases) {
    const context = await browser.newContext({ baseURL: process.env.SRD_TEST_URL, viewport: { width: 390, height: 800 } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    try {
      await login(page, item.role);
      await page.getByRole('button', { name: 'Abrir menú' }).click();
      const nav = page.locator('.sidebar nav');
      for (const label of item.visible) await expect(nav.getByRole('button', { name: label, exact: true })).toBeVisible();
      for (const label of item.hidden) await expect(nav.getByRole('button', { name: label, exact: true })).toHaveCount(0);
      await nav.getByRole('button', { name: 'Lista', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Lista de personas' })).toBeVisible();
      await expect(page.locator('.workspace .error')).toHaveCount(0);
      expect((await page.request.get('/api/v1/persons')).status(), `${item.role}: personas`).toBe(200);
      for (const [label, endpoint] of [['Tesorería', '/api/v1/treasury'], ['Inventario', '/api/v1/assets'], ['Auditoría', '/api/v1/audit-events']]) {
        if (item.hidden.includes(label)) expect((await page.request.get(endpoint)).status(), `${item.role}: ${endpoint}`).toBe(403);
      }
      const csrf = (await (await page.request.get('/api/v1/csrf')).json()).data.token;
      const writes = [
        { path: '/api/v1/persons', allowed: ['superadmin', 'admin', 'registrar'] },
        { path: '/api/v1/folders', allowed: ['superadmin', 'admin'] },
        { path: '/api/v1/invitations', allowed: ['superadmin', 'admin', 'registrar'] },
        { path: '/api/v1/treasury/movements', allowed: ['superadmin', 'admin', 'treasurer'] },
        { path: '/api/v1/assets', allowed: ['superadmin', 'admin', 'treasurer'] },
        { path: '/api/v1/folder-documents', allowed: ['superadmin', 'admin'] },
        { path: '/api/v1/calendar-events', allowed: ['superadmin', 'admin', 'registrar', 'treasurer', 'auditor', 'viewer'] },
        { path: '/api/v1/calendar-settings', method: 'PUT', allowed: ['superadmin', 'admin'] },
        { path: '/api/v1/organization', method: 'PATCH', allowed: ['superadmin', 'admin'] },
        { path: '/api/v1/conversations', allowed: ['superadmin', 'admin', 'registrar', 'treasurer', 'auditor', 'viewer'] },
        { path: `/api/v1/audit-delivery/records/${crypto.randomUUID()}/retry`, allowed: ['superadmin', 'admin'], valid: 404 },
      ];
      for (const write of writes) {
        const response = await page.request.fetch(write.path, { method: write.method || 'POST', headers: { 'X-CSRF-TOKEN': csrf }, data: {} });
        const expected = write.allowed.includes(item.role) ? (write.valid || 422) : 403;
        expect(response.status(), `${item.role}: ${write.path}: permiso y validación`).toBe(expected);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${item.role}: ancho móvil`).toBe(true);
      const settingsWrites = [
        { path: 'person-fields', body: { version: 999999, fields: [] } },
        { path: 'person-filter-settings', body: { version: 999999, base: [], custom: [] } },
        { path: 'planilla-settings', body: { version: 999999, allowed_columns: [], h1: 'Prueba', h2: 'Prueba', h3: 'Prueba', h1_en: 'Test', h2_en: 'Test', h3_en: 'Test' } },
      ];
      for (const setting of settingsWrites) {
        const read = await page.request.get(`/api/v1/${setting.path}`);
        expect(read.status(), `${item.role}: ${setting.path}: lectura`).toBe(200);
        const canManage = Boolean((await read.json()).data.can_manage);
        const response = await page.request.put(`/api/v1/${setting.path}`, { headers: { 'X-CSRF-TOKEN': csrf }, data: setting.body });
        expect(response.status(), `${item.role}: ${setting.path}: permiso sin modificar`).toBe(canManage ? 409 : 403);
      }
      const positionsRead = await page.request.get('/api/v1/person-positions');
      expect(positionsRead.status(), `${item.role}: cargos: lectura`).toBe(200);
      const positions = (await positionsRead.json()).data;
      const positionsWrite = await page.request.put('/api/v1/person-positions', { headers: { 'X-CSRF-TOKEN': csrf },
        data: { version: 999999, items: positions.items } });
      expect(positionsWrite.status(), `${item.role}: cargos: permiso sin modificar`).toBe(
        ['superadmin', 'admin'].includes(item.role) ? 409 : 403);
      const folderAccessRead = await page.request.get('/api/v1/folder-access');
      expect(folderAccessRead.status(), `${item.role}: permisos de Carpeta: lectura`).toBe(200);
      const folderAccess = (await folderAccessRead.json()).data;
      const folderAccessWrite = await page.request.put('/api/v1/folder-access', { headers: { 'X-CSRF-TOKEN': csrf },
        data: { version: 999999, reader_roles: [], reader_memberships: [] } });
      expect(folderAccessWrite.status(), `${item.role}: permisos de Carpeta sin modificar`).toBe(folderAccess.can_manage ? 409 : 403);
      const sections = await nav.locator('button').allTextContents();
      for (const section of sections.map(value => value.trim()).filter(Boolean)) {
        await page.getByRole('button', { name: 'Abrir menú' }).click();
        await nav.getByRole('button', { name: section, exact: true }).click();
        await expect(page.locator('.workspace .loading')).toHaveCount(0, { timeout: 20000 });
        await expect(page.locator('.workspace .error'), `${item.role}: ${section}`).toHaveCount(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${item.role}: ${section}: ancho móvil`).toBe(true);
      }
      expect(pageErrors, `${item.role}: errores JavaScript`).toEqual([]);
    } finally {
      await context.close();
    }
  }
});
