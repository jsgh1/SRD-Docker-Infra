// Checks the public TLS WebSocket handshake through Caddy and Nginx.
import { readFileSync } from 'node:fs';
import path from 'node:path';

const env = readFileSync(path.resolve('.local/production/.env.production'), 'utf8');
const key = env.match(/^REVERB_APP_KEY=(.+)$/m)?.[1]?.trim();
if (!key) throw new Error('Reverb public key missing');
const url = `wss://srd-jsgh1.duckdns.org/app/${encodeURIComponent(key)}?protocol=7&client=js&version=8.4.0&flash=false`;
const socket = new WebSocket(url);
const timeout = setTimeout(() => {
  socket.close();
  process.stderr.write('WSS_TIMEOUT\n');
  process.exitCode = 1;
}, 10000);
socket.addEventListener('open', () => {
  clearTimeout(timeout);
  process.stdout.write('PRODUCTION_WSS_OPEN\n');
  socket.close();
});
socket.addEventListener('error', () => {
  clearTimeout(timeout);
  process.stderr.write('WSS_ERROR\n');
  process.exitCode = 1;
});
