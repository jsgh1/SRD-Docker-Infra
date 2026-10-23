import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
const root = process.cwd();
fs.mkdirSync(".local", { recursive: true });
const keyFile = ".local/development-keys.json";
const keys = fs.existsSync(keyFile)
  ? JSON.parse(fs.readFileSync(keyFile))
  : {
      internal: crypto.randomBytes(32).toString("hex"),
      challenge: crypto.randomBytes(32).toString("hex"),
    };
if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, JSON.stringify(keys));
for (const [index, service] of [
  "gateway",
  "identity",
  "configuration",
  "records",
  "audit",
].entries()) {
  const envPath = `services/${service}/.env`;
  if (fs.existsSync(envPath)) {
    console.log(`${service}: .env existente conservado`);
    continue;
  }
  const db = path
    .join(root, ".local", `${service}.sqlite`)
    .replaceAll("\\", "/");
  if (!fs.existsSync(db)) fs.writeFileSync(db, "");
  let content = fs
    .readFileSync(`services/${service}/.env.example`, "utf8")
    .replace(
      "APP_KEY=",
      "APP_KEY=base64:" + crypto.randomBytes(32).toString("base64"),
    )
    .replace("DB_CONNECTION=mysql", "DB_CONNECTION=sqlite")
    .replace(`DB_DATABASE=srd_${service}`, `DB_DATABASE="${db}"`)
    .replace("INTERNAL_KEY=", "INTERNAL_KEY=" + keys.internal)
    .replace("CHALLENGE_KEY=", "CHALLENGE_KEY=" + keys.challenge)
    .replace("MAIL_HOST=mailpit", "MAIL_HOST=127.0.0.1")
    .replace("MAIL_PORT=1025", "MAIL_PORT=1125")
    .replaceAll("http://localhost:8080", "http://127.0.0.1:5173");
  content +=
    "\nIDENTITY_URL=http://127.0.0.1:8101\nCONFIGURATION_URL=http://127.0.0.1:8102\nRECORDS_URL=http://127.0.0.1:8103\nAUDIT_URL=http://127.0.0.1:8104\n";
  fs.writeFileSync(envPath, content);
  console.log(`${service}: entorno local de pruebas creado`);
}
