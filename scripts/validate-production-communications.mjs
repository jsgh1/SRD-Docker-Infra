// Public HTTPS checks with two fictional accounts; keep credentials in .local only.
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const accountPath = path.join(root, '.local/production/qa-accounts.json');
const accounts = JSON.parse(readFileSync(accountPath, 'utf8'));
if (!accounts.admin?.cookies?.length || !accounts.viewer?.cookies?.length) throw new Error('Active fictional admin/viewer sessions missing');
const progress = accounts.communications ??= {};
const save = () => writeFileSync(accountPath, JSON.stringify(accounts, null, 2));
const origin = 'https://srd-jsgh1.duckdns.org/api/v1/';

function client(role) {
  const jar = new Map(accounts[role].cookies.map(({ name, value }) => [name, value]));
  return async function call(route, { method = 'GET', body, expected = 200 } = {}) {
    const csrf = method === 'GET' ? null : (await call('csrf')).data.token;
    const response = await fetch(origin + route, {
      method,
      headers: {
        Accept: 'application/json',
        Cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; '),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(csrf ? { 'X-CSRF-TOKEN': csrf } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const separator = pair.indexOf('=');
      if (separator > 0) jar.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    const result = await response.json();
    if (response.status !== expected) throw new Error(`${role} ${route} ${method}: HTTP ${response.status}, expected ${expected}`);
    return result;
  };
}
const admin = client('admin');
const viewer = client('viewer');
const viewerId = (await viewer('me')).data.user_id;
if (!progress.conversationId) {
  progress.conversationId = (await admin('conversations', { method: 'POST', body: { user_id: viewerId } })).data.id;
  save();
}
const conversation = progress.conversationId;
if ((await viewer(`conversations/${conversation}`)).data.id !== conversation) throw new Error('Recipient cannot see the conversation');
if (!progress.messageId) {
  progress.clientId ??= randomUUID();
  progress.messageText ??= `Mensaje ficticio de validación SRD ${progress.clientId.slice(0, 8)}`;
  save();
  const message = (await admin(`conversations/${conversation}/messages`, { method: 'POST', body: {
    client_id: progress.clientId, body: progress.messageText,
  } })).data;
  progress.messageId = message.id;
  save();
}
const received = (await viewer(`conversations/${conversation}/messages`)).data.items.find(item => item.id === progress.messageId);
if (!received || received.body !== progress.messageText) throw new Error('Sent message missing from recipient history');
process.stdout.write('CHAT_SEND_AND_PERSISTENCE_OK\n');

let notification;
for (let attempt = 0; attempt < 30; attempt++) {
  const list = (await viewer('notifications')).data.items;
  notification = list.find(item => item.message_id === progress.messageId && item.kind === 'chat_message');
  if (notification) break;
  await new Promise(resolve => setTimeout(resolve, 3000));
}
if (!notification) throw new Error('Recipient chat notification did not arrive within 90 seconds');
if (notification.sender_name !== 'SRD QA admin') throw new Error('Notification sender name mismatch');
await viewer(`notifications/${notification.id}/read`, { method: 'POST', body: {} });
if (!(await viewer('notifications')).data.items.find(item => item.id === notification.id)?.read_at) throw new Error('Notification was not marked read');
await viewer(`notifications/${notification.id}`, { method: 'DELETE', body: {} });
if ((await viewer('notifications')).data.items.some(item => item.id === notification.id)) throw new Error('Notification was not dismissed');
process.stdout.write('CHAT_NOTIFICATION_READ_DISMISS_OK\n');

await viewer(`conversations/${conversation}/receipts`, { method: 'POST', body: { kind: 'read', message_ids: [progress.messageId] } });
const senderView = (await admin(`conversations/${conversation}/messages`)).data.items.find(item => item.id === progress.messageId);
if (!senderView?.read_at) throw new Error('Read receipt missing for sender');
process.stdout.write('CHAT_READ_RECEIPT_OK\n');

for (const route of ['assets/export', 'treasury/export']) {
  const report = (await admin(route)).data;
  if (!report.filename?.endsWith('.xlsx') || report.count < 1 || Buffer.from(report.content ?? '', 'base64').subarray(0, 2).toString() !== 'PK') {
    throw new Error(`${route} did not generate a populated XLSX`);
  }
}
process.stdout.write('INVENTORY_AND_TREASURY_EXPORTS_OK\n');
