import { test, expect } from '@playwright/test';

test.use({ channel: 'chrome', locale: 'es-CO' });

test('chat image attachment survives an uncertain response and retries without a duplicate at mobile width', async ({ page }) => {
  test.setTimeout(45000);
  await page.setViewportSize({ width: 360, height: 780 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const userId = '22222222-2222-4222-8222-222222222222';
  const conversationId = '33333333-3333-4333-8333-333333333333';
  const messageId = '44444444-4444-4444-8444-444444444444';
  const attachmentId = '55555555-5555-4555-8555-555555555555';
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAUSURBVBhXY/jPAEZA3AAk/zP8BwBEUQh5fHTJZQAAAABJRU5ErkJggg==', 'base64');
  let message = null;
  let firstClientId;
  let posts = 0;
  await page.route('**/api/v1/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let data = null;
    if (path.endsWith('/me')) data = {
      user_id: userId, role: 'admin', terms_required: false,
      user: { name: 'Test admin', email: 'admin@example.test', theme: 'light', presence: 'online', language: 'en' },
      organization: { id: '11111111-1111-4111-8111-111111111111', code: 'test', name: 'Test council', accent: '#276065', version: 1,
        terms: { id: '66666666-6666-4666-8666-666666666666', version: 1, body: 'Terms', body_en: 'Terms' } },
    };
    else if (path.endsWith('/csrf')) data = { token: 'test' };
    else if (path.endsWith('/conversations')) data = { items: [{ id: conversationId, contact: { id: '77777777-7777-4777-8777-777777777777', name: 'Test colleague' }, updated_at: '2026-10-11T12:00:00Z' }], total: 1, page: 1, page_size: 25 };
    else if (path.endsWith(`/conversations/${conversationId}/messages`) && request.method() === 'GET') data = { items: message ? [message] : [], next_before: null, next_after: null, receipts: [] };
    else if (path.endsWith(`/conversations/${conversationId}/messages`) && request.method() === 'POST') {
      const body = request.postDataJSON();
      posts++;
      expect(body.attachment.name).toBe('demo.png');
      expect(body.attachment.content).toBe(png.toString('base64'));
      if (posts === 1) firstClientId = body.client_id;
      else expect(body.client_id).toBe(firstClientId);
      message = { id: messageId, sequence: 1, sender_id: userId, body: body.body, created_at: '2026-10-11T12:00:00Z',
        attachment: { id: attachmentId, name: 'demo.png', mime: 'image/png', bytes: png.length }, delivered_at: null, read_at: null };
      data = message;
      if (posts === 1) { await route.abort('failed'); return; }
    } else if (path.endsWith(`/messages/${messageId}/attachment`)) data = {
      id: attachmentId, name: 'demo.png', mime: 'image/png', bytes: png.length, content: png.toString('base64'),
    };
    await route.fulfill({ status: data === null ? 503 : 200, contentType: 'application/json',
      body: JSON.stringify(data === null ? { error: { message: 'Unavailable in preview' } } : { data }) });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await page.getByRole('region', { name: 'Conversations' }).getByRole('button', { name: 'Test colleague' }).click();
  const panel = page.getByRole('region', { name: 'Messages' });
  await expect(panel.getByRole('button', { name: 'Attach file' })).toBeVisible();
  await panel.locator('input[type="file"]').setInputFiles({ name: 'demo.png', mimeType: 'image/png', buffer: png });
  await expect(panel.locator('.chat-preview-info')).toContainText('demo.png');
  await expect(panel.getByAltText('Attachment preview')).toBeVisible();
  expect(await panel.getByAltText('Attachment preview').evaluate(image => image.naturalWidth)).toBe(2);
  await panel.getByRole('button', { name: 'Remove attachment' }).click();
  await expect(panel.getByAltText('Attachment preview')).toHaveCount(0);
  await panel.locator('input[type="file"]').setInputFiles({ name: 'demo.png', mimeType: 'image/png', buffer: png });
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(panel.locator('form [role="alert"]')).toBeVisible();
  await expect(panel.locator('.chat-preview-info')).toContainText('demo.png');
  await expect(panel.getByRole('button', { name: 'Enlarge image demo.png' })).toBeVisible({ timeout: 25000 });
  await expect(panel.locator('form [role="alert"]')).toBeVisible();
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(panel.locator('form [role="alert"]')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Enlarge image demo.png' })).toBeVisible();
  await panel.getByRole('button', { name: 'Enlarge image demo.png' }).click();
  await expect(page.getByRole('heading', { name: 'Enlarged image view' })).toBeVisible();
  await page.getByRole('button', { name: 'Zoom in on image' }).click();
  await expect(page.locator('.chat-image-zoom-target.zoomed')).toBeVisible();
  const download = page.waitForEvent('download');
  await page.locator('.chat-image-toolbar').getByRole('button', { name: 'Download' }).click();
  expect((await download).suggestedFilename()).toBe('demo.png');
  expect(posts).toBe(2);
  expect(await panel.getByRole('button', { name: 'Enlarge image demo.png' }).count()).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(errors).toEqual([]);
});
