import { test, expect } from '@playwright/test';
import fs from 'node:fs';

const fixture = JSON.parse(fs.readFileSync(process.env.SRD_BROWSER_FIXTURE));
const mailUrl = process.env.SRD_MAILPIT_URL || 'http://localhost:8025';

async function login(page) {
  const email = fixture.users.admin.email;
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
  await expect(page.getByRole('heading', { name: /Hola,/ })).toBeVisible();
}

test('formularios móviles conservan controles dentro del diálogo', async ({ page }, testInfo) => {
  test.setTimeout(180000);
  await login(page);
  const forms = [
    ['Carpeta', 'Nueva carpeta', 'Nueva carpeta', 'Guardar carpeta'],
    ['Inventario', 'Registrar bien', 'Registrar bien', 'Guardar bien'],
    ['Tesorería', 'Registrar apertura', 'Registrar apertura', 'Guardar y generar comprobante'],
    ['Calendario', 'Crear evento', 'Crear evento', 'Guardar evento'],
  ];
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 700 });
    for (const [section, open, title, save] of forms) {
      await page.getByRole('button', { name: 'Abrir menú' }).click();
      await page.locator('.sidebar').getByRole('button', { name: section, exact: true }).click();
      await expect(page.locator('.workspace .loading')).toHaveCount(0, { timeout: 20000 });
      await page.getByRole('button', { name: open, exact: true }).click();
      const dialog = page.getByRole('dialog', { name: title });
      await expect(dialog).toBeVisible();
      await dialog.screenshot({ path: testInfo.outputPath(`${section}-${width}.png`) });
      const geometry = await dialog.evaluate(node => {
        const rect = node.getBoundingClientRect();
        const controls = [...node.querySelectorAll('input, select, textarea, button')];
        return {
          viewport: innerWidth,
          document: document.documentElement.scrollWidth,
          dialog: { left: rect.left, right: rect.right, width: rect.width },
          client: node.clientWidth,
          scroll: node.scrollWidth,
          escaped: controls.filter(control => {
            const bounds = control.getBoundingClientRect();
            return bounds.left < rect.left - 2 || bounds.right > rect.right + 2;
          }).map(control => control.outerHTML.slice(0, 120)),
          badIconButtons: controls.filter(control => control.tagName === 'BUTTON' && !control.textContent?.trim())
            .filter(control => {
              const bounds = control.getBoundingClientRect();
              return !control.getAttribute('aria-label')?.trim() || bounds.width < 28 || bounds.height < 28;
            }).map(control => control.outerHTML.slice(0, 120)),
        };
      });
      expect(geometry.document, `${section} ${width}px ${JSON.stringify(geometry)}`).toBeLessThanOrEqual(width + 2);
      expect(geometry.dialog.width).toBeLessThan(width);
      expect(geometry.scroll, `${section} ${width}px ${JSON.stringify(geometry)}`).toBeLessThanOrEqual(geometry.client + 2);
      expect(geometry.escaped, `${section} ${width}px ${JSON.stringify(geometry)}`).toEqual([]);
      expect(geometry.badIconButtons, `${section} ${width}px: iconos sin nombre o menores de 28px`).toEqual([]);
      await dialog.getByRole('button', { name: save }).click();
      if (section === 'Carpeta') {
        expect(await dialog.getByLabel('Nombre de carpeta (ES)').evaluate(input => input.validity.valueMissing)).toBe(true);
      } else {
        expect(await dialog.locator('form').evaluate(form => form.checkValidity()), `${section}: formulario vacío`).toBe(false);
      }
      await dialog.getByRole('button', { name: 'Cerrar' }).click();
      if (section === 'Carpeta') {
        await expect(page.getByRole('heading', { name: 'No hay carpetas en esta ubicación' })).toBeVisible();
        await expect(page.locator('.folder-pages')).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Archivos anteriores' })).toHaveCount(0);
      }
    }
  }
});
