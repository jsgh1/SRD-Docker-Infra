import fs from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..");
const file = path.join(root, ".local/e2e-fixture.json");
fs.mkdirSync(path.dirname(file), { recursive: true });
if (!fs.existsSync(file)) {
  const fixture = {
    password: randomBytes(18).toString("hex"),
    orgA: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    orgB: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    termsA: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
    termsB: "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb",
    users: Object.fromEntries(
      [
        "admin",
        "registrar",
        "treasurer",
        "auditor",
        "viewer",
        "superadmin",
      ].map((role) => [
        role,
        { id: randomUUID(), email: `${role}@srd-e2e.test` },
      ]),
    ),
  };
  fs.writeFileSync(file, JSON.stringify(fixture, null, 2) + "\n", {
    flag: "wx",
  });
}
console.log(
  "Credenciales sintéticas conservadas en .local/e2e-fixture.json; no se imprimen.",
);
