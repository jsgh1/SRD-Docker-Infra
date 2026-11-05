import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

test.use({ channel: 'chrome' });

const root = path.resolve(import.meta.dirname, '../..');
const fixture = JSON.parse(fs.readFileSync(process.env.SRD_BROWSER_FIXTURE || path.join(root, '.local/e2e-fixture.json')));

async function mailCode(request, email) {
  let id;
  await expect.poll(async () => {
    const response = await request.get((process.env.SRD_MAILPIT_URL || 'http://127.0.0.1:8125') + '/api/v1/messages');
    const data = await response.json();
    id = data.messages?.find(message => message.To.some(recipient => recipient.Address === email))?.ID;
    return Boolean(id);
  }, { timeout: 30000 }).toBe(true);
  const response = await request.get((process.env.SRD_MAILPIT_URL || 'http://127.0.0.1:8125') + '/api/v1/message/' + id);
  return (await response.json()).Text.match(/\b\d{6}\b/)[0];
}

async function noHorizontalOverflow(page) {
  const dimensions = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    return { width, scroll: document.documentElement.scrollWidth,
      offenders: [...document.querySelectorAll('body *')].map(element => ({
        tag: element.tagName.toLowerCase(), className: String(element.className || '').slice(0, 60),
        right: Math.round(element.getBoundingClientRect().right), text: element.textContent?.trim().slice(0, 35),
      })).filter(item => item.right > width + 1).slice(0, 8) };
  });
  expect(dimensions.scroll, `Horizontal overflow at ${dimensions.width}px: ${JSON.stringify(dimensions.offenders)}`).toBeLessThanOrEqual(dimensions.width + 1);
}

