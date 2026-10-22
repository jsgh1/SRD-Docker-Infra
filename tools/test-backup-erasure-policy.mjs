import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareErasureRows } from './backup-erasure-policy.mjs';

const org = '10000000-0000-4000-8000-000000000001';
const person = '20000000-0000-4000-8000-000000000002';
const tables = [
  ['srd_records', 'persons'],
  ['srd_files', 'person_photos'],
  ['srd_identity', 'memberships'],
  ['srd_identity', 'invitations'],
  ['srd_records', 'person_export_jobs'],
];
const hasColumn = () => true;

test('accepts a restore candidate without erased-person data', () => {
  assert.deepEqual(compareErasureRows([[org, person]], tables, () => '0', hasColumn), {
    status: 'compared', current_erasures: 1, conflicts: 0,
  });
});

for (const table of ['persons', 'person_photos', 'memberships', 'invitations', 'person_export_jobs']) {
  test(`rejects a candidate that recovers ${table}`, () => {
    assert.throws(() => compareErasureRows([[org, person]], tables,
      query => query.includes(`.${table} `) ? '1' : '0', hasColumn), /No es apta para restauracion/);
  });
}

test('fails closed on an invalid count or identifier', () => {
  assert.throws(() => compareErasureRows([[org, person]], tables, () => 'NaN', hasColumn), /conteo invalido/);
  assert.throws(() => compareErasureRows([[org, "x' OR 1=1"]], tables, () => '0', hasColumn), /Identificador/);
});
