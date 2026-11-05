import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

test.use({ channel: 'chrome' });
const root = path.resolve(import.meta.dirname, '../..');
const fixture = JSON.parse(readFileSync(path.join(root, '.local/e2e-fixture.json'), 'utf8'));
const mailpit = process.env.SRD_MAILPIT_URL || 'http://127.0.0.1:8025';
const senderKey = process.env.SRD_CHAT_SENDER_KEY || 'registrar';
const receiverKey = process.env.SRD_CHAT_RECEIVER_KEY || 'viewer';
const contactNames = { admin: 'Admin', registrar: 'Registrar', treasurer: 'Treasurer', auditor: 'Auditor', viewer: 'Viewer', superadmin: 'Superadmin' };

function simplePdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    '<< /Length 43 >>\nstream\nBT /F1 12 Tf 30 100 Td (SRD test PDF) Tj ET\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let content = '%PDF-1.4\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(content, 'ascii'));
    content += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(content, 'ascii');
  content += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) content += `${String(offset).padStart(10, '0')} 00000 n \n`;
  content += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(content, 'ascii');
}

async function login(page, request, email) {
  const inbox = async () => (await (await request.get(`${mailpit}/api/v1/messages`)).json()).messages ?? [];
  const previous = new Set((await inbox()).map(message => message.ID));
  await page.goto(`/j/${fixture.codeA || 'srd-e2e-a'}/login`);
  await page.getByLabel(/^(Correo electrónico|Email address)$/).fill(email);
  await page.getByLabel(/^(Contraseña|Password)$/).fill(fixture.password);
  await page.getByRole('button', { name: /^(términos y condiciones|terms and conditions)$/i }).click();
  await page.getByRole('button', { name: /^(Aceptar términos|Accept terms)$/ }).click();
  await page.getByRole('button', { name: /^(Ingresar|Sign in)$/ }).click();
  let mailId;
  await expect.poll(async () => {
    mailId = (await inbox()).find(message => !previous.has(message.ID)
      && message.To.some(to => to.Address === email))?.ID;
    return Boolean(mailId);
  }, { timeout: 30000 }).toBe(true);
  const mail = await (await request.get(`${mailpit}/api/v1/message/${mailId}`)).json();
  const code = mail.Text.match(/\b\d{6}\b/)?.[0];
  expect(code).toMatch(/^\d{6}$/);
  await page.getByLabel(/^(Código de verificación|Verification code)$/).fill(code);
  await page.getByRole('button', { name: /^(Confirmar código|Confirm code)$/ }).click();
  await expect(page.locator('.profile-trigger')).toBeVisible();
}

