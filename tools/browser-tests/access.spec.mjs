import { test, expect } from "@playwright/test";
test.use({ channel: 'chrome' });
import fs from "node:fs";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "../..");
const fixture = JSON.parse(
  fs.readFileSync(process.env.SRD_BROWSER_FIXTURE || path.join(root, ".local/e2e-fixture.json")),
);
async function codeFromMail(request, email) {
  let message;
  await expect
    .poll(
      async () => {
        const r = await request.get((process.env.SRD_MAILPIT_URL || "http://127.0.0.1:8125") + "/api/v1/messages");
        const j = await r.json();
        message = j.messages?.find((m) =>
          m.To.some((x) => x.Address === email),
        );
        return !!message;
      },
      { timeout: 20000 },
    )
    .toBe(true);
  const r = await request.get(
    (process.env.SRD_MAILPIT_URL || "http://127.0.0.1:8125") + "/api/v1/message/" + message.ID,
  );
  const j = await r.json();
  return j.Text.match(/\b\d{6}\b/)[0];
}
test("SMTP login, real person CRUD, isolation, persistent theme and logout", async ({
  page,
  request,
  context,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`/j/${fixture.codeA || 'srd-e2e-a'}/login`);
  await expect(
    page.getByRole("heading", { name: "Iniciar sesión" }),
  ).toBeVisible();
  await page.screenshot({
    path: path.join(root, ".local/login-desktop.png"),
    fullPage: true,
  });
  await page
    .getByLabel("Correo electrónico", { exact: true })
    .fill(fixture.users.admin.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Mostrar contraseña" }).click();
  await expect(page.getByLabel("Contraseña", { exact: true })).toHaveAttribute(
    "type",
    "text",
  );
  await expect(
    page.getByRole("button", { name: "Ingresar", exact: true }),
  ).toBeDisabled();
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
  const pending = await context.request.get("/api/v1/dashboard");
  expect(pending.status()).toBe(401);
  const code = await codeFromMail(request, fixture.users.admin.email);
  await page.getByLabel("Código de verificación").fill(code);
  await page.getByRole("button", { name: "Confirmar código" }).click();
  await expect(
    page.getByRole("heading", { name: /Hola, Administrador|Hello, Administrator/ }),
  ).toBeVisible();
  await expect(
    page.getByText(/^(Personas registradas|Registered people)$/),
  ).toBeVisible();
  await page.screenshot({
    path: path.join(root, ".local/dashboard-desktop.png"),
    fullPage: true,
  });
  const me = await context.request.get("/api/v1/me");
  expect((await me.json()).data.organization.id).toBe(fixture.orgA);
  const csrf = (await (await context.request.get("/api/v1/csrf")).json()).data
    .token;
  const forged = await context.request.post("/api/v1/auth/switchOrganization", {
    headers: { "X-CSRF-TOKEN": csrf },
    data: {
      organization_code: fixture.codeB || "srd-e2e-b",
      terms_version_id: fixture.termsB,
      accepted: true,
    },
  });
  expect(forged.status()).toBe(403);
  const badCsrf = await context.request.post("/api/v1/auth/logout", {
    data: {},
  });
  expect(badCsrf.status()).toBe(419);
  await page
    .getByRole("button", { name: /^(Nuevo registro|New record)$/ })
    .click();
  await page.getByLabel(/Tipo de documento|Document type/).selectOption("CC");
  await page.getByLabel(/Número de documento|Document number/).fill("000" + Date.now());
  await page.getByLabel(/Nombres|Given names/).fill("Persona sintética");
  await page
    .getByLabel(/Fundamento o referencia del soporte|Authorization basis or supporting reference/)
    .fill("Prueba automatizada");
  await page
    .getByLabel(/Finalidad de la captura|Purpose of collection/)
    .fill("Verificar registro y eliminación");
  await page
    .getByLabel(/Información reservada|Restricted to administration and registration/)
    .fill("Nota ficticia de validación");
  await page
    .getByRole("button", { name: /^(Guardar registro|Save record)$/ })
    .click();
  await expect(
    page.getByRole("heading", { name: /^(Lista de personas|People)$/ }),
  ).toBeVisible();
  await expect(
    page.locator('.person-desktop-table').getByText("Persona sintética", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: /^(Ver|View) Persona sintética$/ })
    .click();
  await expect(page.getByText("Nota ficticia de validación")).toBeVisible();
  await page.getByRole("button", { name: /^(Cerrar|Close)$/ }).click();
  await page
    .getByRole("button", { name: /^(Eliminar|Delete) Persona sintética$/ })
    .click();
  await page.getByRole("button", { name: /^(Cancelar|Cancel)$/ }).click();
  await expect(
    page.locator('.person-desktop-table').getByText("Persona sintética", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: /^(Eliminar|Delete) Persona sintética$/ })
    .click();
  await page.getByRole("button", { name: /^(Sí, eliminar|Yes, delete)$/ }).click();
  await expect(
    page.locator('.person-desktop-table').getByText("Persona sintética", { exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: /Prueba Admin/ }).click();
  if ((await page.locator("html").getAttribute("data-theme")) === "dark") {
    await page.getByRole("button", { name: /Cambiar a tema claro|Switch to light theme/ }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  }
  await page.getByRole("button", { name: /Cambiar a tema oscuro|Switch to dark theme/ }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const tab = await context.newPage();
  await tab.goto("/");
  await expect(tab.locator("html")).toHaveAttribute("data-theme", "dark");
  await tab.close();
  await page.setViewportSize({ width: 360, height: 800 });
  await page.getByRole("button", { name: /Abrir menú|Open menu/ }).click();
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await page.screenshot({
    path: path.join(root, ".local/dashboard-mobile-dark.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: /Prueba Admin/ }).click();
  await page
    .getByRole("button", { name: /^(Cerrar sesión|Sign out)$/ })
    .click();
  await expect(
    page.getByRole("heading", { name: /Iniciar sesión|Encuentra tu junta|Sign in|Find your council/ }),
  ).toBeVisible();
  expect((await context.request.get("/api/v1/persons")).status()).toBe(401);
  expect(errors).toEqual([]);
});
test("mobile login layout and reduced motion", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`/j/${fixture.codeA || 'srd-e2e-a'}/login`);
  await expect(
    page.getByRole("heading", { name: "Iniciar sesión" }),
  ).toBeVisible();
  const motion = await page.getByRole('button', { name: 'Ingresar', exact: true }).evaluate(button => ({
    transition: getComputedStyle(button).transitionDuration,
    animation: getComputedStyle(button).animationName,
  }));
  expect(motion).toEqual({ transition: '0s', animation: 'none' });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: path.join(root, ".local/login-mobile.png"),
    fullPage: true,
  });
});
