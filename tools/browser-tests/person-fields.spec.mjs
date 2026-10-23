import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '../..');
const fixture = JSON.parse(fs.readFileSync(process.env.SRD_BROWSER_FIXTURE || path.join(root, '.local/e2e-fixture.json')));
async function login(page, role) {
  await page.goto(`/j/${fixture.codeA || 'srd-e2e-a'}/login`);
  await page.getByLabel('Correo electrónico', { exact: true }).fill(fixture.users[role].email);
  await page.getByLabel('Contraseña', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: 'términos y condiciones', exact: true }).click();
  await page.getByRole('button', { name: 'Aceptar términos', exact: true }).click();
  await page.getByRole('button', { name: 'Ingresar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ingresa tu código' })).toBeVisible();
  let message;
  const url = process.env.SRD_MAILPIT_URL || 'http://127.0.0.1:8125';
  await expect.poll(async () => {
    const list = await (await page.request.get(`${url}/api/v1/messages`)).json();
    message = list.messages?.find(m => m.Subject === 'Tu código de seguridad de SRD' && m.To.some(t => t.Address === fixture.users[role].email));
    return !!message;
  }).toBe(true);
  const content = await (await page.request.get(`${url}/api/v1/message/${message.ID}`)).json();
  await page.getByLabel('Código de verificación').fill(content.Text.match(/\b\d{6}\b/)[0]);
  await page.getByRole('button', { name: 'Confirmar código' }).click();
  await expect(page.locator('.sidebar').getByRole('button', { name: 'Home', exact: true })).toBeVisible();
}
async function navigate(page, name) { await page.locator('.sidebar').getByRole('button', { name, exact: true }).click(); }
async function mutation(page, method, url, data) {
  const token = (await (await page.request.get('/api/v1/csrf')).json()).data.token;
  return page.request.fetch(url, { method, data, headers: { 'X-CSRF-TOKEN': token } });
}