test('real antivirus scans all supported chat attachment formats downloaded by another member', async ({ page, request, browser }) => {
  test.setTimeout(180000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 360, height: 800 });
  await login(page, request, fixture.users[senderKey].email);
  const started = await page.evaluate(async userId => {
    const csrf = (await (await fetch('/api/v1/csrf')).json()).data.token;
    const response = await fetch('/api/v1/conversations', {
      method: 'POST', credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-TOKEN': csrf },
      body: JSON.stringify({ user_id: userId }),
    });
    return { status: response.status, body: await response.json() };
  }, fixture.users[receiverKey].id);
  expect(started.status, JSON.stringify(started.body.error ?? {})).toBe(200);
  await page.getByRole('button', { name: /^(Abrir menú|Open menu)$/ }).click();
  await page.locator('.sidebar').getByRole('button', { name: 'Chat', exact: true }).click();
  await page.getByRole('region', { name: /^(Conversaciones|Conversations)$/ })
    .getByRole('button', { name: `Prueba ${contactNames[receiverKey]}` }).click();
  const panel = page.getByRole('region', { name: /^(Mensajes|Messages)$/ });
  const marker = `Prueba de antivirus SRD ${Date.now()}`;
  const filename = `srd-antivirus-${Date.now()}.png`;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAUSURBVBhXY/jPAEZA3AAk/zP8BwBEUQh5fHTJZQAAAABJRU5ErkJggg==', 'base64');
  await panel.getByLabel(/^(Mensaje|Message)$/).fill(marker);
  await panel.locator('input[type="file"]').setInputFiles({
    name: `srd-invalid-${Date.now()}.png`, mimeType: 'image/png', buffer: Buffer.from('not a PNG'),
  });
  const rejected = page.waitForResponse(response => response.request().method() === 'POST'
    && /\/api\/v1\/conversations\/[^/]+\/messages$/.test(new URL(response.url()).pathname));
  await panel.getByRole('button', { name: /^(Enviar|Send)$/ }).click();
  expect((await rejected).status()).toBe(422);
  await expect(panel.locator('form [role="alert"]')).toBeVisible();
  await page.waitForTimeout(17000);
  await expect(panel.locator('form [role="alert"]')).toBeVisible();
  await panel.locator('input[type="file"]').setInputFiles({ name: filename, mimeType: 'image/png', buffer: png });
  await expect(panel.locator('form [role="alert"]')).toHaveCount(0);
  await expect(panel.getByAltText(/^(Vista previa del adjunto|Attachment preview)$/)).toBeVisible();
  const submitted = page.waitForResponse(response => response.request().method() === 'POST'
    && /\/api\/v1\/conversations\/[^/]+\/messages$/.test(new URL(response.url()).pathname));
  await panel.getByRole('button', { name: /^(Enviar|Send)$/ }).click();
  const sendResponse = await submitted;
  expect(sendResponse.ok(), `Chat HTTP ${sendResponse.status()}: ${JSON.stringify(await sendResponse.json())}`).toBe(true);
  const sent = panel.locator('.chat-messages li').filter({ hasText: marker });
  await expect(sent).toBeVisible({ timeout: 45000 });
  await expect(sent.getByRole('button', { name: new RegExp(filename) })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  const audioMarker = `Nota WAV de prueba SRD ${Date.now()}`;
  const audioName = `srd-audio-${Date.now()}.wav`;
  const wav = Buffer.alloc(44 + 320);
  wav.write('RIFF', 0, 'ascii'); wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8, 'ascii'); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii'); wav.writeUInt32LE(320, 40);
  await panel.getByLabel(/^(Mensaje|Message)$/).fill(audioMarker);
  await panel.locator('input[type="file"]').setInputFiles({ name: audioName, mimeType: 'audio/wav', buffer: wav });
  const submittedAudio = page.waitForResponse(response => response.request().method() === 'POST'
    && /\/api\/v1\/conversations\/[^/]+\/messages$/.test(new URL(response.url()).pathname));
  await panel.getByRole('button', { name: /^(Enviar|Send)$/ }).click();
  const audioResponse = await submittedAudio;
  expect(audioResponse.ok(), `Chat WAV HTTP ${audioResponse.status()}: ${JSON.stringify(await audioResponse.json())}`).toBe(true);
  const sentAudio = panel.locator('.chat-messages li').filter({ hasText: audioMarker });
  await expect(sentAudio).toBeVisible({ timeout: 45000 });
  await expect(sentAudio.locator('.chat-voice-player')).toBeVisible();

  const pdfMarker = `PDF de prueba SRD ${Date.now()}`;
  const pdfName = `srd-documento-${Date.now()}.pdf`;
  const pdf = simplePdf();
  await panel.getByLabel(/^(Mensaje|Message)$/).fill(pdfMarker);
  await panel.locator('input[type="file"]').setInputFiles({ name: pdfName, mimeType: 'application/pdf', buffer: pdf });
  const submittedPdf = page.waitForResponse(response => response.request().method() === 'POST'
    && /\/api\/v1\/conversations\/[^/]+\/messages$/.test(new URL(response.url()).pathname));
  await panel.getByRole('button', { name: /^(Enviar|Send)$/ }).click();
  const pdfResponse = await submittedPdf;
  expect(pdfResponse.ok(), `Chat PDF HTTP ${pdfResponse.status()}: ${JSON.stringify(await pdfResponse.json())}`).toBe(true);
  const sentPdf = panel.locator('.chat-messages li').filter({ hasText: pdfMarker });
  await expect(sentPdf).toBeVisible({ timeout: 45000 });
  await expect(sentPdf.getByRole('button', { name: new RegExp(pdfName) })).toBeVisible();

  const officeAttachments = [];
  for (const extension of ['docx', 'xlsx']) {
    const marker = `${extension.toUpperCase()} de prueba SRD ${Date.now()}`;
    const name = `srd-documento-${Date.now()}.${extension}`;
    const content = readFileSync(path.join(root, `.local/office-fixture.${extension}`));
    const mimeType = extension === 'docx'
      ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    await panel.getByLabel(/^(Mensaje|Message)$/).fill(marker);
    await panel.locator('input[type="file"]').setInputFiles({ name, mimeType, buffer: content });
    const responsePromise = page.waitForResponse(response => response.request().method() === 'POST'
      && /\/api\/v1\/conversations\/[^/]+\/messages$/.test(new URL(response.url()).pathname));
    await panel.getByRole('button', { name: /^(Enviar|Send)$/ }).click();
    const response = await responsePromise;
    expect(response.ok(), `Chat ${extension} HTTP ${response.status()}: ${JSON.stringify(await response.json())}`).toBe(true);
    const sentOffice = panel.locator('.chat-messages li').filter({ hasText: marker });
    await expect(sentOffice.getByRole('button', { name: new RegExp(name) })).toBeVisible({ timeout: 45000 });
    officeAttachments.push({ marker, name, content });
  }

  const mp3Marker = `MP3 de prueba SRD ${Date.now()}`;
  const mp3Name = `srd-audio-${Date.now()}.mp3`;
  const mp3 = readFileSync(path.join(root, 'tools/browser-tests/silence.mp3'));
  await panel.getByLabel(/^(Mensaje|Message)$/).fill(mp3Marker);
  await panel.locator('input[type="file"]').setInputFiles({ name: mp3Name, mimeType: 'audio/mpeg', buffer: mp3 });
  const submittedMp3 = page.waitForResponse(response => response.request().method() === 'POST'
    && /\/api\/v1\/conversations\/[^/]+\/messages$/.test(new URL(response.url()).pathname));
  await panel.getByRole('button', { name: /^(Enviar|Send)$/ }).click();
  const mp3Response = await submittedMp3;
  expect(mp3Response.ok(), `Chat MP3 HTTP ${mp3Response.status()}: ${JSON.stringify(await mp3Response.json())}`).toBe(true);
  const sentMp3 = panel.locator('.chat-messages li').filter({ hasText: mp3Marker });
  await expect(sentMp3.locator('.chat-voice-player')).toBeVisible({ timeout: 45000 });

  const recipient = await browser.newContext({ baseURL: process.env.SRD_TEST_URL || 'http://127.0.0.1:8080', viewport: { width: 360, height: 800 }, acceptDownloads: true });
  try {
    const other = await recipient.newPage();
    other.on('pageerror', error => errors.push(error.message));
    await login(other, recipient.request, fixture.users[receiverKey].email);
    await other.getByRole('button', { name: /^(Abrir menú|Open menu)$/ }).click();
    await other.locator('.sidebar').getByRole('button', { name: 'Chat', exact: true }).click();
    await other.getByRole('region', { name: /^(Conversaciones|Conversations)$/ })
      .getByRole('button', { name: `Prueba ${contactNames[senderKey]}` }).click();
    const received = other.locator('.chat-messages li').filter({ hasText: marker });
    await expect(received).toBeVisible({ timeout: 30000 });
    const download = other.waitForEvent('download');
    await received.getByRole('button', { name: new RegExp(filename) }).click();
    await other.locator('.chat-image-toolbar').getByRole('button', { name: /^(Descargar|Download)$/ }).click();
    const file = await download;
    await other.getByRole('dialog').getByRole('button', { name: /^(Cerrar|Close)$/ }).click();
    expect(file.suggestedFilename()).toBe(filename);
    const chunks = [];
    for await (const chunk of await file.createReadStream()) chunks.push(chunk);
    expect(Buffer.concat(chunks).subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))).toBe(true);
    const receivedAudio = other.locator('.chat-messages li').filter({ hasText: audioMarker });
    await expect(receivedAudio).toBeVisible({ timeout: 30000 });
    await receivedAudio.getByRole('button', { name: /^(Reproducir nota de voz|Play voice note)$/ }).click();
    await expect(receivedAudio.locator('audio')).toHaveAttribute('src', /blob:/);
    const audioDownload = other.waitForEvent('download');
    await receivedAudio.locator('.chat-message-menu summary').click();
    await receivedAudio.getByRole('button', { name: /^(Descargar|Download)$/ }).click();
    const audioFile = await audioDownload;
    expect(audioFile.suggestedFilename()).toBe(audioName);
    const audioChunks = [];
    for await (const chunk of await audioFile.createReadStream()) audioChunks.push(chunk);
    const downloadedWav = Buffer.concat(audioChunks);
    expect(downloadedWav.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(downloadedWav.subarray(8, 12).toString('ascii')).toBe('WAVE');
    const receivedPdf = other.locator('.chat-messages li').filter({ hasText: pdfMarker });
    await expect(receivedPdf).toBeVisible({ timeout: 30000 });
    const pdfDownload = other.waitForEvent('download');
    await receivedPdf.getByRole('button', { name: new RegExp(pdfName) }).click();
    const pdfFile = await pdfDownload;
    expect(pdfFile.suggestedFilename()).toBe(pdfName);
    const pdfChunks = [];
    for await (const chunk of await pdfFile.createReadStream()) pdfChunks.push(chunk);
    expect(Buffer.concat(pdfChunks).equals(pdf)).toBe(true);
    for (const attachment of officeAttachments) {
      const receivedOffice = other.locator('.chat-messages li').filter({ hasText: attachment.marker });
      await expect(receivedOffice).toBeVisible({ timeout: 30000 });
      const officeDownload = other.waitForEvent('download');
      await receivedOffice.getByRole('button', { name: new RegExp(attachment.name) }).click();
      const officeFile = await officeDownload;
      expect(officeFile.suggestedFilename()).toBe(attachment.name);
      const officeChunks = [];
      for await (const chunk of await officeFile.createReadStream()) officeChunks.push(chunk);
      expect(Buffer.concat(officeChunks).equals(attachment.content)).toBe(true);
    }
    const receivedMp3 = other.locator('.chat-messages li').filter({ hasText: mp3Marker });
    await expect(receivedMp3).toBeVisible({ timeout: 30000 });
    await receivedMp3.getByRole('button', { name: /^(Reproducir nota de voz|Play voice note)$/ }).click();
    await expect(receivedMp3.locator('audio')).toHaveAttribute('src', /blob:/);
    const mp3Download = other.waitForEvent('download');
    await receivedMp3.locator('.chat-message-menu summary').click();
    await receivedMp3.getByRole('button', { name: /^(Descargar|Download)$/ }).click();
    const mp3File = await mp3Download;
    expect(mp3File.suggestedFilename()).toBe(mp3Name);
    const mp3Chunks = [];
    for await (const chunk of await mp3File.createReadStream()) mp3Chunks.push(chunk);
    const downloadedMp3 = Buffer.concat(mp3Chunks);
    expect(downloadedMp3.length).toBeLessThan(mp3.length);
    expect(downloadedMp3.subarray(0, 3).toString('ascii')).not.toBe('ID3');
    expect(downloadedMp3[0]).toBe(0xff);
    expect(await other.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await recipient.close(); }
  expect(errors).toEqual([]);
});
