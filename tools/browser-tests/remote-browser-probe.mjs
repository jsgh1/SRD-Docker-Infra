import { chromium } from '@playwright/test';

const browser = await chromium.connect('ws://127.0.0.1:3100/');
try {
  const context = await browser.newContext({ permissions: ['microphone'] });
  try {
    const page = await context.newPage();
    await page.goto('https://srd-jsgh1.duckdns.org/j/srd-piloto/login');
    const result = await page.evaluate(async () => {
      try {
        const audio = new AudioContext();
        const source = audio.createOscillator();
        const output = audio.createMediaStreamDestination();
        source.connect(output);
        source.start();
        await audio.resume();
        const stream = output.stream;
        const live = stream.getAudioTracks().some(track => track.readyState === 'live');
        stream.getTracks().forEach(track => track.stop());
        source.stop();
        await audio.close();
        return { live };
      } catch (error) {
        return { error: error.name };
      }
    });
    process.stdout.write(`REMOTE_BROWSER_HTTPS_OK ${JSON.stringify(result)}\n`);
  } finally {
    await context.close();
  }
} finally {
  await browser.close();
}
