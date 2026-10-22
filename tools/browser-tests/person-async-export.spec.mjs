import {test, expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';

test.use({channel: 'chrome'});

test('people export over 500 rows queues and reports a ready file', async ({page}) => {
  test.setTimeout(90000);
  const errors = [];
  const calls = [];
  let noticeAvailable = false;
  let jobExpired = false;
  let jobFormat = 'xlsx';
  page.on('pageerror', error => errors.push(error.stack));
  await page.route('**/api/v1/**', async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    calls.push(`${request.method()} ${pathname}`);
    let data = null;
    if (pathname.endsWith('/me')) data = {
      user_id: '00000000-0000-4000-8000-000000000001', role: 'admin', terms_required: false,
      user: {name: 'Test admin', email: 'admin@example.test', theme: 'light', presence: 'online', language: 'en'},
      organization: {id: '00000000-0000-4000-8000-000000000002', code: 'test', name: 'Test council', accent: '#276065', version: 1,
        terms: {id: '00000000-0000-4000-8000-000000000003', version: 1, body: 'Terms', body_en: 'Terms'}},
    };
    else if (pathname.endsWith('/csrf')) data = {token: 'test-token'};
    else if (pathname.endsWith('/person-filter-settings')) data = {base: [], custom: [], version: 1};
    else if (pathname.endsWith('/persons')) data = {items: [], page: 1, page_size: 10, total: 501};
    else if (pathname.endsWith('/persons/export-jobs') && request.method() === 'POST') {
      jobFormat = new URL(request.url()).searchParams.get('format') === 'pdf' ? 'pdf' : 'xlsx';
      jobExpired = false;
      data = {id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', status: 'queued', format: jobFormat,
        count: 501, cutoff_at: '2026-10-11T12:00:00Z'};
    }
    else if (pathname.endsWith('/persons/export-jobs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')) data = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', status: jobExpired ? 'expired' : 'ready', format: jobFormat, count: 501,
      cutoff_at: '2026-10-11T12:00:00Z', filename: `personas_2026-10-11.${jobFormat}`,
      ...(jobExpired ? {} : {ticket: 'a'.repeat(64)})};
    else if (pathname.endsWith('/persons/export-jobs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/download') && jobFormat === 'pdf') data = {
      filename: 'personas_2026-10-11.pdf', date: '2026-10-11', language: 'en', count: 501,
      headers: ['No.', 'First names', 'Last names', 'Document type', 'Document number', 'Status', 'Membership',
        'Area', 'Birth date', 'Position', 'Registration UTC', 'ID'],
      rows: Array.from({length: 501}, (_, index) => [String(index + 1), 'Test', 'Person', 'Citizenship Card',
        `PDF-${index + 1}`, 'Pending', 'No', 'Urban', '', '', '2026-10-11', `id-${index + 1}`]),
    };
    else if (pathname.endsWith('/planilla-settings')) data = {version: 1, allowed_columns: [], h1: 'Council', h2: 'Test council',
      h3: 'Signature sheet', h1_en: 'Council', h2_en: 'Test council', h3_en: 'Signature sheet', logo_data: null,
      delegated_roles: [], can_manage: false, can_delegate: false};
    else if (pathname.endsWith('/quick-links')) data = {mode: 'common', common_version: 1, personal_version: 1, inherited: true,
      items: [], common_items: [], personal_items: null, catalog: []};
    else if (pathname.endsWith('/presence/heartbeat')) data = {effective: 'online', preference: 'online', ttl_seconds: 90};
    else if (pathname.endsWith('/dashboard')) data = {date: '2026-10-11', generated_at: '2026-10-11T12:00:00Z', total: 501, today: 0,
      week: 0, month: 0, last_seven_days: [], latest: [], gender: [], document_types: []};
    else if (pathname.endsWith('/notifications')) data = {items: noticeAvailable ? [{
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', event_id: null, conversation_id: null,
      export_job_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', kind: 'export_ready',
      title: 'Tu exportación de personas está lista', title_en: 'Your people export is ready',
      created_at: '2026-10-11T12:00:00Z', read_at: null,
    }] : [], unread: noticeAvailable ? 1 : 0, total: noticeAvailable ? 1 : 0, page: 1, page_size: 25};
    else if (pathname.endsWith('/notifications/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/read')) data = {id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'};
    else if (pathname.endsWith('/notification-preferences')) data = {event_changes: true, reminders: true, chat_messages: true, quiet_start: null, quiet_end: null};
    await route.fulfill({status: data === null ? 503 : 200, contentType: 'application/json',
      body: JSON.stringify(data === null ? {error: {message: 'Unavailable in preview'}} : {data})});
  });
  await page.goto('/');
  await page.locator('.sidebar').getByRole('button', {name: 'Export', exact: true}).click();
  await page.getByRole('button', {name: 'Open people exports'}).click();
  await expect(page.getByRole('button', {name: 'Export Excel'})).toBeEnabled();
  await page.getByRole('button', {name: 'Export Excel'}).click();
  await expect(page.getByText('Queued', {exact: true})).toBeVisible();
  await page.getByRole('button', {name: 'Refresh status'}).click();
  await expect(page.getByText('Ready to download')).toBeVisible();
  expect(calls).toContain('POST /api/v1/persons/export-jobs');
  expect(calls).not.toContain('GET /api/v1/persons/export');
  await page.locator('.sidebar').getByRole('button', {name: 'Home', exact: true}).click();
  noticeAvailable = true;
  await page.locator('.notification-trigger').click();
  await expect(page.getByText('Export ready: Your people export is ready')).toBeVisible();
  await page.getByRole('button', {name: /Export ready: Your people export is ready/}).click();
  await expect(page.getByText('Ready to download')).toBeVisible();
  await expect(page.getByRole('button', {name: 'Download prepared Excel file'})).toBeVisible();
  jobExpired = true;
  await page.getByRole('button', {name: 'Download prepared Excel file'}).click();
  await expect(page.getByText('Expired', {exact: true})).toBeVisible();
  await expect(page.getByRole('button', {name: 'Download prepared Excel file'})).toHaveCount(0);
  await page.locator('.sidebar').getByRole('button', {name: 'Home', exact: true}).click();
  await page.locator('.sidebar').getByRole('button', {name: 'List', exact: true}).click();
  await expect(page.getByText('Expired', {exact: true})).toBeVisible();
  await expect(page.getByText('The file expired after 24 hours. Export again to create a new one.')).toBeVisible();
  await expect(page.getByRole('button', {name: 'Download prepared Excel file'})).toHaveCount(0);
  await expect(page.getByRole('button', {name: 'Export Excel'})).toBeEnabled();
  await page.getByRole('button', {name: 'Export PDF'}).click();
  await expect(page.getByText('Queued', {exact: true})).toBeVisible();
  await page.getByRole('button', {name: 'Refresh status'}).click();
  await expect(page.getByRole('button', {name: 'Download prepared PDF file'})).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', {name: 'Download prepared PDF file'}).click();
  const pdfDownload = await downloadPromise;
  expect(pdfDownload.suggestedFilename()).toBe('personas_2026-10-11.pdf');
  expect((await readFile(await pdfDownload.path())).subarray(0, 5).toString()).toBe('%PDF-');
  expect(calls).toContain('GET /api/v1/persons/export-jobs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/download');
  expect(calls).not.toContain('GET /api/v1/persons/export-pdf');
  expect(errors).toEqual([]);
});
