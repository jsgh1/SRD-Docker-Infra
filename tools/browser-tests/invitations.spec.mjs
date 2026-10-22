import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "../..");
const fixture = JSON.parse(
  fs.readFileSync(process.env.SRD_BROWSER_FIXTURE || path.join(root, ".local/e2e-fixture.json")),
);
const mailUrl = process.env.SRD_MAILPIT_URL || "http://127.0.0.1:8125";
async function mail(request, email, subject) {
  let message;
  await expect
    .poll(
      async () => {
        const result = await (
          await request.get(`${mailUrl}/api/v1/messages`)
        ).json();
        message = result.messages?.find(
          (m) =>
            m.Subject === subject && m.To.some((to) => to.Address === email),
        );
        return !!message;
      },
      { timeout: 85000, intervals: [1000, 2000] },
    )
    .toBe(true);
  return (await request.get(`${mailUrl}/api/v1/message/${message.ID}`)).json();
}
async function login(page, request, email, password) {
  await page.getByLabel("Correo electrónico", { exact: true }).fill(email);
  await page.getByLabel("Contraseña", { exact: true }).fill(password);
  await page
    .getByRole("button", { name: "términos y condiciones", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Aceptar términos", exact: true })
    .click();
  await page.getByRole("button", { name: "Ingresar", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Ingresa tu código" }),
  ).toBeVisible();
  const message = await mail(request, email, "Tu código de seguridad de SRD");
  await page
    .getByLabel("Código de verificación")
    .fill(message.Text.match(/\b\d{6}\b/)[0]);
  await page.getByRole("button", { name: "Confirmar código" }).click();
  await expect(
    page.getByRole("button", { name: "Home", exact: true }),
  ).toBeVisible();
}

test("private invitation, new account verification and tenant membership deactivation", async ({
  page,
  request,
  browser,
}) => {
  test.skip(
    !process.env.SRD_TEST_URL?.includes(":8080"),
    "Esta prueba requiere el planificador de Compose.",
  );
  test.setTimeout(240000);
  const email = `invitada-${Date.now()}@srd-e2e.test`;
  const name = `Invitada sintética ${Date.now()}`;
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`/j/${fixture.codeA || 'srd-e2e-a'}/login`);
  await login(page, request, fixture.users.superadmin.email, fixture.password);
  await page
    .getByRole("button", { name: "Configuración", exact: true })
    .click();
  await page.getByLabel("Correo de la persona invitada").fill(email);
  await page.getByLabel("Rol de la invitación").selectOption("viewer");
  await page.getByRole("button", { name: "Crear invitación privada" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Invitación creada y puesta en cola de envío." })).toBeVisible();
  const message = await mail(request, email, "Invitación privada a SRD");
  const link = message.HTML.match(/href="([^"]+\/invite#[^"]+)"/)[1].replaceAll(
    "&amp;",
    "&",
  );
  const origin = new URL(link).origin;
  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  guest.on("pageerror", (error) => errors.push(error.message));
  try {
    await guest.goto(link);
    await expect(guest.getByLabel("Nombre de la cuenta")).toBeVisible();
    expect(new URL(guest.url()).hash).toBe("");
    await guest.getByLabel("Nombre de la cuenta").fill(name);
    await guest
      .getByLabel("Crea tu contraseña", { exact: true })
      .fill(fixture.password);
    await guest
      .getByLabel("Repite la contraseña", { exact: true })
      .fill(fixture.password);
    await guest
      .getByRole("button", { name: "Leer términos de la invitación" })
      .click();
    await guest.getByRole("button", { name: "Aceptar estos términos" }).click();
    await guest
      .getByRole("button", { name: "Aceptar invitación privada" })
      .click();
    await expect(guest.getByRole("status").filter({ hasText: "Invitación aceptada" })).toBeVisible();
    expect(
      (await guestContext.request.get(`${origin}/api/v1/me`)).status(),
    ).toBe(401);
    await guest
      .getByRole("button", { name: "Continuar al inicio de sesión" })
      .click();
    await login(guest, request, email, fixture.password);
    await expect(
      guest.getByRole("heading", { name: "Hola, Consultor" }),
    ).toBeVisible();
    expect((await guestContext.request.get(`${origin}/api/v1/audit-delivery/identity`)).status()).toBe(403);
    await page.getByRole("button", { name: "Actualizar miembros" }).click();
    await page
      .getByRole("button", { name: `Editar membresía de ${name}`, exact: true })
      .click();
    await page.getByLabel("Membresía activa").uncheck();
    const changed = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname.startsWith('/api/v1/members/'));
    await page
      .getByRole("button", { name: "Confirmar cambios de membresía" })
      .click();
    const membershipId = new URL((await changed).url()).pathname.split('/').at(-1);
    await expect(page.getByRole("status").filter({ hasText: "Membresía actualizada" })).toBeVisible();
    expect(
      (await guestContext.request.get(`${origin}/api/v1/persons`)).status(),
    ).toBe(401);
    await page.screenshot({
      path: path.join(root, ".local/memberships-desktop.png"),
      fullPage: true,
    });
    await expect.poll(async () => {
      const response = await page.request.get('/api/v1/audit-events?action=membership.updated');
      const body = await response.json();
      return body.data?.items.some(event => event.resource_id === membershipId && event.actor_id === fixture.users.superadmin.id);
    }, { timeout: 85000, intervals: [1000, 3000, 5000] }).toBe(true);
    await page.locator('.sidebar').getByRole('button', { name: 'Auditoría', exact: true }).click();
    const audit = page.getByRole('region', { name: 'Consulta de auditoría' });
    await audit.getByLabel('Actor (identificador)').fill(fixture.users.superadmin.id);
    await audit.getByRole('combobox', { name: 'Módulo', exact: true }).selectOption('identity');
    await audit.getByLabel('Acción', { exact: true }).fill('membership.updated');
    await audit.getByRole('combobox', { name: 'Resultado', exact: true }).selectOption('success');
    await audit.getByRole('combobox', { name: 'Eventos por página' }).selectOption('10');
    const filtered = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/audit-events' && new URL(response.url()).searchParams.get('action') === 'membership.updated');
    await audit.getByRole('button', { name: 'Aplicar filtros' }).click();
    const filteredBody = await (await filtered).json();
    expect(filteredBody.data.total).toBe(1);
    expect(filteredBody.data.page).toBe(1);
    expect(filteredBody.data.page_size).toBe(10);
    await expect(audit.getByRole('status')).toHaveText('1 eventos encontrados');
    const eventDay = filteredBody.data.items[0].occurred_at.slice(0, 10);
    await audit.getByLabel('Desde (UTC)').fill(eventDay);
    await audit.getByLabel('Hasta (UTC)').fill(eventDay);
    const dated = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/audit-events' && new URL(response.url()).searchParams.get('date_from') === eventDay);
    await audit.getByRole('button', { name: 'Aplicar filtros' }).click();
    expect((await (await dated).json()).data.total).toBe(1);
    await expect(audit.getByRole('status')).toHaveText('1 eventos encontrados');
    await audit.getByLabel('Nombre del archivo (opcional)').fill('Auditoría/Junta?.xlsx');
    await expect(audit.getByRole('button', { name: 'Exportar Excel' })).toBeDisabled();
    await audit.getByLabel('Confirmo el nombre del archivo').check();
    const downloadPromise = page.waitForEvent('download');
    await audit.getByRole('button', { name: 'Exportar Excel' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('Auditoria-Junta.xlsx');
    const exported = path.join(root, '.local/audit-export-browser.xlsx');
    await download.saveAs(exported);
    const workbook = fs.readFileSync(exported);
    expect(workbook.subarray(0, 2).toString()).toBe('PK');
    expect(workbook.includes(Buffer.from(membershipId))).toBe(true);
    expect(workbook.includes(Buffer.from('membership.updated'))).toBe(true);
    expect((await guestContext.request.get(`${origin}/api/v1/audit-events/export`)).status()).toBe(401);
    await audit.getByRole('button', { name: /^Ver evento / }).click();
    const detail = page.getByRole('dialog');
    await expect(detail).toContainText(membershipId);
    await expect(detail).toContainText(fixture.users.superadmin.id);
    await detail.getByRole('button', { name: 'Cerrar', exact: true }).click();
    await audit.evaluate(el => window.scrollTo(0, scrollY + el.getBoundingClientRect().top - 90));
    await page.screenshot({ path: path.join(root, '.local/audit-filters-desktop.png'), animations: 'disabled' });
    await audit.getByLabel('Acción', { exact: true }).fill('nonexistent.action');
    await audit.getByRole('button', { name: 'Aplicar filtros' }).click();
    await expect(audit.getByRole('heading', { name: 'No hay eventos para esta consulta' })).toBeVisible();
    await audit.getByLabel('Actor (identificador)').fill('invalid');
    await audit.getByRole('button', { name: 'Aplicar filtros' }).click();
    await expect(audit.getByRole('alert')).toBeVisible();
    await expect(audit.getByRole('table')).toHaveCount(0);
    await audit.getByRole('button', { name: 'Limpiar filtros' }).click();
    await expect(audit.getByLabel('Acción', { exact: true })).toHaveValue('');
    await expect(audit.getByRole('button', { name: /^Ver evento / }).first()).toBeVisible();
    await expect(audit.getByRole('alert')).toHaveCount(0);
    const delivery = page.getByRole('region', { name: 'Estado de entrega de auditoría' });
    await expect(delivery.getByRole('heading', { name: 'Archivos' })).toBeVisible();
    expect(await delivery.locator('dl').count()).toBeGreaterThanOrEqual(8);
    await expect(audit.getByRole('combobox', { name: 'Módulo', exact: true }).locator('option[value="files"]')).toHaveText('Archivos');
    await expect(delivery.getByRole('alert')).toHaveCount(0);
    await delivery.evaluate(el => window.scrollTo(0, scrollY + el.getBoundingClientRect().top - 90));
    await page.screenshot({ path: path.join(root, '.local/audit-delivery-desktop.png'), animations: 'disabled' });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 360, height: 800 });
    await audit.evaluate(el => window.scrollTo(0, scrollY + el.getBoundingClientRect().top - 90));
    await page.screenshot({ path: path.join(root, '.local/audit-filters-mobile.png'), animations: 'disabled' });
    await delivery.evaluate(el => window.scrollTo(0, scrollY + el.getBoundingClientRect().top - 90));
    await page.screenshot({ path: path.join(root, '.local/audit-delivery-mobile.png'), animations: 'disabled' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await guestContext.close();
  }
});
