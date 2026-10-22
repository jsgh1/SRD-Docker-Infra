// Exercises a real SRD voice call between this PC and a browser running on the VPS.
import { chromium, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const accountsPath = path.join(root, '.local/production/qa-accounts.json');
const accounts = JSON.parse(readFileSync(accountsPath, 'utf8'));
if (!accounts.admin?.cookies?.length || !accounts.viewer?.cookies?.length) throw new Error('Valid admin/viewer QA sessions missing');
const origin = 'https://srd-jsgh1.duckdns.org';
const local = await chromium.launch({ channel: 'chrome', headless: true });
const remote = await chromium.connect('ws://127.0.0.1:3100/');
const contexts = [];
let passed = false;
try {
  async function makePage(browser, role) {
    const context = await browser.newContext({ viewport: { width: role === 'viewer' ? 390 : 1280, height: 860 }, permissions: ['microphone'] });
    contexts.push(context);
    await context.addCookies(accounts[role].cookies);
    await context.addInitScript(() => {
      window.__srdPeers = [];
      const NativePeer = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends NativePeer {
        constructor(config) { super(config); window.__srdPeers.push(this); }
      };
      window.__srdFakeAudio = [];
      navigator.mediaDevices.getUserMedia = async () => {
        const audio = new AudioContext();
        const source = audio.createOscillator();
        const gain = audio.createGain();
        const output = audio.createMediaStreamDestination();
        source.frequency.value = 440;
        gain.gain.value = 0.01;
        source.connect(gain);
        gain.connect(output);
        source.start();
        await audio.resume();
        window.__srdFakeAudio.push({ audio, source });
        return output.stream;
      };
    });
    const page = await context.newPage();
    await page.goto(`${origin}/j/srd-piloto`);
    await expect(page.locator('.profile-trigger')).toBeVisible();
    return page;
  }
  const caller = await makePage(local, 'admin');
  const callee = await makePage(remote, 'viewer');
  for (const [name, page] of [['PC', caller], ['VPS', callee]]) {
    const relay = await page.evaluate(async () => {
      const response = await fetch('/api/v1/voice-calls/ice-config', { credentials: 'same-origin' });
      if (!response.ok) return false;
      const { iceServers } = (await response.json()).data;
      if (!iceServers?.some(server => String(server.urls).startsWith('turn:'))) return false;
      const peer = new RTCPeerConnection({ iceServers, iceTransportPolicy: 'relay' });
      try {
        peer.createDataChannel('srd-qa');
        await peer.setLocalDescription(await peer.createOffer());
        await Promise.race([
          new Promise(resolve => peer.addEventListener('icegatheringstatechange', () => {
            if (peer.iceGatheringState === 'complete') resolve();
          })),
          new Promise(resolve => setTimeout(resolve, 12000)),
        ]);
        return /typ relay/.test(peer.localDescription?.sdp ?? '');
      } finally {
        peer.close();
      }
    });
    if (!relay) throw new Error(`${name} could not allocate a TURN relay candidate`);
  }
  process.stdout.write('BOTH_NETWORKS_TURN_ALLOCATION_OK\n');
  const errors = [];
  caller.on('pageerror', error => errors.push(`caller ${error.message}`));
  callee.on('pageerror', error => errors.push(`callee ${error.message}`));
  const contacts = (await (await caller.request.get(`${origin}/api/v1/contacts?page=1`)).json()).data.items;
  const recipient = contacts.find(contact => contact.name === 'SRD QA viewer');
  if (!recipient) throw new Error('QA viewer missing from contacts');
  await caller.locator('.sidebar').getByRole('button', { name: /^(Contactos|Contacts)$/ }).click();
  await caller.locator('.contact-card').filter({ hasText: recipient.name }).getByRole('button', { name: /Abrir chat|Open chat/ }).click();
  await caller.getByRole('button', { name: new RegExp(`^(Llamar a|Call) ${recipient.name}$`) }).click();
  await expect(callee.getByText(/Llamada entrante de|Incoming call from/)).toBeVisible({ timeout: 30000 });
  await callee.getByRole('button', { name: /Aceptar llamada|Accept call/ }).click();
  await expect(caller.getByText(/Llamada en curso|Call in progress/)).toBeVisible({ timeout: 30000 });
  await expect.poll(async () => caller.evaluate(() => window.__srdPeers.some(peer => peer.connectionState === 'connected')),
    { timeout: 45000 }).toBe(true);
  await expect.poll(async () => callee.evaluate(() => window.__srdPeers.some(peer => peer.connectionState === 'connected')),
    { timeout: 45000 }).toBe(true);
  for (const [name, page] of [['caller', caller], ['callee', callee]]) {
    await expect.poll(async () => page.evaluate(async () => {
      const audio = document.querySelector('audio[aria-label="Audio de la llamada"], audio[aria-label="Call audio"]');
      if (!audio?.srcObject?.getAudioTracks().some(track => track.readyState === 'live')) return false;
      for (const peer of window.__srdPeers) {
        for (const report of (await peer.getStats()).values()) {
          if (report.type === 'inbound-rtp' && report.kind === 'audio' && report.bytesReceived > 0) return true;
        }
      }
      return false;
    }), { timeout: 20000, message: `${name} must receive real audio packets` }).toBe(true);
  }
  if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
  await caller.getByRole('button', { name: /Finalizar llamada|End call/ }).click();
  await expect(callee.getByText(/Llamada en curso|Call in progress/)).toHaveCount(0, { timeout: 15000 });
  const logout = await caller.evaluate(async () => {
    const token = (await (await fetch('/api/v1/csrf', { credentials: 'same-origin' })).json()).data.token;
    const response = await fetch('/api/v1/auth/logout', {
      method: 'POST', credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-TOKEN': token },
      body: '{}',
    });
    return response.status;
  });
  if (logout !== 200) throw new Error(`QA admin logout HTTP ${logout}`);
  process.stdout.write('CROSS_NETWORK_WEBRTC_MEDIA_OK\n');
  passed = true;
} finally {
  for (const context of contexts.reverse()) await context.close();
  await remote.close();
  await local.close();
  if (passed) {
    delete accounts.admin.cookies;
    writeFileSync(accountsPath, JSON.stringify(accounts, null, 2));
  }
}
