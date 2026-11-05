import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.join(root, '.local', 'production');
const output = path.join(outputDir, '.env.production');
fs.mkdirSync(outputDir, { recursive: true });

const key = () => `base64:${crypto.randomBytes(32).toString('base64')}`;
const secret = () => crypto.randomBytes(32).toString('hex');
const input = fs.readFileSync(path.join(root, '.env.production.example'), 'utf8');
const values = input.split(/\r?\n/).map((line) => {
  if (!line || line.startsWith('#')) return line;
  const separator = line.indexOf('=');
  if (separator < 0) return line;
  const name = line.slice(0, separator);
  if (name.startsWith('APP_KEY_')) return `${name}=${key()}`;
  if (name.startsWith('DB_PASSWORD_') || ['MYSQL_ROOT_PASSWORD', 'INTERNAL_KEY', 'CHALLENGE_KEY', 'REVERB_APP_SECRET'].includes(name)) return `${name}=${secret()}`;
  if (name === 'REVERB_APP_ID') return `${name}=srd-${crypto.randomBytes(8).toString('hex')}`;
  if (name === 'REVERB_APP_KEY') return `${name}=${crypto.randomBytes(20).toString('hex')}`;
  return line;
}).join('\n');

fs.writeFileSync(output, values, { flag: 'wx', mode: 0o600 });
console.log(`Secretos exclusivos de produccion creados en ${output}. Completa SMTP antes de desplegar.`);
