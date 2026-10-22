import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { seal, unseal, digest } from '../backup-codec.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const base = path.join(root, '.local');
fs.mkdirSync(base, { recursive: true });

test('authenticated backup codec roundtrip, corruption and destination safety', async t => {
  const directory = fs.mkdtempSync(path.join(base, 'backup-codec-test-'));
  const encrypted = path.join(directory, 'synthetic.enc'), output = path.join(directory, 'output');
  const key = randomBytes(32), content = Buffer.from('Entorno sintético\nINSERT INTO prueba VALUES ("niñez", "50%_!");\n');
  try {
    await seal(Readable.from([content.subarray(0, 7), content.subarray(7)]), encrypted, key);
    const original = fs.readFileSync(encrypted);
    assert.equal(original.includes(content), false);
    await unseal(encrypted, output, key);
    assert.deepEqual(fs.readFileSync(output), content);
    assert.match(await digest(encrypted), /^[a-f0-9]{64}$/);
    await assert.rejects(unseal(encrypted, output, key), { code: 'EEXIST' });
    assert.deepEqual(fs.readFileSync(output), content);
    fs.unlinkSync(output);
    await t.test('wrong key never leaves an authenticated payload', async () => {
      await assert.rejects(unseal(encrypted, output, randomBytes(32)));
      assert.equal(fs.existsSync(output), false);
    });
    for (const offset of [0, 10, 24, original.length - 1]) await t.test('tampering at ' + offset, async () => {
      const changed = Buffer.from(original); changed[offset] ^= 1; fs.writeFileSync(encrypted, changed);
      await assert.rejects(unseal(encrypted, output, key));
      assert.equal(fs.existsSync(output), false);
    });
    await t.test('truncation is rejected', async () => {
      fs.writeFileSync(encrypted, original.subarray(0, 30));
      await assert.rejects(unseal(encrypted, output, key));
      assert.equal(fs.existsSync(output), false);
    });
  } finally {
    const resolved = fs.realpathSync(directory);
    assert.ok(resolved.startsWith(fs.realpathSync(base) + path.sep));
    for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, name));
    fs.rmdirSync(directory);
  }
});
