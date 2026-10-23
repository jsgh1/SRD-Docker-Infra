import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

test.use({ channel: 'chrome' });
const root = path.resolve(import.meta.dirname, '../..');
const fixture = process.env.SRD_BROWSER_FIXTURE
  ? JSON.parse(readFileSync(process.env.SRD_BROWSER_FIXTURE, 'utf8')) : null;
const marker = randomUUID().replaceAll('-', '').slice(0, 8);
const prefix = `PDFL-${marker}-`;

function docker(...args) {
  return execFileSync('docker', ['compose', ...args], { cwd: root, encoding: 'utf8', timeout: 90000 });
}

test('real web queues and downloads a 501-person PDF with MFA', async ({ page, request }) => {
  test.skip(!fixture || !/:(8080|8443)$/.test(process.env.SRD_TEST_URL ?? ''), 'Requires Compose and an isolated fixture');
  test.setTimeout(240000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let copied = false;
  let jobId;
  try {
    docker('cp', 'tools/person-export-browser-fixture.php', 'records:/app/services/records/person-export-browser-fixture.php');
    copied = true;
    docker('exec', '-T', 'records', 'php', 'person-export-browser-fixture.php',
      'seed', fixture.orgA, fixture.users.admin.id, marker);

    const mailpit = process.env.SRD_MAILPIT_URL || 'http://127.0.0.1:8025';
    const before = await (await request.get(`${mailpit}/api/v1/messages`)).json();
    const known = new Set(before.messages?.map(message => message.ID) ?? []);
    await page.setViewportSize({ width: 360, height: 780 });
    await page.goto(`/j/${fixture.codeA || 'srd-e2e-a'}/login`);
    await page.getByLabel(/^(Correo electrónico|Email address)$/).fill(fixture.users.admin.email);
    await page.getByLabel(/^(Contraseña|Password)$/).fill(fixture.password);
    await page.getByRole('button', { name: /^(términos y condiciones|terms and conditions)$/i }).click();
    await page.getByRole('button', { name: /^(Aceptar términos|Accept terms)$/ }).click();
    await page.getByRole('button', { name: /^(Ingresar|Sign in)$/ }).click();
    await expect(page.getByRole('heading', { name: /^(Ingresa tu código|Enter your code)$/ })).toBeVisible();
    let mailId;
    await expect.poll(async () => {
      const messages = await (await request.get(`${mailpit}/api/v1/messages`)).json();
      mailId = messages.messages?.find(message => !known.has(message.ID)
        && message.To.some(recipient => recipient.Address === fixture.users.admin.email))?.ID;
      return Boolean(mailId);
    }, { timeout: 30000 }).toBe(true);
    const mail = await (await request.get(`${mailpit}/api/v1/message/${mailId}`)).json();
    const code = mail.Text.match(/\b\d{6}\b/)?.[0];
    expect(code).toBeTruthy();
    await page.getByLabel(/^(Código de verificación|Verification code)$/).fill(code);
    await page.getByRole('button', { name: /^(Confirmar código|Confirm code)$/ }).click();
    await expect(page.locator('.profile-trigger')).toBeVisible();

    await page.getByRole('button', { name: /^(Abrir menú|Open menu)$/ }).click();
    await page.locator('.sidebar').getByRole('button', { name: /^(Exportar|Export)$/ }).click();
    await page.getByRole('button', { name: /^(Abrir exportación de personas|Open people exports)$/ }).click();
    const filters = page.getByRole('form', { name: /^(Filtros de personas|People filters)$/ });
    await filters.getByLabel(/^(Buscar|Search)$/).fill(prefix);
    const listing = page.waitForResponse(response => response.url().includes('/api/v1/persons?page=')
      && response.url().includes(encodeURIComponent(prefix)) && response.ok());
    await filters.getByRole('button', { name: /^(Aplicar filtros|Apply filters)$/ }).click();
    const listed = await listing;
    expect((await listed.json()).data.total).toBe(501);
    const queuedResponse = page.waitForResponse(response => response.url().includes('/api/v1/persons/export-jobs?')
      && response.request().method() === 'POST');
    await page.getByRole('button', { name: /^(Exportar PDF|Export PDF)$/ }).click();
    const queued = await queuedResponse;
    expect(queued.ok(), `Queue response: ${queued.status()}`).toBe(true);
    const job = (await queued.json()).data;
    jobId = job.id;
    expect(job.format).toBe('pdf');
    expect(job.count).toBe(501);

    await expect.poll(async () => {
      const status = await page.request.get(`/api/v1/persons/export-jobs/${jobId}`);
      expect(status.ok()).toBe(true);
      return (await status.json()).data.status;
    }, { timeout: 150000, intervals: [2000, 5000, 5000] }).toBe('ready');
    const refresh = page.getByRole('button', { name: /^(Actualizar estado|Refresh status)$/ });
    if (await refresh.isVisible()) await refresh.click();
    await expect(page.getByRole('button', { name: /^(Descargar PDF preparado|Download prepared PDF file)$/ })).toBeVisible();
    const download = page.waitForEvent('download', { timeout: 90000 });
    await page.getByRole('button', { name: /^(Descargar PDF preparado|Download prepared PDF file)$/ }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^personas_\d{4}-\d{2}-\d{2}\.pdf$/);
    const bytes = readFileSync(await file.path());
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(bytes.length).toBeGreaterThan(1000);
    const pdf = await getDocument({ data: new Uint8Array(bytes), useSystemFonts: true }).promise;
    try {
      expect(pdf.numPages).toBeGreaterThan(1);
      const pages = [];
      for (let index = 1; index <= pdf.numPages; index++) {
        const page = await pdf.getPage(index);
        pages.push((await page.getTextContent()).items.map(item => 'str' in item ? item.str : '').join(' '));
      }
      const text = pages.join(' ').replace(/\s+/g, ' ');
      const document = number => new RegExp(`PDFL-\\s*${marker}-\\s*${number}`);
      expect(text.includes('Listado de personas') || text.includes('People list')).toBe(true);
      expect(document('0001').test(text)).toBe(true);
      expect(document('0501').test(text)).toBe(true);
      expect(text.match(new RegExp(`PDFL-\\s*${marker}-`, 'g'))).toHaveLength(501);
    } finally {
      await pdf.destroy();
    }
    expect(errors).toEqual([]);
  } finally {
    if (copied) {
      docker('exec', '-T', 'records', 'php', 'person-export-browser-fixture.php',
        'cleanup', fixture.orgA, fixture.users.admin.id, marker, ...(jobId ? [jobId] : []));
      docker('cp', 'tools/cleanup-person-export-notification-mysql.php',
        'notifications:/app/services/notifications/cleanup-person-export-notification-mysql.php');
      docker('exec', '-T', '-e', `SRD_SMOKE_ORG=${fixture.orgA}`, 'notifications',
        'php', 'cleanup-person-export-notification-mysql.php');
    }
  }
});
