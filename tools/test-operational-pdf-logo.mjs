import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import esbuild from '../apps/web/node_modules/esbuild/lib/main.js';
import pdfMake from '../apps/web/node_modules/pdfmake/build/pdfmake.js';
import fonts from '../apps/web/node_modules/pdfmake/build/vfs_fonts.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const logo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lZkAAAAASUVORK5CYII=';
const base = { filename: 'reporte.pdf', date: '2026-10-13', count: 0, rows: [] };
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.document = { documentElement: { lang: 'es' } };
globalThis.window = { addEventListener: () => {} };
pdfMake.addVirtualFileSystem(fonts);

async function load(name) {
  const outfile = path.join(root, 'apps/web/node_modules/.cache/srd-pdf-smoke', name.replace('.ts', '.mjs'));
  await esbuild.build({ entryPoints: [path.join(root, 'apps/web/src', name)], outfile,
    bundle: true, platform: 'node', format: 'esm', external: ['pdfmake/build/*', 'react'] });
  return import(pathToFileURL(outfile).href);
}

const receipt = { id: '11111111-1111-4111-8111-111111111111', number: 1, receipt: 'TES-000001',
  kind: 'income', sign: 1, amount: '1.00', balance_after: '1.00', effective_date: '2026-10-13',
  concept: 'Aporte', support_note: null, actor_name: 'Persona de prueba', actor_id: '22222222-2222-4222-8222-222222222222',
  reverses_id: null, created_at: '2026-10-13T12:00:00Z' };
const cases = [
  ['AuditExportPdf.ts', 'auditExportPdfDefinition', { ...base, headers: Array(8).fill('Columna') }],
  ['InventoryExportPdf.ts', 'inventoryExportPdfDefinition', { ...base, headers: Array(14).fill('Columna') }],
  ['InventoryHistoryPdf.ts', 'inventoryHistoryPdfDefinition', { ...base, headers: Array(11).fill('Columna') }],
  ['TreasuryHistoryPdf.ts', 'treasuryHistoryPdfDefinition', { ...base, headers: Array(12).fill('Columna') }],
  ['TreasuryReceiptPdf.ts', 'treasuryReceiptPdfDefinition', receipt],
];

for (const [file, functionName, data] of cases) {
  const make = (await load(file))[functionName];
  for (const withLogo of [false, true]) {
    const definition = make(data, 'Junta de prueba', withLogo ? logo : null);
    assert.equal(withLogo ? definition.content[0].image : undefined, withLogo ? logo : undefined);
    const pdf = Buffer.from(await pdfMake.createPdf(definition).getBuffer());
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-', file);
    assert.equal(pdf.includes(Buffer.from('/Subtype /Image')), withLogo, `${file} image embedding`);
  }
  assert.throws(() => make(data, 'Junta de prueba', 'data:image/png;base64,invalid!'), /formato PNG válido/);
}

console.log('Operational PDFs: five formats render with and without logo; malformed logo rejected.');
