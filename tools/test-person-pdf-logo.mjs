import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from '../apps/web/node_modules/esbuild/lib/main.js';
import pdfMake from '../apps/web/node_modules/pdfmake/build/pdfmake.js';
import fonts from '../apps/web/node_modules/pdfmake/build/vfs_fonts.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const logo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lZkAAAAASUVORK5CYII=';
pdfMake.addVirtualFileSystem(fonts);

async function loadDefinition(name) {
  const result = await esbuild.build({ entryPoints: [path.join(root, 'apps/web/src', name)],
    bundle: true, platform: 'node', format: 'esm', write: false, external: ['pdfmake/build/*'] });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);
}

const { personIndividualPdfDefinition } = await loadDefinition('PersonIndividualPdf.ts');
const { personExportPdfDefinition } = await loadDefinition('PersonExportPdf.ts');
const individual = { filename: 'ficha.pdf', date: '2026-10-13', count: 1, headers: ['Campo', 'Valor'],
  rows: Array.from({ length: 21 }, (_, index) => [`Campo ${index}`, `Valor ${index}`]) };
const list = { filename: 'personas.pdf', date: '2026-10-13', count: 1,
  headers: Array.from({ length: 12 }, (_, index) => `Columna ${index}`),
  rows: [Array.from({ length: 12 }, (_, index) => `Valor ${index}`)] };

for (const [label, make, data] of [
  ['individual', personIndividualPdfDefinition, individual],
  ['list', value => personExportPdfDefinition(value, 'Junta de prueba'), list],
]) {
  for (const withLogo of [false, true]) {
    const definition = make({ ...data, logo_data: withLogo ? logo : null });
    assert.equal(withLogo ? definition.content[0].columns[0].image : undefined, withLogo ? logo : undefined);
    const pdf = Buffer.from(await pdfMake.createPdf(definition).getBuffer());
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-', `${label} ${withLogo ? 'with' : 'without'} logo`);
    assert.equal(pdf.includes(Buffer.from('/Subtype /Image')), withLogo, `${label} image embedding`);
  }
  assert.throws(() => make({ ...data, logo_data: 'data:image/png;base64,invalid!' }), /formato válido/);
}

console.log('Person PDFs: list and individual render with and without logo; malformed logo rejected.');
