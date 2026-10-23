// One-time local setup through SRD's public UI/API. Keeps existing juntas intact.
import { chromium, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const fixture = JSON.parse(readFileSync(path.join(root, '.local/e2e-fixture.json'), 'utf8'));
const baseURL = process.env.SRD_TEST_URL || 'http://127.0.0.1:8080';
const mailpit = process.env.SRD_MAILPIT_URL || 'http://127.0.0.1:8025';
const name = process.argv[2];
const code = process.argv[3];
const superadminOnly = process.argv.includes('--superadmin-only');
if (!name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(code || '')) {
  throw new Error('Uso: node prepare-clean-junta.mjs "Nombre" codigo-de-junta [--superadmin-only]');
}
const terms = 'Entorno local de prueba de SRD. Usa únicamente información ficticia durante las pruebas. La junta debe publicar sus términos definitivos antes de tratar datos reales.';
const termsEn = 'Local SRD test environment. Use only fictional information during testing. The council must publish final terms before handling real personal data.';

const browser = await chromium.launch({ channel: 'chrome' });
const context = await browser.newContext({ baseURL });
const page = await context.newPage();
async function inbox() {
  const response = await context.request.get(`${mailpit}/api/v1/messages`);
  if (!response.ok()) throw new Error(`Mailpit HTTP ${response.status()}`);
  return (await response.json()).messages ?? [];
}
async function waitForMail(email, previous) {
  let message;
  await expect.poll(async () => {
    message = (await inbox()).find(item => !previous.has(item.ID)
      && item.To.some(to => to.Address === email));
    return Boolean(message);
  }, { timeout: 85000 }).toBe(true);
  return (await (await context.request.get(`${mailpit}/api/v1/message/${message.ID}`)).json());
}
async function login(target, email, organizationCode) {
  const previous = new Set((await inbox()).map(item => item.ID));
  await target.goto(`/j/${organizationCode}/login`);
  await target.getByLabel(/^(Correo electrónico|Email address)$/).fill(email);
  await target.getByLabel(/^(Contraseña|Password)$/).fill(fixture.password);
  await target.getByRole('button', { name: /^(términos y condiciones|terms and conditions)$/i }).click();
  await target.getByRole('button', { name: /^(Aceptar términos|Accept terms)$/ }).click();
  await target.getByRole('button', { name: /^(Ingresar|Sign in)$/ }).click();
  const mail = await waitForMail(email, previous);
  const mfa = mail.Text.match(/\b\d{6}\b/)?.[0];
  if (!mfa) throw new Error('El correo MFA no contiene un código de seis dígitos.');
  await target.getByLabel(/^(Código de verificación|Verification code)$/).fill(mfa);
  await target.getByRole('button', { name: /^(Confirmar código|Confirm code)$/ }).click();
  await expect(target.locator('.profile-trigger')).toBeVisible();
}
async function post(target, endpoint, body) {
  const result = await target.evaluate(async ({ endpoint, body }) => {
    const csrf = (await (await fetch('/api/v1/csrf', { credentials: 'same-origin' })).json()).data.token;
    const response = await fetch(`/api/v1/${endpoint}`, {
      method: 'POST', credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-TOKEN': csrf },
      body: JSON.stringify(body),
    });
    return { status: response.status, json: await response.json() };
  }, { endpoint, body });
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`${endpoint}: HTTP ${result.status} ${JSON.stringify(result.json.error ?? {})}`);
  }
  return result.json.data;
}
try {
  await login(page, fixture.users.superadmin.email, fixture.codeA || 'srd-e2e-a');
  const org = await post(page, 'platform/organizations', { name, code, terms, terms_en: termsEn });
  if (!superadminOnly) {
    const previous = new Set((await inbox()).map(item => item.ID));
    await post(page, `platform/organizations/${org.id}/administrators`, { email: fixture.users.admin.email });
    const invitation = await waitForMail(fixture.users.admin.email, previous);
    const link = invitation.HTML.match(/href="([^"]+\/invite#[^"]+)"/)?.[1]?.replaceAll('&amp;', '&');
    if (!link) throw new Error('El correo de invitación no contiene el enlace esperado.');
    const invited = await browser.newContext({ baseURL });
    try {
      const guest = await invited.newPage();
      await guest.goto(link);
      await guest.getByLabel(/^(Contraseña actual de tu cuenta|Current account password)$/).fill(fixture.password);
      await guest.getByLabel(/^(Repite la contraseña|Repeat password)$/).fill(fixture.password);
      await guest.getByRole('button', { name: /^(Leer términos de la invitación|Read invitation terms)$/ }).click();
      await guest.getByRole('button', { name: /^(Aceptar estos términos|Accept these terms)$/ }).click();
      await guest.getByRole('button', { name: /^(Aceptar invitación privada|Accept private invitation)$/ }).click();
      await expect(guest.getByRole('status')).toContainText(/(Invitación aceptada|Invitation accepted)/);
      await login(guest, fixture.users.admin.email, code);
      const me = await (await invited.request.get(`${baseURL}/api/v1/me`)).json();
      if (me.data.role !== 'admin' || me.data.organization.code !== code) {
        throw new Error('La cuenta no quedó como administradora de la junta nueva.');
      }
    } finally { await invited.close(); }
  } else {
    const fresh = await browser.newContext({ baseURL });
    try {
      await login(await fresh.newPage(), fixture.users.superadmin.email, code);
    } finally { await fresh.close(); }
  }
  process.stdout.write(`Junta creada: ${name} | ${code} | ${org.id} | acceso inicial ${superadminOnly ? fixture.users.superadmin.email : fixture.users.admin.email}\n`);
} finally {
  await context.close();
  await browser.close();
}
