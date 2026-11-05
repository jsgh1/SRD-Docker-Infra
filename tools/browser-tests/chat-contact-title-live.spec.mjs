import { test, expect } from '@playwright/test';
import fs from 'node:fs';

test.use({ channel: 'chrome' });
const fixture = JSON.parse(fs.readFileSync(new URL('../../.local/e2e-fixture.json', import.meta.url)));
const mailUrl = process.env.SRD_MAILPIT_URL || 'http://127.0.0.1:8025';

async function login(page, role) {
  const email = fixture.users[role].email;
  const before = await (await page.request.get(`${mailUrl}/api/v1/messages`)).json();
  const seen = new Set((before.messages || []).map(message => message.ID));
  await page.goto(`/j/${fixture.codeA || 'srd-e2e-a'}/login`);
  await page.getByLabel(/Correo electrónico|Email address/).fill(email);
  await page.getByLabel(/Contraseña|Password/).fill(fixture.password);
  await page.getByRole('button', { name: /términos y condiciones|terms and conditions/i }).click();
  await page.getByRole('button', { name: /Aceptar términos|Accept terms/i }).click();
  const loginResponse = page.waitForResponse(response => response.url().includes('/api/v1/auth/login')
    && response.request().method() === 'POST');
  await page.getByRole('button', { name: /^(Ingresar|Sign in)$/i }).click();
  expect((await loginResponse).status()).toBe(200);
  let message;
  await expect.poll(async () => {
    const list = await (await page.request.get(`${mailUrl}/api/v1/messages`)).json();
    message = list.messages?.find(item => !seen.has(item.ID) && item.To.some(to => to.Address === email));
    return Boolean(message);
  }, { timeout: 60000 }).toBe(true);
  const content = await (await page.request.get(`${mailUrl}/api/v1/message/${message.ID}`)).json();
  await page.getByLabel(/Código de verificación|Verification code/).fill(content.Text.match(/\b\d{6}\b/)[0]);
  await page.getByRole('button', { name: /Confirmar código|Confirm code/ }).click();
  await expect(page.locator('.sidebar').getByRole('button', { name: 'Chat', exact: true })).toBeVisible();
}

async function csrf(page) {
  return (await (await page.request.get('/api/v1/csrf')).json()).data.token;
}

test('real contact title is scoped to the council and shown in an existing chat', async ({ browser, page }) => {
  test.setTimeout(180000);
  const viewerContext = await browser.newContext();
  const viewer = await viewerContext.newPage();
  let original;
  try {
    await login(viewer, 'viewer');
    const principal = (await (await viewer.request.get('/api/v1/me')).json()).data;
    original = principal.user;
    const changed = await viewer.request.patch('/api/v1/profile', { headers: { 'X-CSRF-TOKEN': await csrf(viewer) },
      data: { name: original.name, theme: original.theme, presence: original.presence, language: original.language,
        title: 'Cargo de prueba', title_en: 'Test position' } });
    expect(changed.status()).toBe(200);
    await login(page, 'admin');
    await page.setViewportSize({ width: 360, height: 800 });
    const viewerId = fixture.users.viewer.id;
    const detail = await page.request.get(`/api/v1/contacts/${viewerId}`);
    expect(detail.status()).toBe(200);
    expect((await detail.json()).data.title_en).toBe('Test position');
    const conversations = (await (await page.request.get('/api/v1/conversations')).json()).data;
    if (!conversations.items.some(item => item.contact.id === viewerId)) {
      const started = await page.request.post('/api/v1/conversations', { headers: { 'X-CSRF-TOKEN': await csrf(page) },
        data: { user_id: viewerId } });
      expect(started.status()).toBe(200);
    }
    await page.getByRole('button', { name: /Open menu|Abrir menú/ }).click();
    await page.locator('.sidebar').getByRole('button', { name: 'Chat', exact: true }).click();
    const list = page.getByRole('region', { name: /Conversaciones|Conversations/ });
    await list.getByRole('button', { name: original.name }).click();
    const panel = page.getByRole('region', { name: /Mensajes|Messages/ });
    await expect(panel.getByLabel(/Cargo del contacto|Contact title/)).toHaveText(/Cargo de prueba|Test position/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally {
    if (original) {
      const restored = await viewer.request.patch('/api/v1/profile', { headers: { 'X-CSRF-TOKEN': await csrf(viewer) },
        data: { name: original.name, theme: original.theme, presence: original.presence, language: original.language,
          title: original.title ?? '', title_en: original.title_en ?? '' } });
      expect(restored.status()).toBe(200);
    }
    await viewerContext.close();
  }
});
