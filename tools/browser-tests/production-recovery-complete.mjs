// Complete public recovery flow for the fictional viewer; verify old session revocation.
import { chromium, expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const accountsPath = path.join(root, '.local/production/qa-accounts.json');
const accounts = JSON.parse(readFileSync(accountsPath, 'utf8'));
const viewer = accounts.viewer;
if (!viewer?.accepted || !viewer.cookies?.length) throw new Error('Active fictional viewer session missing');
const origin = 'https://srd-jsgh1.duckdns.org';
function inbox(command) {
  const response = spawnSync('ssh', [
    '-i', path.join(root, '.local/deploy-ssh/srd_deploy_ed25519'),
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    'srdadmin@144.91.126.25', command,
  ], { encoding: 'utf8', timeout: 95000 });
  if (response.status !== 0) throw new Error(`SRD test inbox unavailable: ${response.stderr?.trim() || response.error?.message || response.status}`);
  return response.stdout.trim();
}
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const prior = await browser.newContext();
  await prior.addCookies(viewer.cookies);
  const previous = await prior.newPage();
  await previous.goto(`${origin}/j/srd-piloto`);
  await expect(previous.locator('.profile-trigger')).toBeVisible();
  const recovery = await browser.newContext();
  const page = await recovery.newPage();
  await page.goto(`${origin}/j/srd-piloto/login`);
  await page.getByRole('button', { name: 'Olvidé mi contraseña' }).click();
  await page.getByLabel('Correo electrónico', { exact: true }).fill(viewer.email);
  const requestTime = Math.floor(Date.now() / 1000);
  const request = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/auth/recover');
  await page.getByRole('button', { name: 'Enviar instrucciones' }).click();
  if ((await request).status() !== 200) throw new Error('Recovery request failed');
  const link = inbox(`sudo -n python3 /opt/srd/scripts/read-production-link-imap.py reset ${requestTime} ${viewer.email}`);
  if (!/^https:\/\/srd-jsgh1\.duckdns\.org\/reset#[0-9a-f-]{36}\.[a-f0-9]{64}$/.test(link)) throw new Error('Recovery link invalid');
  await page.goto(link);
  const nextPassword = randomBytes(24).toString('base64url');
  await page.getByLabel('Nueva contraseña').fill(nextPassword);
  await page.getByLabel('Repetir contraseña').fill(nextPassword);
  const changed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/auth/reset');
  await page.getByRole('button', { name: 'Guardar contraseña' }).click();
  if ((await changed).status() !== 200) throw new Error('Password reset failed');
  viewer.password = nextPassword;
  writeFileSync(accountsPath, JSON.stringify(accounts, null, 2));
  await expect(page.getByText('Contraseña actualizada. Inicia sesión con tu nueva contraseña.')).toBeVisible();
  const oldSession = await previous.request.get(`${origin}/api/v1/me`);
  if (oldSession.status() !== 401) throw new Error(`Old session survived reset: HTTP ${oldSession.status()}`);
  delete viewer.cookies;
  writeFileSync(accountsPath, JSON.stringify(accounts, null, 2));
  process.stdout.write('RECOVERY_BROWSER_AND_SESSION_REVOCATION_OK\n');

  await page.goto(`${origin}/j/srd-piloto/login`);
  await page.getByLabel('Correo electrónico', { exact: true }).fill(viewer.email);
  await page.getByLabel('Contraseña', { exact: true }).fill(nextPassword);
  await page.getByRole('button', { name: 'términos y condiciones', exact: true }).click();
  await page.getByRole('button', { name: 'Aceptar términos', exact: true }).click();
  const loginTime = Math.floor(Date.now() / 1000);
  const login = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/auth/login');
  await page.getByRole('button', { name: 'Ingresar', exact: true }).click();
  if ((await login).status() !== 200) throw new Error('New password login challenge failed');
  const code = inbox(`sudo -n python3 /opt/srd/scripts/read-production-mfa-imap.py ${loginTime} ${viewer.email}`);
  if (!/^\d{6}$/.test(code)) throw new Error('New login MFA code missing');
  await page.getByLabel('Código de verificación').fill(code);
  await page.getByRole('button', { name: 'Confirmar código' }).click();
  await expect(page.locator('.profile-trigger')).toBeVisible();
  const role = await page.evaluate(async () => (await (await fetch('/api/v1/me')).json()).data.role);
  if (role !== 'viewer') throw new Error(`Unexpected role after reset: ${role}`);
  viewer.recoveryValidated = true;
  writeFileSync(accountsPath, JSON.stringify(accounts, null, 2));
  process.stdout.write('RECOVERY_NEW_PASSWORD_MFA_LOGIN_OK\n');
  await prior.close();
  await recovery.close();
} finally {
  await browser.close();
}