test('additional fields persist, validate, preserve inactive history and reject stale forms', async ({ page, context, browser }) => {
  test.setTimeout(240000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await login(page, 'admin');
  await navigate(page, 'Configuración');
  const panel = page.getByRole('region', { name: 'Configuración de campos adicionales' });
  await expect(panel.getByRole('button', { name: 'Agregar campo', exact: true })).toBeVisible();
  for (const [index, type, label, english] of [[1, 'date', 'Fecha de vinculación', 'Joining date'], [2, 'text', 'Referencia comunitaria', 'Community reference'], [3, 'number', 'Medida declarada', 'Declared measurement'], [4, 'select', 'Sector comunitario', 'Community sector']]) {
    await panel.getByRole('button', { name: 'Agregar campo', exact: true }).click();
    const card = panel.getByRole('group', { name: `Campo ${index}`, exact: true });
    await card.getByLabel('Etiqueta del campo').fill(label);
    await card.getByLabel('Etiqueta en inglés').fill(english);
    await card.getByRole('combobox', { name: 'Tipo del campo' }).selectOption(type);
    if (index === 1) await card.getByLabel('Obligatorio al completar').check();
    if (type === 'select') {
      for (const [n, name] of [[1, 'Sector original'], [2, 'Sector vigente']]) {
        await card.getByRole('button', { name: 'Agregar opción' }).click();
        await card.getByRole('textbox', { name: `Opción ${n}`, exact: true }).fill(name);
        await card.getByRole('textbox', { name: `Opción ${n} en inglés`, exact: true }).fill(n === 1 ? 'Original sector' : 'Current sector');
      }
    }
  }
  expect((await page.request.put('/api/v1/person-fields', { data: { version: 0, fields: [] } })).status()).toBe(419);
  await panel.getByRole('button', { name: 'Guardar campos adicionales' }).click();
  await expect(panel.getByRole('status').filter({ hasText: 'Campos adicionales guardados.' })).toBeVisible();
  const schema = (await (await page.request.get('/api/v1/person-fields')).json()).data;
  expect(schema.fields).toHaveLength(4);
  expect(schema.version).toBe(1);
  await page.reload();
  await navigate(page, 'Configuración');
  await expect(panel).toHaveCount(1);
  await expect(panel.getByRole('textbox', { name: 'Etiqueta del campo' }).first()).toHaveValue('Fecha de vinculación');
  await panel.evaluate(el => window.scrollTo(0, scrollY + el.getBoundingClientRect().top - 90));
  await page.screenshot({ path: path.join(root, '.local/person-fields-settings-desktop.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 360, height: 800 });
  await panel.evaluate(el => window.scrollTo(0, scrollY + el.getBoundingClientRect().top - 90));
  await page.screenshot({ path: path.join(root, '.local/person-fields-settings-mobile.png'), animations: 'disabled' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 720 });
  await navigate(page, 'Registro');
  await page.getByRole('combobox', { name: /Tipo de documento/ }).selectOption('CC');
  await page.getByLabel('Número de documento').fill('FIELD-' + Date.now());
  await page.getByLabel('Nombres', { exact: false }).fill('Persona de campos');
  await page.getByLabel('Fundamento o referencia del soporte').fill('Prueba sintética');
  await page.getByLabel('Finalidad de la captura').fill('Validar campos adicionales');
  await page.getByLabel('Información reservada').fill('Nota interna de prueba');
  await page.getByLabel('Fecha de vinculación').fill('2026-09-10');
  await page.getByLabel('Referencia comunitaria').fill('Referencia histórica');
  await page.getByRole('spinbutton', { name: 'Medida declarada' }).fill('0');
  await page.getByRole('combobox', { name: 'Sector comunitario' }).selectOption({ label: 'Sector original' });
  const created = page.waitForResponse(r => new URL(r.url()).pathname === '/api/v1/persons' && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Guardar registro', exact: true }).click();
  const personId = (await (await created).json()).data.id;
  expect(personId).toBeTruthy();
  await expect(page.getByRole('heading', { name: 'Lista de personas' })).toBeVisible();
  const editor = await context.newPage();
  await editor.goto('/');
  await navigate(editor, 'Lista');
  await editor.getByRole('button', { name: 'Editar Persona de campos', exact: true }).click();
  await expect(editor.getByLabel('Fecha de vinculación')).toHaveValue('2026-09-10');
  await navigate(page, 'Configuración');
  const select = panel.getByRole('group', { name: 'Campo 4', exact: true });
  await select.getByRole('textbox', { name: 'Opción 1', exact: true }).fill('Sector renombrado');
  await select.getByRole('textbox', { name: 'Opción 1 en inglés', exact: true }).fill('Renamed sector');
  await select.getByLabel('Opción 1 activa', { exact: true }).uncheck();
  await panel.getByRole('button', { name: 'Guardar campos adicionales' }).click();
  await expect(panel.getByRole('status').filter({ hasText: 'Campos adicionales guardados.' })).toBeVisible();
  const stale = editor.waitForResponse(r => new URL(r.url()).pathname === `/api/v1/persons/${personId}` && r.request().method() === 'PATCH');
  await editor.getByRole('button', { name: 'Guardar cambios', exact: true }).click();
  expect((await stale).status()).toBe(409);
  await expect(editor.locator('.error[role="alert"]')).toBeVisible();
  await editor.getByRole('button', { name: 'Recargar configuración de campos' }).click();
  await expect(editor.getByRole('option', { name: 'Sector original (inactiva)' })).toHaveCount(1);
  const updated = editor.waitForResponse(r => new URL(r.url()).pathname === `/api/v1/persons/${personId}` && r.request().method() === 'PATCH');
  await editor.getByRole('button', { name: 'Guardar cambios', exact: true }).click();
  expect((await updated).status()).toBe(200);
  await editor.close();
  await navigate(page, 'Registro');
  await expect(page.getByRole('combobox', { name: 'Sector comunitario' })).toBeVisible();
  await expect(page.getByRole('option', { name: /Sector original|Sector renombrado/ })).toHaveCount(0);
  const invalid = await mutation(page, 'POST', '/api/v1/persons', { document_type: 'CC', document_number: 'INVALID-' + Date.now(), first_names: 'No debe crearse', status: 'pending', authorization_basis: 'Prueba', authorization_purpose: 'Validación', schema_version: 2, custom_values: { [schema.fields[3].id]: schema.fields[3].options[0].id } });
  expect(invalid.status()).toBe(422);
  await page.setViewportSize({ width: 360, height: 800 });
  const additional = page.getByRole('region', { name: 'Campos adicionales del registro' });
  await additional.evaluate(el => window.scrollTo(0, scrollY + el.getBoundingClientRect().top - 90));
  await page.screenshot({ path: path.join(root, '.local/person-fields-form-mobile.png'), animations: 'disabled' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 720 });
  const viewerContext = await browser.newContext();
  try {
    const viewer = await viewerContext.newPage();
    // Use a distinct read-only account: quick-links tests exercise the consultant.
    await login(viewer, 'auditor');
    expect((await mutation(viewer, 'PUT', '/api/v1/person-fields', { version: 2, fields: schema.fields })).status()).toBe(403);
    const detail = (await (await viewer.request.get(`/api/v1/persons/${personId}`)).json()).data;
    expect(detail.note).toBeUndefined();
    expect(detail.custom_fields[schema.fields[3].id].display).toBe('Sector original');
    await navigate(viewer, 'Lista');
    await viewer.getByRole('button', { name: 'Ver Persona de campos', exact: true }).click();
    await expect(viewer.getByRole('dialog')).toContainText('Sector original');
    await expect(viewer.getByRole('dialog')).not.toContainText('Nota interna de prueba');
    await viewer.getByRole('dialog').getByText('Sector original', { exact: true }).scrollIntoViewIfNeeded();
    await viewer.screenshot({ path: path.join(root, '.local/person-fields-detail.png'), animations: 'disabled' });
  } finally { await viewerContext.close(); }
  await navigate(page, 'Lista');
  await page.getByRole('button', { name: 'Eliminar Persona de campos', exact: true }).click();
  await page.getByRole('button', { name: 'Sí, eliminar', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Ver Persona de campos', exact: true })).toHaveCount(0);
  expect((await page.request.get(`/api/v1/persons/${personId}`)).status()).toBe(404);
  expect(errors).toEqual([]);
});
