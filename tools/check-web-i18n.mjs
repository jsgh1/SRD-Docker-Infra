import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'apps/web/package.json'));
const ts = require('typescript');
const src = path.join(root, 'apps/web/src');
const dictionary = ts.createSourceFile('i18n.ts', fs.readFileSync(path.join(src, 'i18n.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
const keys = new Set();
const duplicates = [];

function visitDictionary(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(dictionary) === 'english'
    && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
    for (const property of node.initializer.properties) {
      if (ts.isPropertyAssignment(property) && (ts.isStringLiteral(property.name) || ts.isNoSubstitutionTemplateLiteral(property.name))) {
        if (keys.has(property.name.text)) duplicates.push(property.name.text);
        keys.add(property.name.text);
      }
    }
  }
  ts.forEachChild(node, visitDictionary);
}
visitDictionary(dictionary);

const usages = new Map();
const rawCopy = [];
for (const name of fs.readdirSync(src).filter(name => /\.(tsx?|jsx?)$/.test(name) && name !== 'i18n.ts')) {
  const file = ts.createSourceFile(name, fs.readFileSync(path.join(src, name), 'utf8'), ts.ScriptTarget.Latest, true,
    name.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  function visit(node) {
    if (ts.isJsxText(node)) {
      const value = node.getText(file).trim().replace(/\s+/g, ' ');
      if (value !== 'SRD' && /[A-Za-zÁÉÍÓÚáéíóúÑñ]{3}/.test(value)) {
        rawCopy.push(`${name}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1} ${JSON.stringify(value)}`);
      }
    }
    if (ts.isJsxAttribute(node) && ['placeholder', 'title', 'aria-label', 'alt'].includes(node.name.text)
      && node.initializer && ts.isStringLiteral(node.initializer)) {
      if (node.initializer.text && !/^(?:[0-9.]+)$/.test(node.initializer.text)) {
        rawCopy.push(`${name}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1} ${node.name.text}=${JSON.stringify(node.initializer.text)}`);
      }
    }
    if (ts.isCallExpression(node) && node.expression.getText(file) === 't' && node.arguments.length > 0) {
      const value = node.arguments[0];
      if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
        const location = file.getLineAndCharacterOfPosition(value.getStart(file));
        const places = usages.get(value.text) ?? [];
        places.push(`${name}:${location.line + 1}`);
        usages.set(value.text, places);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
}

const missing = [...usages].filter(([key]) => !keys.has(key)).sort(([a], [b]) => a.localeCompare(b, 'es'));
console.log(`${keys.size} traducciones, ${usages.size} claves literales de interfaz; ${missing.length} sin entrada inglesa.`);
for (const [key, places] of missing) console.log(`${JSON.stringify(key)} ${places[0]}${places.length > 1 ? ` (+${places.length - 1})` : ''}`);
for (const key of duplicates) console.log(`Clave duplicada: ${JSON.stringify(key)}`);
console.log(`${rawCopy.length} textos visibles sin t(...), excluidos nombres de marca, decoraciones y valores numéricos.`);
for (const item of rawCopy) console.log(item);
if (missing.length || duplicates.length || rawCopy.length) process.exitCode = 1;
