import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '../..');
const fixture = JSON.parse(fs.readFileSync(path.join(root, '.local/e2e-fixture.json'), 'utf8'));

test.use({ channel: 'chrome' });

test('real privacy request remains pending after approval and leaves no synthetic request', async ({ page, request }) => {
  test.setTimeout(120000);
  const summary = `PRIV-LIVE-${crypto.randomUUID()}`;
  const organizationId = fixture.orgA;
  try {
    const mailboxBefore = await (await request.get('http://127.0.0.1:8025/api/v1/messages')).json();
    const previousMailIds = new Set(mailboxBefore.messages?.map(message => message.ID) ?? []);
    await page.setViewportSize({ width: 360, height: 780 });
    await page.goto('/j/srd-e2e-a/login');
    await page.getByLabel('Correo electrónico', { exact: true }).fill(fixture.users.admin.email);
    await page.getByLabel('Contraseña', { exact: true }).fill(fixture.password);
    await page.getByRole('button', { name: 'términos y condiciones' }).click();
    await page.getByRole('button', { name: 'Aceptar términos' }).click();
    await page.getByRole('button', { name: 'Ingresar', exact: true }).click();
    let mailId;
    await expect.poll(async () => {
      const response = await request.get('http://127.0.0.1:8025/api/v1/messages');
      const data = await response.json();
      mailId = data.messages?.find(message => !previousMailIds.has(message.ID)
        && ['Tu código de seguridad de SRD', 'Your SRD security code'].includes(message.Subject)
        && message.To.some(recipient => recipient.Address === fixture.users.admin.email))?.ID;
      return Boolean(mailId);
    }, { timeout: 30000 }).toBe(true);
    const mail = await (await request.get(`http://127.0.0.1:8025/api/v1/message/${mailId}`)).json();
    const code = mail.Text.match(/\b\d{6}\b/)?.[0];
    expect(code).toBeTruthy();
    await page.getByLabel('Código de verificación').fill(code);
    await page.getByRole('button', { name: 'Confirmar código' }).click();
    await expect(page.locator('.profile-trigger')).toBeVisible();
    await page.locator('.profile-trigger').click();
    if (await page.locator('html').getAttribute('lang') !== 'en') {
      await page.getByRole('combobox', { name: 'Idioma' }).selectOption('en');
    }
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');

    const peopleResponse = await page.request.get('/api/v1/persons');
    expect(peopleResponse.ok(), `People API status ${peopleResponse.status()}`).toBe(true);
    const person = (await peopleResponse.json()).data.items[0];
    expect(person?.id).toMatch(/^[0-9a-f-]{36}$/i);
    await page.getByRole('button', { name: 'Open menu' }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Privacy requests' });
    await panel.getByLabel('Find person by name or ID').fill(person.document_number);
    await panel.getByRole('button', { name: 'Search', exact: true }).click();
    await panel.getByRole('button', { name: person.document_number }).click();
    await panel.locator('form').getByLabel('Request type').selectOption('erasure');
    await panel.getByLabel('Request description').fill(summary);
    const created = page.waitForResponse(response => response.url().endsWith('/api/v1/privacy-requests')
      && response.request().method() === 'POST');
    await panel.getByRole('button', { name: 'Record request' }).click();
    const createdResponse = await created;
    expect(createdResponse.ok()).toBe(true);
    await panel.getByRole('button', { name: 'Start review' }).click();
    await panel.getByLabel('Reason for decision').fill('Approved for local synthetic verification');
    await panel.getByRole('button', { name: 'Approve, pending erasure' }).click();
    await expect(panel.getByText('Approved erasure has not yet been executed.')).toBeVisible();
    const requests = await (await page.request.get('/api/v1/privacy-requests?page=1')).json();
    const item = requests.data.items.find(value => value.summary === summary);
    expect(item?.status).toBe('approved_pending_erasure');
    expect(item?.history).toHaveLength(3);
    expect((await page.request.get(`/api/v1/persons/${person.id}`)).ok()).toBe(true);
  } finally {
    const script = `$summary='${summary}'; $org='${organizationId}'; DB::transaction(function() use ($summary,$org) { $rows=DB::table('privacy_requests')->where('organization_id',$org)->where('summary',$summary)->get(['id']); if ($rows->count()>1) throw new RuntimeException('Refusing ambiguous cleanup'); foreach ($rows as $row) { DB::table('privacy_request_history')->where('organization_id',$org)->where('request_id',$row->id)->delete(); DB::table('outbox_events')->where('organization_id',$org)->where('resource_id',$row->id)->whereIn('action',['privacy_request.created','privacy_request.updated'])->delete(); DB::table('privacy_requests')->where('organization_id',$org)->where('id',$row->id)->delete(); } }); echo DB::table('privacy_requests')->where('organization_id',$org)->where('summary',$summary)->count();`;
    const result = execFileSync('docker', ['compose', 'exec', '-e', 'XDG_CONFIG_HOME=/tmp', '-T', 'records', 'php', 'artisan', 'tinker', '--execute', script],
      { cwd: root, encoding: 'utf8', timeout: 30000 }).trim();
    expect(result).toBe('0');
  }
});
