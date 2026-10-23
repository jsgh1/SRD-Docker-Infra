// Creates and verifies fictional records in the public srd-piloto council.
import { chromium, expect } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const credentials = readFileSync(path.join(root, '.local/production/initial-admin-credentials.txt'), 'utf8');
const email = credentials.match(/^Email: (.+)$/m)?.[1];
const password = credentials.match(/^Password: (.+)$/m)?.[1];
if (!email || !password) throw new Error('Initial administrator credentials missing');
const statePath = path.join(root, '.local/production/demo-fixture.json');
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
const save = () => { mkdirSync(path.dirname(statePath), { recursive: true }); writeFileSync(statePath, JSON.stringify(state, null, 2)); };

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
try {
  await page.goto('https://srd-jsgh1.duckdns.org/j/srd-piloto/login');
  await page.getByLabel('Correo electrónico', { exact: true }).fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'términos y condiciones', exact: true }).click();
  await page.getByRole('button', { name: 'Aceptar términos', exact: true }).click();
  const requestTime = Date.now() / 1000;
  const loginResult = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/auth/login' && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Ingresar', exact: true }).click();
  const loginResponse = await loginResult;
  if (loginResponse.status() !== 200) throw new Error(`Login challenge HTTP ${loginResponse.status()}; respect the MFA cooldown before retrying`);
  await page.getByLabel('Código de verificación').waitFor();
  const mail = spawnSync('ssh', [
    '-i', path.join(root, '.local/deploy-ssh/srd_deploy_ed25519'),
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    'srdadmin@144.91.126.25',
    `sudo -n python3 /opt/srd/scripts/read-production-mfa-imap.py ${Math.floor(requestTime)}`,
  ], { encoding: 'utf8', timeout: 70000 });
  if (mail.status !== 0 || !/^\d{6}$/.test(mail.stdout.trim())) {
    throw new Error(`Fresh MFA email unavailable (${mail.stderr?.trim() || mail.error?.message || mail.status})`);
  }
  await page.getByLabel('Código de verificación').fill(mail.stdout.trim());
  await page.getByRole('button', { name: 'Confirmar código' }).click();
  await expect(page.locator('.profile-trigger')).toBeVisible();

  async function api(route, method = 'GET', body) {
    const result = await page.evaluate(async ({ route, method, body }) => {
      let token = '';
      if (method !== 'GET') {
        const csrf = await fetch('/api/v1/csrf', { credentials: 'same-origin' });
        if (!csrf.ok) return { status: csrf.status, json: null };
        token = (await csrf.json()).data.token;
      }
      const response = await fetch('/api/v1/' + route, {
        method, credentials: 'same-origin',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(token ? { 'X-CSRF-TOKEN': token } : {}) },
        ...(method !== 'GET' ? { body: JSON.stringify(body ?? {}) } : {}),
      });
      return { status: response.status, json: await response.json() };
    }, { route, method, body });
    if (result.status !== 200) throw new Error(`${route} ${method} HTTP ${result.status}: ${result.json?.error?.message ?? ''}`);
    return result.json.data;
  }

  if (!state.personId) {
    await page.locator('#main-sidebar nav').getByRole('button', { name: 'Registro', exact: true }).click();
    await page.getByRole('combobox', { name: /Tipo de documento/ }).selectOption('CC');
    await page.getByLabel('Número de documento').fill('SRD-DEMO-VPS-20261021');
    await page.getByLabel('Nombres', { exact: false }).fill('Persona Ficticia SRD');
    await page.getByLabel('Fundamento o referencia del soporte').fill('Demostración con datos enteramente ficticios');
    await page.getByLabel('Finalidad de la captura').fill('Validar el despliegue de SRD');
    await page.getByLabel('Información reservada').fill('Registro sintético; no corresponde a una persona real.');
    const created = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/persons' && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Guardar registro', exact: true }).click();
    const response = await created;
    if (response.status() !== 200) throw new Error(`Person form HTTP ${response.status()}`);
    state.personId = (await response.json()).data.id;
    save();
    await expect(page.getByRole('heading', { name: 'Lista de personas' })).toBeVisible();
    process.stdout.write('PERSON_FORM_CREATE_OK\n');
  }
  const person = await api(`persons/${state.personId}`);
  if (person.id !== state.personId) throw new Error('Person read-back mismatch');

  const day = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  if (!state.calendarId) {
    const event = await api('calendar-events', 'POST', {
      type: 'meeting', title: 'Reunión ficticia de demostración', title_en: 'Fictional demo meeting',
      description: 'Actividad sintética para comprobar el despliegue.',
      description_en: 'Synthetic activity to check the deployment.',
      starts_at: `${day}T10:00:00-05:00`, ends_at: `${day}T11:00:00-05:00`,
      participants: [], remind_24h: false, remind_1h: false,
    });
    state.calendarId = event.id;
    save();
  }
  if ((await api(`calendar-events/${state.calendarId}`)).id !== state.calendarId) throw new Error('Calendar read-back mismatch');
  process.stdout.write('CALENDAR_CREATE_READ_OK\n');

  if (!state.assetId) {
    const existing = await api('assets?q=SRD-DEMO-VPS-01');
    const found = existing.items?.find(item => item.code === 'SRD-DEMO-VPS-01');
    const asset = found ?? await api('assets', 'POST', {
      code: 'SRD-DEMO-VPS-01', type: 'movable', name: 'Proyector ficticio de demostración',
      name_en: 'Fictional demo projector', category: 'Equipo de prueba', category_en: 'Test equipment',
      unit: 'unidad', unit_en: 'unit', description: 'Bien ficticio para comprobar inventario.',
      location: 'Sala de demostración', location_en: 'Demo room', condition: 'Bueno', condition_en: 'Good',
      quantity: 2, idempotency_key: randomUUID(),
    });
    state.assetId = asset.id;
    save();
  }
  if ((await api(`assets/${state.assetId}`)).asset?.id !== state.assetId) throw new Error('Inventory read-back mismatch');
  process.stdout.write('INVENTORY_CREATE_READ_OK\n');

  const treasury = await api('treasury');
  if (!treasury.opened) {
    await api('treasury/opening', 'POST', {
      amount: '100000.00', effective_date: new Date().toISOString().slice(0, 10),
      concept: 'Saldo inicial ficticio para demostración', support_note: 'Sin dinero real',
      idempotency_key: randomUUID(),
    });
    state.treasuryOpened = true;
    save();
  }
  const treasuryAfter = await api('treasury');
  if (!treasuryAfter.opened || treasuryAfter.balance !== '100000.00') throw new Error('Treasury opening read-back mismatch');
  process.stdout.write('TREASURY_OPENING_READ_OK\n');

  if (!state.folderId) {
    const folderId = randomUUID();
    await api('folders', 'POST', { id: folderId, parent_id: null, name: 'Documentos ficticios', name_en: 'Fictional documents' });
    state.folderId = folderId;
    save();
  }
  if (!state.documentId) {
    const bytes = readFileSync(path.join(root, '.local/office-fixture.docx'));
    const documentId = randomUUID();
    await api('folder-documents', 'POST', {
      id: documentId, folder_id: state.folderId, name: 'Documento-ficticio-SRD.docx', content: bytes.toString('base64'),
    });
    state.documentId = documentId;
    save();
  }
  const download = await api(`folder-documents/${state.documentId}/download`);
  const expected = createHash('sha256').update(readFileSync(path.join(root, '.local/office-fixture.docx'))).digest('hex');
  const actual = createHash('sha256').update(Buffer.from(download.content, 'base64')).digest('hex');
  if (expected !== actual) throw new Error('Private document download checksum mismatch');
  process.stdout.write('FOLDER_CLAMAV_UPLOAD_DOWNLOAD_OK\n');

  const audit = await api('audit-events');
  if (!audit) throw new Error('Audit endpoint failed after writes');
  process.stdout.write('AUDIT_AFTER_WRITES_OK\n');
} finally {
  await context.close();
  await browser.close();
}
process.stdout.write('PRODUCTION_DEMO_WRITE_SMOKE_OK\n');
