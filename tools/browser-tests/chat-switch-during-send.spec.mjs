import { test, expect } from '@playwright/test';

test.use({ channel: 'chrome' });

for (const returnToFirst of [false, true]) test(
  returnToFirst ? 'preserves a new draft when returning to the sending conversation' : 'keeps a sent message and draft in their own conversations when switching during a request',
  async ({ page }) => {
  const self = '22222222-2222-4222-8222-222222222222';
  const first = '33333333-3333-4333-8333-333333333333';
  const second = '44444444-4444-4444-8444-444444444444';
  const conversations = [
    { id: first, contact: { id: '55555555-5555-4555-8555-555555555555', name: 'First colleague' }, updated_at: '2026-10-11T12:00:00Z' },
    { id: second, contact: { id: '66666666-6666-4666-8666-666666666666', name: 'Second colleague' }, updated_at: '2026-10-11T12:00:00Z' },
  ];
  let releaseSend;
  let sendStarted;
  const started = new Promise(resolve => { sendStarted = resolve; });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/v1/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let data;
    if (path.endsWith('/me')) data = {
      user_id: self, role: 'admin', terms_required: false,
      user: { name: 'Test admin', email: 'admin@example.test', theme: 'light', presence: 'online', language: 'en' },
      organization: { id: '11111111-1111-4111-8111-111111111111', code: 'test', name: 'Test council', accent: '#276065', version: 1,
        terms: { id: '77777777-7777-4777-8777-777777777777', version: 1, body: 'Terms', body_en: 'Terms' } },
    };
    else if (path.endsWith('/csrf')) data = { token: 'test' };
    else if (path.endsWith('/conversations')) data = { items: conversations, total: 2, page: 1, page_size: 25 };
    else if (path.endsWith('/contacts/55555555-5555-4555-8555-555555555555'))
      data = { id: conversations[0].contact.id, title: 'Primera secretaria', title_en: 'First secretary' };
    else if (path.endsWith('/contacts/66666666-6666-4666-8666-666666666666'))
      data = { id: conversations[1].contact.id, title: 'Segunda tesorera', title_en: 'Second treasurer' };
    else if (path.endsWith(`/conversations/${first}/messages`) && request.method() === 'POST') {
      const body = request.postDataJSON();
      expect(body.body).toBe('First message');
      sendStarted();
      await new Promise(resolve => { releaseSend = resolve; });
      data = { id: '88888888-8888-4888-8888-888888888888', sequence: 1, sender_id: self,
        body: body.body, attachment: null, created_at: '2026-10-11T12:00:00Z', delivered_at: null, read_at: null };
    } else if (path.endsWith(`/conversations/${first}/messages`) && request.method() === 'GET')
      data = { items: [], next_before: null, next_after: null, receipts: [] };
    else if (path.endsWith(`/conversations/${second}/messages`) && request.method() === 'GET')
      data = { items: [], next_before: null, next_after: null, receipts: [] };
    await route.fulfill({ status: data === undefined ? 503 : 200, contentType: 'application/json',
      body: JSON.stringify(data === undefined ? { error: { message: 'Unavailable in preview' } } : { data }) });
  });

  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  const list = page.getByRole('region', { name: 'Conversations' });
  const panel = page.getByRole('region', { name: 'Messages' });
  await list.getByRole('button', { name: 'First colleague' }).click();
  await expect(panel.getByLabel('Contact title')).toHaveText('First secretary');
  await panel.getByLabel('Message').fill('First message');
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  await Promise.race([started, new Promise((_, reject) => setTimeout(() => reject(new Error('Send request did not start')), 10000))]);
  await list.getByRole('button', { name: 'Second colleague' }).click();
  await expect(panel.getByLabel('Contact title')).toHaveText('Second treasurer');
  await expect(panel.getByLabel('Message')).toBeEmpty();
  await panel.getByLabel('Message').fill('Second draft');
  await list.getByRole('button', { name: 'Second colleague' }).click();
  await expect(panel.getByLabel('Message')).toHaveValue('Second draft');
  if (returnToFirst) {
    await list.getByRole('button', { name: 'First colleague' }).click();
    await expect(panel.getByLabel('Contact title')).toHaveText('First secretary');
    await panel.getByLabel('Message').fill('New first draft');
  }
  releaseSend();
  await expect(panel.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  await expect(panel.getByLabel('Message')).toHaveValue(returnToFirst ? 'New first draft' : 'Second draft');
  await expect(panel.getByText('First message')).toHaveCount(returnToFirst ? 1 : 0);
  expect(errors).toEqual([]);
});
