// Checks public STUN reachability from this PC and the VPS without exposing ICE addresses.
import { chromium } from '@playwright/test';

const browsers = [await chromium.launch({ channel: 'chrome', headless: true }), await chromium.connect('ws://127.0.0.1:3100/')];
try {
  for (const [index, browser] of browsers.entries()) {
    const page = await browser.newPage();
    await page.goto('https://srd-jsgh1.duckdns.org/');
    const types = await page.evaluate(async () => {
      const peer = new RTCPeerConnection({ iceServers: [{ urls: 'stun:srd-jsgh1.duckdns.org:3478' }] });
      try {
        peer.createDataChannel('srd-qa');
        await peer.setLocalDescription(await peer.createOffer());
        await Promise.race([
          new Promise(resolve => {
            if (peer.iceGatheringState === 'complete') resolve();
            else peer.addEventListener('icegatheringstatechange', () => {
              if (peer.iceGatheringState === 'complete') resolve();
            });
          }),
          new Promise(resolve => setTimeout(resolve, 12000)),
        ]);
        return [...new Set((peer.localDescription?.sdp ?? '').match(/typ (?:host|srflx|relay)/g) ?? [])];
      } finally {
        peer.close();
      }
    });
    if (!types.includes('typ srflx')) throw new Error(`Public STUN candidate missing from ${index === 0 ? 'PC' : 'VPS'} browser`);
    process.stdout.write(`${index === 0 ? 'PC' : 'VPS'}_PUBLIC_STUN_OK\n`);
    await page.close();
  }
} finally {
  for (const browser of browsers.reverse()) await browser.close();
}
