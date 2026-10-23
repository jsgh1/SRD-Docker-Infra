import fs from "node:fs";
import crypto from "node:crypto";
if (fs.existsSync('.env')) {
  if (fs.lstatSync('.env').isSymbolicLink()) throw new Error('No se admite .env simbólico.');
  const current = fs.readFileSync('.env', 'utf8');
  const additions = [];
  for (const [key, value] of Object.entries({ APP_KEY_FILES: 'base64:' + crypto.randomBytes(32).toString('base64'), DB_PASSWORD_FILES: crypto.randomBytes(32).toString('hex'), APP_KEY_CALENDAR: 'base64:' + crypto.randomBytes(32).toString('base64'), DB_PASSWORD_CALENDAR: crypto.randomBytes(32).toString('hex'), APP_KEY_NOTIFICATIONS: 'base64:' + crypto.randomBytes(32).toString('base64'), DB_PASSWORD_NOTIFICATIONS: crypto.randomBytes(32).toString('hex'), APP_KEY_TREASURY: 'base64:' + crypto.randomBytes(32).toString('base64'), DB_PASSWORD_TREASURY: crypto.randomBytes(32).toString('hex'), APP_KEY_INVENTORY: 'base64:' + crypto.randomBytes(32).toString('base64'), DB_PASSWORD_INVENTORY: crypto.randomBytes(32).toString('hex'), APP_KEY_CHAT: 'base64:' + crypto.randomBytes(32).toString('base64'), DB_PASSWORD_CHAT: crypto.randomBytes(32).toString('hex'), REVERB_APP_SECRET: crypto.randomBytes(32).toString('hex') })) {
    if (!new RegExp('^' + key + '=', 'm').test(current)) additions.push(key + '=' + value);
  }
  if (additions.length) fs.appendFileSync('.env', (current.endsWith('\n') ? '' : '\n') + additions.join('\n') + '\n');
  console.log('Configuración existente conservada; solo se añadieron claves faltantes de servicios SRD.');
  process.exit(0);
}
const hex = () => crypto.randomBytes(32).toString("hex");
const entries = {
  MYSQL_ROOT_PASSWORD: hex(),
  INTERNAL_KEY: hex(),
  CHALLENGE_KEY: hex(),
  REVERB_APP_SECRET: hex(),
};
for (const s of ["gateway", "identity", "configuration", "records", "audit", "files", "calendar", "notifications", "treasury", "inventory", "chat"]) {
  entries["APP_KEY_" + s.toUpperCase()] =
    "base64:" + crypto.randomBytes(32).toString("base64");
  entries["DB_PASSWORD_" + s.toUpperCase()] = hex();
}
fs.writeFileSync(
  ".env",
  Object.entries(entries)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n") + "\n",
  { flag: "wx" },
);
console.log(
  "Secretos de desarrollo generados localmente en .env. No compartir este archivo.",
);
