import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from '../apps/web/node_modules/typescript/lib/typescript.js';

const source = fs.readFileSync(new URL('../apps/web/src/calendar-state.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { calendarState } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const start = Date.parse('2026-10-01T12:00:00Z'), end = start + 3600000;
const event = { starts_at: new Date(start).toISOString(), ends_at: new Date(end).toISOString(), cancelled_at: null, state: 'scheduled' };
for (const [now, expected] of [
  [start - 86400001, 'scheduled'], [start - 86400000, 'upcoming'],
  [start - 1, 'upcoming'], [start, 'in_progress'],
  [end - 1, 'in_progress'], [end, 'finished'], [end + 1, 'finished'],
]) assert.equal(calendarState(event, now), expected);
assert.equal(calendarState({ ...event, cancelled_at: event.starts_at }, start), 'cancelled');
assert.equal(calendarState({ ...event, state: 'cancelled' }, end), 'cancelled');
assert.equal(calendarState({ ...event, starts_at: 'invalid', state: 'upcoming' }, start), 'upcoming');
assert.equal(calendarState(event, start - 86400001), 'scheduled');
assert.equal(event.state, 'scheduled');
console.log('Estados de Calendario: 12 aserciones aprobadas.');
