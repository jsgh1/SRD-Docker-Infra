import { defineConfig } from "@playwright/test";
import fs from 'node:fs';
import path from 'node:path';
const temporaryDirectory = path.resolve(import.meta.dirname, '../../.local/browser-tmp');
fs.mkdirSync(temporaryDirectory, { recursive: true });
process.env.TEMP = temporaryDirectory;
process.env.TMP = temporaryDirectory;
export default defineConfig({
  testDir: ".",
  testMatch: process.env.SRD_BROWSER_SPEC || "*.spec.mjs",
  testIgnore: process.env.SRD_BROWSER_SPEC ? [] : ["chat-latency.spec.mjs"],
  workers: 1,
  retries: 0,
  timeout: 180000,
  expect: { timeout: 20000 },
  use: {
    baseURL: process.env.SRD_TEST_URL || "http://127.0.0.1:5173",
    ignoreHTTPSErrors: process.env.SRD_TEST_TLS === '1',
    headless: true,
    trace: "off",
    screenshot: "only-on-failure",
  },
  reporter: [
    ["list"],
    ["json", { outputFile: process.env.SRD_BROWSER_REPORT || "../../.local/browser-results.json" }],
  ],
  outputDir: process.env.SRD_BROWSER_OUTPUT || "../../.local/browser-test-results",
});