test('responsive access and persistent per-user English preference', async ({ page, request, context }) => {
  for (const width of [320, 375, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`/j/${fixture.codeA || 'srd-e2e-a'}/login`);
    await expect(page.getByRole('heading', { name: 'Iniciar sesión' })).toBeVisible();
    await noHorizontalOverflow(page);
    if (width === 320 || width === 1280) {
      await page.screenshot({ path: path.join(root, `.local/login-${width}-review.png`), fullPage: true });
    }
  }

  await page.getByLabel('Correo electrónico', { exact: true }).fill(fixture.users.admin.email);
  await page.getByLabel('Contraseña', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: 'términos y condiciones' }).click();
  await page.getByRole('button', { name: 'Aceptar términos' }).click();
  await page.getByRole('button', { name: 'Ingresar', exact: true }).click();
  await page.getByLabel('Código de verificación').fill(await mailCode(request, fixture.users.admin.email));
  await page.getByRole('button', { name: 'Confirmar código' }).click();
  await expect(page.getByRole('heading', { name: 'Hola, Administrador' })).toBeVisible();
  await page.locator('.profile-trigger').click();
  await page.getByLabel('Idioma', { exact: true }).selectOption('en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('button', { name: 'Edit profile' })).toBeVisible();
  const saved = await context.request.get('/api/v1/me');
  expect((await saved.json()).data.user.language).toBe('en');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('heading', { name: 'Hello, Administrator' })).toBeVisible();
  await expect(page.getByText('Registered people', { exact: true })).toBeVisible();
  await page.locator('.sidebar').getByRole('button', { name: 'List', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'People', exact: true })).toBeVisible();
  const peopleFilters = page.getByRole('form', { name: 'People filters' });
  await expect(peopleFilters.getByRole('button', { name: 'Apply filters' })).toBeVisible();
  await expect(peopleFilters.getByLabel('Search', { exact: true })).toBeVisible();
  await page.locator('.sidebar').getByRole('button', { name: 'Look up', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Look up a person' })).toBeVisible();
  await expect(page.getByRole('form', { name: 'People filters' }).getByLabel('Document number')).toBeVisible();
  await page.locator('.sidebar').getByRole('button', { name: 'Chat', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Council chat' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Conversations' }).getByText('No conversations')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Messages' }).getByText('Select a conversation')).toBeVisible();
  await page.setViewportSize({ width: 320, height: 800 });
  await noHorizontalOverflow(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole('button',{name:'Find a contact'}).click();
  await expect(page.getByRole('heading',{name:'Council contacts'})).toBeVisible();
  const viewerCard=page.locator('.contact-card').filter({hasText:'Prueba Viewer'});
  await viewerCard.getByRole('button',{name:'Open chat'}).click();
  const messagesPanel=page.getByRole('region',{name:'Messages'});
  await expect(messagesPanel.locator('.chat-contact-profile')).toContainText('Prueba Viewer');
  await messagesPanel.getByRole('textbox', { name: 'Message', exact: true }).fill('Texto propio de la junta');
  await messagesPanel.getByRole('button',{name:'Send',exact:true}).click();
  await expect(messagesPanel.getByText('Texto propio de la junta')).toBeVisible();
  await expect(messagesPanel.locator('.chat-messages li').filter({hasText:'Texto propio de la junta'})).toContainText('Sent');
  await page.locator('.sidebar').getByRole('button', { name: 'Treasury', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Treasury' })).toBeVisible();
  await expect(page.getByText('Current balance', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Treasury history' }).getByRole('heading', { name: 'Transactions', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export Excel' })).toBeVisible();
  const openingButton = page.getByRole('button', { name: 'Record opening balance' });
  if (await openingButton.isVisible()) {
    await openingButton.click();
    const dialog = page.getByRole('dialog', { name: 'Record opening balance' });
    await expect(dialog.getByLabel('Amount COP')).toBeVisible();
    await expect(dialog.getByLabel('Effective date')).toBeVisible();
    await expect(dialog.getByLabel('Concept')).toBeVisible();
    await dialog.getByRole('button', { name: 'Close' }).click();
  } else {
    await page.getByRole('button', { name: 'Record income or expense' }).click();
    const dialog = page.getByRole('dialog', { name: 'Record transaction' });
    await expect(dialog.getByLabel('Type')).toBeVisible();
    await expect(dialog.getByLabel('Amount COP')).toBeVisible();
    await dialog.getByRole('button', { name: 'Close' }).click();
  }
  await page.setViewportSize({ width: 320, height: 800 });
  await noHorizontalOverflow(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.locator('.sidebar').getByRole('button', { name: 'Inventory', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Inventory' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Inventory assets' }).getByRole('heading', { name: 'Assets' })).toBeVisible();
  await expect(page.getByLabel('Search by code or name')).toBeVisible();
  await page.getByRole('button', { name: 'Register asset' }).click();
  const assetDialog = page.getByRole('dialog', { name: 'Register asset' });
  await expect(assetDialog.getByLabel('Code')).toBeVisible();
  await expect(assetDialog.getByLabel('Category (ES)')).toBeVisible();
  await expect(assetDialog.getByLabel('Category (EN)')).toBeVisible();
  await expect(assetDialog.getByLabel('Initial quantity')).toBeVisible();
  await page.setViewportSize({ width: 320, height: 800 });
  await noHorizontalOverflow(page);
  await assetDialog.getByRole('button', { name: 'Close' }).click();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.locator('.sidebar').getByRole('button', { name: 'Home', exact: true }).click();
  for (const width of [320, 375, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(page.getByRole('heading', { name: 'Hello, Administrator' })).toBeVisible();
    await noHorizontalOverflow(page);
    if (width <= 650) {
      await expect.poll(() => page.locator('.sidebar').evaluate(element => element.getBoundingClientRect().right),
        { message: `Closed sidebar covers content at ${width}px` }).toBeLessThanOrEqual(0);
    }
    if (width === 320 || width === 1280) {
      await page.screenshot({ path: path.join(root, `.local/dashboard-${width}-review.png`), fullPage: true });
    }
  }
  await page.setViewportSize({ width: 320, height: 800 });
  await page.locator('.profile-trigger').click();
  await expect(page.getByLabel('Language', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Status', { exact: true })).toBeVisible();
  await expect(page.locator('.profile-menu .presence-status')).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({ path: path.join(root, '.local/profile-320-review.png'), fullPage: true });
  await page.locator('.profile-trigger').click();
  for (const label of ['Register', 'List', 'Look up', 'Contacts', 'Chat', 'Folders', 'Calendar', 'Treasury', 'Inventory', 'Settings', 'Audit', 'Downloads']) {
    await page.getByRole('button', { name: 'Open menu' }).click();
    await page.locator('.sidebar nav button').filter({ hasText: label }).click();
    await expect(page.locator('.sidebar')).not.toHaveClass(/open/);
    await page.waitForTimeout(450);
    await noHorizontalOverflow(page);
  }
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.locator('.sidebar nav button').filter({ hasText: 'Settings' }).click();
  const fields = page.getByRole('region', { name: 'Additional field settings' });
  await expect(fields).toHaveCount(1);
  await expect(fields.getByRole('heading', { name: 'Additional person fields' })).toBeVisible();
  await expect(fields.getByRole('button', { name: 'Add field' })).toBeVisible();
  const positions = page.getByRole('region', { name: 'Position catalog' });
  await expect(positions.getByRole('heading', { name: 'Person positions' })).toBeVisible();
  await expect(positions.getByRole('button', { name: 'Add position' })).toBeVisible();
  const services = page.getByRole('region', { name: 'Service status' });
  await expect(services.getByRole('heading', { name: 'Schedulers' })).toBeVisible();
  await expect(services.getByRole('heading', { name: 'Pending email' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Dashboard quick links' })).toBeVisible();
  await noHorizontalOverflow(page);
  await fields.screenshot({ path: path.join(root, '.local/fields-en-320-review.png') });
  await services.screenshot({ path: path.join(root, '.local/services-en-320-review.png') });
  const otherTab = await context.newPage();
  await otherTab.goto(`/j/${fixture.codeA}/login`);
  await expect(otherTab.locator('html')).toHaveAttribute('lang', 'en');
  await otherTab.close();
});
