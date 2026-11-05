// Real public-browser smoke test, limited to the fictional srd-piloto council.
import { chromium, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const credentials = readFileSync(path.join(root, '.local/production/initial-admin-credentials.txt'), 'utf8');
const email = credentials.match(/^Email: (.+)$/m)?.[1];
const password = credentials.match(/^Password: (.+)$/m)?.[1];
if (!email || !password) throw new Error('Initial administrator credentials missing');

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const failures = [];
try {
  await page.goto('https://srd-jsgh1.duckdns.org/j/srd-piloto/login');
  await page.getByLabel('Correo electrónico', { exact: true }).fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'términos y condiciones', exact: true }).click();
  await page.getByRole('button', { name: 'Aceptar términos', exact: true }).click();
  const requestTime = Date.now() / 1000;
  await page.getByRole('button', { name: 'Ingresar', exact: true }).click();
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
  const nav = page.locator('#main-sidebar nav');
  const sections = (await nav.locator('button').allTextContents()).map(value => value.trim()).filter(Boolean);
  if (sections.length < 10) throw new Error(`Expected navigation sections, found ${sections.length}`);

  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const section of sections) {
      try {
        if (width <= 650) await page.getByRole('button', { name: /^(Abrir menú|Open menu)$/ }).click();
        await nav.getByRole('button', { name: section, exact: true }).click();
        await expect(page.locator('.workspace .loading')).toHaveCount(0, { timeout: 20000 });
        await expect(page.locator('.workspace .error')).toHaveCount(0);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
        if (overflow) throw new Error('horizontal overflow');
        process.stdout.write(`SECTION_${width}_${section.replaceAll(/\s+/g, '_')}_OK\n`);
      } catch (error) {
        failures.push(`${width}px ${section}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  if (errors.length) failures.push(`JavaScript: ${errors.join('; ')}`);
} finally {
  await context.close();
  await browser.close();
}
if (failures.length) throw new Error(`Production sections failed:\n${failures.join('\n')}`);
process.stdout.write('PRODUCTION_BROWSER_ALL_SECTIONS_OK\n');
