// Public HTTPS chat smoke: antivirus-backed attachment and WebSocket reconnection.
import { chromium, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const accountPath = path.join(root, '.local/production/qa-accounts.json');
const accounts = JSON.parse(readFileSync(accountPath, 'utf8'));
const origin = 'https://srd-jsgh1.duckdns.org';
const sshKey = path.join(root, '.local/deploy-ssh/srd_deploy_ed25519');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAUSURBVBhXY/jPAEZA3AAk/zP8BwBEUQh5fHTJZQAAAABJRU5ErkJggg==', 'base64');

function inbox(command) {
  const result = spawnSync('ssh', ['-i', sshKey, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    'srdadmin@144.91.126.25', command], { encoding: 'utf8', timeout: 95000 });
  if (result.status !== 0) throw new Error(`Dedicated test inbox unavailable: ${result.stderr?.trim() || result.status}`);
  return result.stdout.trim();
}

async function login(role) {
  const account = accounts[role];
  if (!account?.email || !account?.password) throw new Error(`Missing fictional ${role} account`);
  if (account.cookies?.length) {
    const session = await fetch(`${origin}/api/v1/me`, {
      headers: { Accept: 'application/json', Cookie: account.cookies.map(({ name, value }) => `${name}=${value}`).join('; ') },
    });
    if (session.ok && (await session.json()).data.role === role) return { cookies: account.cookies };
  }
  const jar = new Map();
  const call = async (route, { method = 'GET', body } = {}) => {
    const csrf = method === 'GET' ? null : (await call('csrf')).data.token;
    const response = await fetch(`${origin}/api/v1/${route}`, {
      method,
      headers: { Accept: 'application/json', Cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; '),
        ...(body ? { 'Content-Type': 'application/json' } : {}), ...(csrf ? { 'X-CSRF-TOKEN': csrf } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0];
      jar.set(pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1));
    }
    const result = await response.json();
    if (!response.ok) throw new Error(`${role} ${route} HTTP ${response.status}`);
    return result;
  };
  const organization = (await call('organizations/srd-piloto')).data;
  const issuedAt = Math.floor(Date.now() / 1000);
  const challenge = (await call('auth/login', { method: 'POST', body: {
    email: account.email, password: account.password, organization_code: 'srd-piloto',
    accepted: true, terms_version_id: organization.terms.id,
  } })).data;
  const code = inbox(`sudo -n python3 /opt/srd/scripts/read-production-mfa-imap.py ${issuedAt} ${account.email}`);
  if (!/^\d{6}$/.test(code)) throw new Error(`${role} MFA mail invalid`);
  await call('auth/verify', { method: 'POST', body: { challenge_id: challenge.challenge_id, code } });
  if ((await call('me')).data.role !== role) throw new Error(`${role} role mismatch`);
  account.cookies = [...jar].map(([name, value]) => ({ name, value, domain: 'srd-jsgh1.duckdns.org', path: '/', secure: true }));
  writeFileSync(accountPath, JSON.stringify(accounts, null, 2));
  return { cookies: account.cookies };
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
let admin;
let viewer;
const contexts = [];
try {
  admin = await login('admin');
  viewer = await login('viewer');
  process.stdout.write('CHAT_QA_MFA_SESSIONS_OK\n');
  async function pageFor(session, width, trackSockets = false) {
    const context = await browser.newContext({ viewport: { width, height: 840 }, acceptDownloads: true });
    contexts.push(context);
    await context.addCookies(session.cookies);
    if (trackSockets) await context.addInitScript(() => {
      window.__srdQaSockets = [];
      const NativeWebSocket = window.WebSocket;
      window.WebSocket = class extends NativeWebSocket {
        constructor(...args) {
          super(...args);
          window.__srdQaSockets.push(this);
        }
      };
    });
    const page = await context.newPage();
    await page.goto(`${origin}/j/srd-piloto`);
    await expect(page.locator('.profile-trigger')).toBeVisible();
    return { context, page };
  }
  const sender = await pageFor(admin, 1280);
  const receiver = await pageFor(viewer, 1280, true);
  const frames = [];
  const authStatuses = [];
  const pageErrors = [];
  receiver.page.on('response', response => {
    if (new URL(response.url()).pathname === '/api/v1/chat/broadcast-auth') authStatuses.push(response.status());
  });
  receiver.page.on('pageerror', error => pageErrors.push(error.message));
  receiver.page.on('websocket', socket => {
    if (socket.url().includes('/app/')) socket.on('framereceived', frame => frames.push(frame.payload));
  });
  const socketOpening = receiver.page.waitForEvent('websocket', { predicate: socket => socket.url().includes('/app/'), timeout: 30000 });
  await receiver.page.locator('.sidebar').getByRole('button', { name: 'Chat', exact: true }).click();
  const firstSocket = await socketOpening;
  if (!firstSocket.url().startsWith('wss://')) throw new Error('Public chat did not use WSS');
  try {
    await expect.poll(() => frames.some(frame => frame.includes('subscription_succeeded')), { timeout: 30000,
      message: 'Receiver must subscribe to its WSS channel' }).toBe(true);
  } catch (error) {
    const events = frames.map(frame => { try {
      const parsed = JSON.parse(frame);
      const data = typeof parsed.data === 'string' ? JSON.parse(parsed.data) : parsed.data;
      return { event: parsed.event, code: data?.code ?? null };
    } catch { return { event: 'unparseable' }; } });
    throw new Error(`WSS subscription failed; events=${JSON.stringify(events)}; authStatuses=${JSON.stringify(authStatuses)}; pageErrors=${JSON.stringify(pageErrors)}`, { cause: error });
  }
  await receiver.page.getByRole('region', { name: 'Conversaciones' }).getByRole('button', { name: 'SRD QA admin' }).click();
  await sender.page.locator('.sidebar').getByRole('button', { name: 'Chat', exact: true }).click();
  await sender.page.getByRole('region', { name: 'Conversaciones' }).getByRole('button', { name: 'SRD QA viewer' }).click();
  const panel = sender.page.getByRole('region', { name: 'Mensajes' });
  const receivedPanel = receiver.page.getByRole('region', { name: 'Mensajes' });

  const marker = `Adjunto ficticio de producción ${randomUUID().slice(0, 8)}`;
  const filename = `srd-qa-${randomUUID().slice(0, 8)}.png`;
  await panel.getByRole('textbox', { name: 'Mensaje' }).fill(marker);
  await panel.locator('input[type="file"]').setInputFiles({ name: filename, mimeType: 'image/png', buffer: png });
  const submitted = sender.page.waitForResponse(response => response.request().method() === 'POST'
    && /\/api\/v1\/conversations\/[^/]+\/messages$/.test(new URL(response.url()).pathname));
  await panel.getByRole('button', { name: 'Enviar', exact: true }).click();
  const result = await submitted;
  if (!result.ok()) throw new Error(`Chat attachment upload HTTP ${result.status()}`);
  const item = receivedPanel.locator('.chat-messages li').filter({ hasText: marker });
  await expect(item).toBeVisible({ timeout: 45000 });
  const download = receiver.page.waitForEvent('download');
  await item.getByRole('button', { name: new RegExp(filename) }).click();
  await receiver.page.locator('.chat-image-toolbar').getByRole('button', { name: 'Descargar' }).click();
  const downloaded = await download;
  if (downloaded.suggestedFilename() !== filename) throw new Error('Downloaded attachment filename differs');
  const chunks = [];
  for await (const chunk of await downloaded.createReadStream()) chunks.push(chunk);
  const receivedPng = Buffer.concat(chunks);
  if (!receivedPng.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    || receivedPng.readUInt32BE(16) !== 2 || receivedPng.readUInt32BE(20) !== 2) {
    throw new Error('Downloaded attachment is not the expected sanitized 2x2 PNG');
  }
  await receiver.page.getByRole('dialog').getByRole('button', { name: 'Cerrar' }).click();
  process.stdout.write('CHAT_PUBLIC_ATTACHMENT_UPLOAD_DELIVERY_DOWNLOAD_OK\n');

  let closed = false;
  firstSocket.on('close', () => { closed = true; });
  const reconnected = receiver.page.waitForEvent('websocket', { predicate: socket => socket.url().includes('/app/'), timeout: 60000 });
  const forcedClose = await receiver.page.evaluate(() => {
    const socket = window.__srdQaSockets?.find(item => item.url.includes('/app/') && item.readyState === WebSocket.OPEN);
    if (!socket) return false;
    socket.close(1000, 'srd qa connection interruption');
    return true;
  });
  if (!forcedClose) throw new Error('Receiver had no open chat socket to interrupt');
  await expect.poll(() => closed, { timeout: 15000 }).toBe(true);
  const secondSocket = await reconnected;
  if (!secondSocket.url().startsWith('wss://')) throw new Error('Chat reconnection did not use WSS');
  const secondFrames = [];
  secondSocket.on('framereceived', frame => secondFrames.push(frame.payload));
  await expect.poll(() => secondFrames.some(frame => frame.includes('subscription_succeeded')), { timeout: 30000 }).toBe(true);
  const live = `Mensaje tras reconexión ${randomUUID().slice(0, 8)}`;
  await panel.getByRole('textbox', { name: 'Mensaje' }).fill(live);
  await panel.getByRole('button', { name: 'Enviar', exact: true }).click();
  await expect(receivedPanel.getByText(live)).toBeVisible({ timeout: 30000 });
  process.stdout.write('CHAT_PUBLIC_WSS_RECONNECTION_AND_LIVE_DELIVERY_OK\n');
} finally {
  for (const context of contexts.reverse()) await context.close();
  await browser.close();
}
