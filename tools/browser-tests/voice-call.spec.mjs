import { test, expect } from '@playwright/test';

test.use({ channel: 'chrome', launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] } });

test('two web sessions establish audio, mute and finish without saving media', async ({ page, browser }) => {
  test.setTimeout(65000);
  const receiver = await browser.newPage();
  await receiver.setViewportSize({ width: 360, height: 780 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.stack || error.message));
  receiver.on('pageerror', error => errors.push(error.stack || error.message));
  const org = '11111111-1111-4111-8111-111111111111';
  const caller = '22222222-2222-4222-8222-222222222222';
  const callee = '33333333-3333-4333-8333-333333333333';
  const conversation = '44444444-4444-4444-8444-444444444444';
  const callId = '55555555-5555-4555-8555-555555555555';
  let call = null;
  let sequence = 0;
  const signals = [];
  let networkDown = false;

  async function prepare(tab, self, other, name) {
    await tab.route('**/api/v1/**', async route => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname.replace('/api/v1/', '');
      const method = request.method();
      let data;
      let status = 200;
      if (networkDown && path.includes(`/calls/${callId}`)) {
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Offline' } }) });
        return;
      }
      if (path === 'me' || path.endsWith('/me')) data = { user_id: self, role: 'viewer', terms_required: false,
        user: { name, email: `${name}@example.test`, theme: 'light', presence: 'online', language: 'en' },
        organization: { id: org, code: 'test', name: 'Test council', accent: '#276065', version: 1,
          terms: { id: '66666666-6666-4666-8666-666666666666', version: 1, body: 'Terms', body_en: 'Terms' } } };
      else if (path === 'csrf') data = { token: 'test' };
      else if (path === 'dashboard') data = { total: 0, today: 0, week: 0, month: 0,
        date: '2026-10-12', generated_at: '2026-10-12T12:00:00Z', last_seven_days: [], latest: [] };
      else if (path === 'quick-links') data = { mode: 'common', items: [] };
      else if (path === 'presence/heartbeat') data = { effective: 'online', preference: 'online', ttl_seconds: 90 };
      else if (path === 'folder-access') data = { can_read: false };
      else if (path === 'planilla-settings') data = { logo_data: null };
      else if (path.endsWith('/photos')) data = { items: [] };
      else if (path === 'voice-calls/ice-config') data = { iceServers: [] };
      else if (path === 'voice-calls') data = call?.status === 'ringing' && self === callee ? [call] : [];
      else if (path === 'conversations' && method === 'GET') data = { items: [{ id: conversation,
        contact: { id: other, name: self === caller ? 'Receiver' : 'Caller' }, updated_at: '2026-10-12T12:00:00Z' }],
        total: 1, page: 1, page_size: 25 };
      else if (path === `conversations/${conversation}`) data = { id: conversation,
        contact: { id: other, name: self === caller ? 'Receiver' : 'Caller' }, updated_at: '2026-10-12T12:00:00Z' };
      else if (path === `conversations/${conversation}/messages`) data = { items: [], next_before: null, next_after: null, receipts: [] };
      else if (path === `conversations/${conversation}/pinned`) data = { items: [] };
      else if (path === `conversations/${conversation}/calls` && method === 'POST') {
        signals.length = 0;
        sequence = 0;
        call = { id: callId, conversation_id: conversation, caller_id: caller, callee_id: callee, status: 'ringing' };
        data = call;
      } else if (path === `conversations/${conversation}/calls/${callId}`) data = call;
      else if (path === `conversations/${conversation}/calls/${callId}/transition`) {
        const action = request.postDataJSON().action;
        call = { ...call, status: ({ accept: 'accepted', reject: 'rejected', end: 'ended', fail: 'failed' })[action] };
        data = call;
      } else if (path === `conversations/${conversation}/calls/${callId}/signal`) {
        const body = request.postDataJSON();
        signals.push({ sequence: ++sequence, sender: self, kind: body.kind, payload: body.payload });
        data = { sequence };
      } else if (path === `conversations/${conversation}/calls/${callId}/signals`) {
        data = signals.filter(signal => signal.sender !== self && signal.sequence > Number(url.searchParams.get('after') || 0))
          .map(({ sequence, kind, payload }) => ({ sequence, kind, payload }));
      } else if (path === 'chat/broadcast-config') { status = 503; data = {}; }
      else if (path === 'contacts') data = { items: [], total: 0, page: 1, page_size: 25 };
      else if (path.startsWith('contacts/')) data = { id: other, title: null, title_en: null };
      else if (path.startsWith('notifications')) data = { items: [], unread: 0, total: 0 };
      else data = {};
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ data }) });
    });
    await tab.goto('/');
    await expect(tab.getByRole('button', { name: tab === receiver ? 'Open menu' : 'Chat', exact: true })).toBeVisible();
  }

  try {
    await prepare(page, caller, callee, 'Caller');
    await prepare(receiver, callee, caller, 'Receiver');
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    await page.getByRole('region', { name: 'Conversations' }).getByRole('button', { name: 'Receiver' }).click();
    await page.getByRole('button', { name: 'Call Receiver' }).click();
    await expect(receiver.getByText('Incoming call from Caller')).toBeVisible();
    expect(await receiver.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await receiver.getByRole('button', { name: 'Accept call' }).click();
    await expect(page.getByText('Call in progress')).toBeVisible();
    await expect(receiver.getByText('Call in progress')).toBeVisible();
    await expect.poll(() => page.evaluate(() => {
      const audio = document.querySelector('audio[aria-label="Call audio"]');
      return audio?.srcObject?.getAudioTracks().some(track => track.readyState === 'live') || false;
    }), { timeout: 20000 }).toBe(true);
    await page.getByRole('button', { name: 'Mute microphone' }).click();
    await expect(page.getByRole('button', { name: 'Unmute microphone' })).toBeVisible();
    await page.getByRole('button', { name: 'End call' }).click();
    await expect(receiver.getByText('Call in progress')).toHaveCount(0);
    expect(call.status).toBe('ended');
    expect(signals.some(signal => signal.kind === 'offer')).toBe(true);
    expect(signals.some(signal => signal.kind === 'answer')).toBe(true);
    await page.getByRole('button', { name: 'Call Receiver' }).click();
    await expect(receiver.getByText('Incoming call from Caller')).toBeVisible();
    await receiver.getByRole('button', { name: 'Accept call' }).click();
    await expect(page.getByText('Call in progress')).toBeVisible();
    networkDown = true;
    await expect(page.getByText('The call was interrupted. Check your connection and try again.'))
      .toBeVisible({ timeout: 30000 });
    await expect(page.getByText('Call in progress')).toHaveCount(0);
    expect(await page.evaluate(() => document.querySelector('audio[aria-label="Call audio"]')?.srcObject ?? null)).toBeNull();
    expect(errors).toEqual([]);
  } finally { await receiver.close(); }
});
