import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const directory = fs.realpathSync(process.argv[2]);
const allowed = fs.realpathSync(path.join(root, '.local/browser-runs')) + path.sep;
if (!directory.startsWith(allowed)) throw new Error('Los informes deben pertenecer a esta ejecución local.');
const files = fs.readdirSync(directory).filter(file => file.endsWith('.spec.mjs.json')).sort();
if (!files.length || files.length !== Number(process.argv[3])) throw new Error('Falta un informe de prueba.');
const reports = files.map(file => JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8')));
for (const report of reports) if (!report.stats || !Array.isArray(report.suites) || !Array.isArray(report.errors)) throw new Error('Informe incompleto.');
const merged = { ...reports[0], suites: reports.flatMap(report => report.suites), errors: reports.flatMap(report => report.errors), stats: {
  startTime: reports.map(report => report.stats.startTime).sort()[0],
  ...Object.fromEntries(['duration', 'expected', 'skipped', 'unexpected', 'flaky'].map(key => [key, reports.reduce((sum, report) => sum + report.stats[key], 0)])),
} };
fs.writeFileSync(path.join(root, '.local/browser-results.json'), JSON.stringify(merged, null, 2));
console.log(`Navegador: ${merged.stats.expected} aprobados, ${merged.stats.unexpected} fallidos, ${merged.stats.skipped} omitidos. Informes separados en ${path.relative(root, directory)}.`);
