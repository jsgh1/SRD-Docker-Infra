import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { _electron } from './browser-tests/node_modules/playwright/index.mjs';

const root = path.resolve(import.meta.dirname, '..');
const profile = path.join(root, '.local', 'desktop-e2e', randomUUID());
fs.mkdirSync(profile, { recursive: true });
const env = { ...process.env,
  SRD_DESKTOP_USER_DATA_DIR: profile,
  SRD_DESKTOP_SERVER_URL: 'http://127.0.0.1:8080',
};
delete env.ELECTRON_RUN_AS_NODE;
let desktop;
try {
  desktop = await _electron.launch({
    executablePath: process.env.SRD_DESKTOP_EXECUTABLE
      || path.join(root, 'apps', 'desktop', 'node_modules', 'electron', 'dist', 'electron.exe'),
    args: process.env.SRD_DESKTOP_EXECUTABLE ? [] : [path.join(root, 'apps', 'desktop', 'main.cjs')],
    env,
    timeout: 30000,
  });
  const page = await desktop.firstWindow();
  await page.locator('input').first().waitFor({ timeout: 30000 });
  assert.equal(new URL(page.url()).origin, 'http://127.0.0.1:8080');
  const renderer = await page.evaluate(() => ({
    process: typeof window.process,
    require: typeof window.require,
    opened: window.open('about:blank') !== null,
  }));
  assert.equal(renderer.process, 'undefined');
  assert.equal(renderer.require, 'undefined');
  assert.equal(renderer.opened, false);
  console.log('Electron abrió SRD local y mantuvo aislado el renderer.');
} finally {
  if (desktop) await desktop.close();
}
