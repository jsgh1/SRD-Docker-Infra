import { chromium } from '@playwright/test';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const failures = [];
    page.on('pageerror', error => failures.push(error.message));
    const response = await page.goto('https://srd-jsgh1.duckdns.org/j/srd-piloto/login', { waitUntil: 'networkidle' });
    if (response?.status() !== 200) throw new Error(`Login page HTTP ${response?.status()}`);
    await page.getByRole('heading', { name: /Iniciar sesión|Sign in/i }).waitFor();
    await page.locator('input[name="email"]').waitFor();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    if (overflow || failures.length) throw new Error(`${viewport.width}px: overflow=${overflow}, errors=${failures.join('; ')}`);
    process.stdout.write(`LOGIN_BROWSER_${viewport.width}_OK\n`);
    await context.close();
  }
} finally {
  await browser.close();
}
