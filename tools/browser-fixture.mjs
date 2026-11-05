import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
const root = path.resolve(import.meta.dirname, '..');
const run = randomUUID();
const directory = path.join(root, '.local/browser-fixtures');
fs.mkdirSync(directory, { recursive: true });
const fixture = {
  password: randomBytes(24).toString('hex'),
  orgA: randomUUID(), orgB: randomUUID(), termsA: randomUUID(), termsB: randomUUID(),
  codeA: `e2e-${run.slice(0, 18)}-a`, codeB: `e2e-${run.slice(0, 18)}-b`,
  users: Object.fromEntries(['admin', 'registrar', 'treasurer', 'auditor', 'viewer', 'superadmin'].map(role => [role, { id: randomUUID(), email: `${role}-${run}@srd-e2e.test` }])),
};
if (process.env.SRD_BROWSER_SPEC === 'chat-conversations-pagination.spec.mjs') {
  fixture.extra_chat_users = Array.from({ length: 26 }, (_, index) => ({
    id: randomUUID(), email: `chat-${index + 1}-${run}@srd-e2e.test`,
    name: `Prueba Chat ${String(index + 1).padStart(2, '0')}`,
  }));
}
if (process.env.SRD_BROWSER_SPEC === 'audit-retry.spec.mjs') fixture.retry_event_id = randomUUID();
if (process.env.SRD_BROWSER_SPEC === 'calendar-delivery-retry.spec.mjs') {
  fixture.calendar_retry_event_id = randomUUID();
  fixture.calendar_retry_job_id = randomUUID();
}
if (process.env.SRD_BROWSER_SPEC === 'mail-delivery-retry.spec.mjs') {
  fixture.mail_retry_invitation_id = randomUUID();
  fixture.mail_retry_notice_id = randomUUID();
  fixture.mail_retry_invitation_email = `invitation-retry-${run}@srd-e2e.test`;
  fixture.mail_retry_notice_email = `notice-retry-${run}@srd-e2e.test`;
}
const file = path.join(directory, `${run}.json`);
fs.writeFileSync(file, JSON.stringify(fixture, null, 2) + '\n', { flag: 'wx' });
console.log(file);
