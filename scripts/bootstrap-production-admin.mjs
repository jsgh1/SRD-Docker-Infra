// Creates the one-time demo superadministrator without putting its password in argv or logs.
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const email = process.argv[2];
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  process.stderr.write('Usage: node scripts/bootstrap-production-admin.mjs <email>\n');
  process.exit(2);
}

const password = randomBytes(24).toString('base64url');
const secretDir = path.resolve('.local/production');
const secretFile = path.join(secretDir, 'initial-admin-credentials.txt');
mkdirSync(secretDir, { recursive: true });
writeFileSync(secretFile, `SRD production initial administrator\nOrganization: srd-piloto\nEmail: ${email}\nPassword: ${password}\n`, { mode: 0o600, flag: 'wx' });

const command = [
  '-i', path.resolve('.local/deploy-ssh/srd_deploy_ed25519'),
  '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
  'srdadmin@144.91.126.25',
  'sudo -n docker exec -i srd-production-identity-1 php artisan srd:bootstrap srd-piloto',
];
const result = spawnSync('ssh', command, {
  input: `${email}\nAdministrador SRD\n${password}\n${password}\n`,
  encoding: 'utf8',
  timeout: 60000,
});
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
if (result.error) process.stderr.write(`${result.error.message}\n`);
if (result.status !== 0) {
  process.stderr.write(`Bootstrap failed; saved credentials remain at ${secretFile} for recovery.\n`);
  process.exit(result.status ?? 1);
}
process.stdout.write(`Credentials saved at ${secretFile}\n`);
