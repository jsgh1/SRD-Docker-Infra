import { test, expect } from '@playwright/test';

test.use({ channel: 'chrome', permissions: ['microphone'], launchOptions: {
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
} });

test('records, converts, sends and plays a voice note at mobile width', async ({ page }) => {
  test.setTimeout(60000);
  await page.setViewportSize({ width: 360, height: 780 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const user = '22222222-2222-4222-8222-222222222222';
  const conversation = '33333333-3333-4333-8333-333333333333';
  const messageId = '44444444-4444-4444-8444-444444444444';
  const attachmentId = '55555555-5555-4555-8555-555555555555';
  let message;
  let wav;
  await page.route('**/api/v1/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let data;
    if (path.endsWith('/me')) data = {
      user_id: user, role: 'admin', terms_required: false,
      user: { name: 'Test admin', email: 'admin@example.test', theme: 'light', presence: 'online', language: 'en' },
      organization: { id: '11111111-1111-4111-8111-111111111111', code: 'test', name: 'Test council', accent: '#276065', version: 1,
        terms: { id: '66666666-6666-4666-8666-666666666666', version: 1, body: 'Terms', body_en: 'Terms' } },
    };
    else if (path.endsWith('/csrf')) data = { token: 'test' };
    else if (path.endsWith('/conversations')) data = { items: [{ id: conversation, contact: { id: '77777777-7777-4777-8777-777777777777', name: 'Test colleague' }, updated_at: '2026-10-11T12:00:00Z' }], total: 1, page: 1, page_size: 25 };
    else if (path.endsWith(`/conversations/${conversation}/messages`) && request.method() === 'GET') data = { items: message ? [message] : [], next_before: null, next_after: null, receipts: [] };
    else if (path.endsWith(`/conversations/${conversation}/messages`) && request.method() === 'POST') {
      const body = request.postDataJSON();
      expect(body.attachment.name).toMatch(/^nota-de-voz-.*\.wav$/);
      wav = Buffer.from(body.attachment.content, 'base64');
      expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
      expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
      expect(wav.readUInt16LE(20)).toBe(1);
      expect(wav.readUInt16LE(22)).toBe(1);
      expect(wav.readUInt32LE(24)).toBe(16000);
      message = { id: messageId, sequence: 1, sender_id: user, body: body.body, created_at: '2026-10-11T12:00:00Z',
        attachment: { id: attachmentId, name: body.attachment.name, mime: 'audio/wav', bytes: wav.length }, delivered_at: null, read_at: null };
      data = message;
    } else if (path.endsWith(`/messages/${messageId}/attachment`)) data = {
      id: attachmentId, name: message.attachment.name, mime: 'audio/wav', bytes: wav.length, content: wav.toString('base64'),
    };
    await route.fulfill({ status: data === undefined ? 503 : 200, contentType: 'application/json',
      body: JSON.stringify(data === undefined ? { error: { message: 'Unavailable in preview' } } : { data }) });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await page.getByRole('region', { name: 'Conversations' }).getByRole('button', { name: 'Test colleague' }).click();
  const panel = page.getByRole('region', { name: 'Messages' });
  await panel.getByRole('button', { name: 'Record voice note' }).click();
  await expect(panel.getByRole('status')).toContainText('Recording voice note');
  await page.waitForTimeout(1500);
  await panel.getByRole('button', { name: 'Pause recording' }).click();
  await expect(panel.getByRole('button', { name: 'Resume recording' })).toBeVisible();
  await panel.getByRole('button', { name: 'Resume recording' }).click();
  await panel.getByRole('button', { name: 'Finish recording' }).click();
  await expect(panel.locator('.chat-attachment-preview .chat-voice-player')).toBeVisible();
  await expect(panel.getByLabel('Voice note preview')).toHaveAttribute('src', /blob:/);
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Play voice note' })).toBeVisible();
  const badIconControls = await panel.locator('button, summary').evaluateAll(controls => controls.filter(control => {
    const box = control.getBoundingClientRect();
    if (!box.width || !box.height || control.textContent?.trim()) return false;
    return !control.getAttribute('aria-label')?.trim() || box.width < 28 || box.height < 28;
  }).map(control => control.outerHTML.slice(0, 140)));
  expect(badIconControls).toEqual([]);
  await panel.getByRole('button', { name: 'Play voice note' }).click();
  await expect(panel.getByLabel('Voice note from You')).toHaveAttribute('src', /blob:/);
  await panel.getByRole('button', { name: 'Record voice note' }).click();
  await expect(panel.getByRole('status')).toContainText('Recording voice note');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(panel.getByRole('button', { name: 'Record voice note' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(errors).toEqual([]);
});
