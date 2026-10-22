import { test, expect } from '@playwright/test';
import fs from 'node:fs';

const fixture = JSON.parse(fs.readFileSync(process.env.SRD_BROWSER_FIXTURE || new URL('../../.local/e2e-fixture.json', import.meta.url)));
const mailUrl = process.env.SRD_MAILPIT_URL || 'http://127.0.0.1:8125';

test('calendar saves and displays both authored languages', async ({ page }) => {
  await page.goto(`/j/${fixture.codeA}/login`);
  await page.getByLabel('Correo electrónico', { exact: true }).fill(fixture.users.admin.email);
  await page.getByLabel('Contraseña', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: 'términos y condiciones' }).click();
  await page.getByRole('button', { name: 'Aceptar términos' }).click();
  const loginStarted = Date.now();
  await page.getByRole('button', { name: 'Ingresar', exact: true }).click();
  let message;
  await expect.poll(async () => {
    const list = await (await page.request.get(`${mailUrl}/api/v1/messages`)).json();
    message = list.messages?.filter(item => item.Subject === 'Tu código de seguridad de SRD' && item.To.some(to => to.Address === fixture.users.admin.email) && Date.parse(item.Created) >= loginStarted - 5000)
      .sort((a, b) => Date.parse(b.Created) - Date.parse(a.Created))[0];
    return Boolean(message);
  }, { timeout: 85000 }).toBe(true);
  const content = await (await page.request.get(`${mailUrl}/api/v1/message/${message.ID}`)).json();
  await page.getByLabel('Código de verificación').fill(content.Text.match(/\b\d{6}\b/)[0]);
  await page.getByRole('button', { name: 'Confirmar código' }).click();
  await expect(page.locator('.sidebar').getByRole('button', { name: 'Home', exact: true })).toBeVisible();

  const suffix = Date.now();
  const title = `Reunión bilingüe ${suffix}`;
  const titleEn = `Bilingual meeting ${suffix}`;
  await page.locator('.sidebar').getByRole('button', { name: 'Calendario' }).click();
  await page.getByRole('button', { name: 'Crear evento' }).click();
  const form = page.getByRole('dialog', { name: 'Crear evento' });
  await form.getByLabel('Título', { exact: true }).fill(title);
  expect(await form.getByLabel('Título (EN)').evaluate(input => input.validity.valueMissing)).toBe(true);
  await form.getByLabel('Título (EN)').fill(titleEn);
  await form.getByLabel('Lugar', { exact: true }).fill('Salón de juntas');
  await form.getByLabel('Lugar (EN)').fill('Council hall');
  await form.getByLabel('Descripción', { exact: true }).fill('Texto creado por la junta');
  await form.getByLabel('Descripción (EN)').fill('Council-authored text');
  const start = await form.getByLabel('Inicio').inputValue();
  const date = new Date(`${start.slice(0, 10)}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  const day = date.toISOString().slice(0, 10);
  await form.getByLabel('Inicio').fill(`${day}T09:00`);
  await form.getByLabel('Final').fill(`${day}T10:00`);
  await form.getByRole('button', { name: 'Guardar evento' }).click();
  const detail = page.getByRole('dialog', { name: 'Detalle del evento' });
  await expect(detail).toContainText(title);
  await expect(detail).toContainText('Salón de juntas');
  await expect(detail).toContainText('Texto creado por la junta');
  await detail.getByRole('button', { name: 'Cerrar' }).click();

  await page.locator('.profile-trigger').click();
  await page.getByLabel('Idioma', { exact: true }).selectOption('en');
  await expect(page.getByRole('heading', { name: 'Calendar', exact: true })).toBeVisible();
  await page.locator('.profile-trigger').click();
  await page.getByRole('button', { name: 'Agenda', exact: true }).click({ timeout: 10000 });
  await expect(page.locator('.calendar-agenda').getByRole('button', { name: new RegExp(titleEn) })).toBeVisible();
  await page.locator('.calendar-agenda').getByRole('button', { name: new RegExp(titleEn) }).click();
  const englishDetail = page.getByRole('dialog', { name: 'Event details' });
  await expect(englishDetail).toContainText('Council hall');
  await expect(englishDetail).toContainText('Council-authored text');
  await expect(englishDetail).not.toContainText('Salón de juntas');
  await englishDetail.getByRole('button', { name: 'Close' }).click();
  await page.reload();
  await page.locator('.sidebar').getByRole('button', { name: 'Calendar' }).click();
  await expect(page.getByRole('heading', { name: 'Calendar', exact: true })).toBeVisible();
});
