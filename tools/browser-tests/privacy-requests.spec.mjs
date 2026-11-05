import { test, expect } from '@playwright/test';

test.use({ channel: 'chrome' });

test('approved erasure requires confirmation and reports completion in English at mobile width', async ({ page }) => {
  test.setTimeout(45000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 360, height: 780 });
  const userId = '22222222-2222-4222-8222-222222222222';
  const personId = '33333333-3333-4333-8333-333333333333';
  const requestId = '44444444-4444-4444-8444-444444444444';
  let item = null;
  await page.route('**/api/v1/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    let data = null;
    if (path.endsWith('/me')) data = {
      user_id: userId, role: 'admin', terms_required: false,
      user: { name: 'Test admin', email: 'admin@example.test', theme: 'light', presence: 'online', language: 'en' },
      organization: { id: '11111111-1111-4111-8111-111111111111', code: 'test', name: 'Test council', accent: '#276065', version: 1,
        terms: { id: '55555555-5555-4555-8555-555555555555', version: 1, body: 'Terms', body_en: 'Terms' } },
    };
    else if (path.endsWith('/csrf')) data = { token: 'test' };
    else if (path.endsWith('/system/privacy-erasures')) data = {
      approved_pending: 1, in_progress: 2, photo_jobs_pending: 2,
      photo_jobs_due: 1, photo_jobs_stalled: 1, checked_at: '2026-10-11T12:00:00Z',
    };
    else if (path.endsWith('/privacy-requests') && request.method() === 'GET') data = { items: item ? [item] : [], total: item ? 1 : 0, page: 1, page_size: 25 };
    else if (path.endsWith('/privacy-requests') && request.method() === 'POST') {
      const body = request.postDataJSON();
      expect(body.person_id).toBe(personId);
      item = { id: requestId, person_id: personId, first_names: 'Persona', last_names: 'Ficticia', document_number: '123456',
        kind: 'erasure', status: 'open', summary: body.summary, decision: null, responsible_id: null, decided_at: null,
        created_at: '2026-10-11T12:00:00Z', version: 1, history: [{ status: 'open', actor_id: userId, created_at: '2026-10-11T12:00:00Z' }] };
      data = { id: requestId, status: 'open', version: 1 };
    } else if (path.endsWith(`/privacy-requests/${requestId}/execute-erasure`) && request.method() === 'POST') {
      const body = request.postDataJSON();
      expect(body).toMatchObject({ version: 3, confirmed: true });
      item = { ...item, first_names: null, last_names: null, document_number: null,
        summary: 'Contenido eliminado tras supresión.', decision: null, status: 'erased', version: 5,
        history: [...item.history, { status: 'erased', actor_id: userId, created_at: '2026-10-11T12:06:00Z' }] };
      data = { id: requestId, status: 'erased', version: 5 };
    } else if (path.endsWith(`/privacy-requests/${requestId}`) && request.method() === 'PATCH') {
      const body = request.postDataJSON();
      item = { ...item, status: body.status, version: item.version + 1, responsible_id: userId,
        decision: body.decision, decided_at: body.status === 'in_review' ? null : '2026-10-11T12:05:00Z',
        history: [...item.history, { status: body.status, actor_id: userId, created_at: '2026-10-11T12:05:00Z' }] };
      data = { id: requestId, status: item.status, version: item.version };
    } else if (path.endsWith('/persons')) data = { items: [{ id: personId, first_names: 'Persona', last_names: 'Ficticia', document_number: '123456' }], total: 1 };
    await route.fulfill({ status: data === null ? 503 : 200, contentType: 'application/json',
      body: JSON.stringify(data === null ? { error: { message: 'Unavailable in preview' } } : { data }) });
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Open menu' })).toBeVisible();
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Privacy requests' });
  await expect(panel).toBeVisible();
  const erasureStatus = page.getByRole('region', { name: 'Erasure status' });
  await expect(erasureStatus).toContainText('Delayed photo cleanups');
  await panel.getByLabel('Find person by name or ID').fill('Persona');
  await panel.getByRole('button', { name: 'Search', exact: true }).click();
  await panel.getByRole('button', { name: /Persona Ficticia/ }).click();
  await panel.locator('form').getByLabel('Request type').selectOption('erasure');
  await panel.getByLabel('Request description').fill('Synthetic privacy request');
  await panel.getByRole('button', { name: 'Record request' }).click();
  await panel.getByRole('button', { name: 'Start review' }).click();
  await panel.getByLabel('Reason for decision').fill('Approved for synthetic test');
  await panel.getByRole('button', { name: 'Approve, pending erasure' }).click();
  await expect(panel.getByText('Approved erasure has not yet been executed.')).toBeVisible();
  await panel.getByRole('button', { name: 'Execute erasure' }).click();
  const confirmation = page.getByRole('dialog', { name: 'Confirm action' });
  await expect(confirmation).toContainText('This action will delete the person record');
  await confirmation.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(panel.locator('.privacy-item-heading span')).toHaveText('Person record erased');
  await expect(panel.getByText('Content removed after erasure.')).toBeVisible();
  await panel.getByText('Request history').click();
  await expect(panel.locator('.privacy-item details li').getByText('Under review')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(errors).toEqual([]);
});
