import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REMIS_NUMBERS,
  exitDocId,
  chargesByRemisToday,
  buildOpsBoard
} from '../ops-salidas.js';

test('REMIS_NUMBERS coincide con el set operativo aprobado', () => {
  assert.deepEqual([...REMIS_NUMBERS], [28, 57, 104, 31, 43, 154, 15, 134]);
});

test('exitDocId es estable por día y número', () => {
  assert.equal(exitDocId('2026-09-22', 57), '2026-09-22_57');
});

test('chargesByRemisToday ignora viaje privado y cruza solo por remisNumber', () => {
  const map = chargesByRemisToday([
    { id: 'a', dayKey: '2026-09-22', remisNumber: 57, createdAtMs: 1000 },
    { id: 'b', dayKey: '2026-09-22', remisNumber: 57, createdAtMs: 500 },
    { id: 'c', dayKey: '2026-09-22', remisNumber: 28, viajePrivado: true, createdAtMs: 100 },
    { id: 'd', dayKey: '2026-09-21', remisNumber: 104, createdAtMs: 100 }
  ], '2026-09-22');
  assert.equal(map.get(57).paymentId, 'b');
  assert.equal(map.has(28), false);
  assert.equal(map.has(104), false);
});

test('buildOpsBoard no usa adjudicación: libre / salió sin cobro / matched', () => {
  const board = buildOpsBoard({
    dayKey: '2026-09-22',
    exits: [
      { dayKey: '2026-09-22', remisNumber: 104, active: true, markedAtMs: Date.parse('2026-09-22T21:40:00-03:00') },
      { dayKey: '2026-09-22', remisNumber: 57, active: true, markedAtMs: Date.parse('2026-09-22T22:05:00-03:00') }
    ],
    payments: [
      { id: 'p1', dayKey: '2026-09-22', remisNumber: 57, createdAtMs: Date.parse('2026-09-22T22:12:00-03:00') }
    ]
  });
  const by = Object.fromEntries(board.rows.map(r => [r.remisNumber, r]));
  assert.equal(by[104].status, 'missing_charge');
  assert.equal(by[104].chargeLabel, 'NO');
  assert.equal(by[57].status, 'matched');
  assert.equal(by[57].chargeLabel, 'SÍ');
  assert.equal(by[28].status, 'free');
  assert.equal(board.summary.exited, 2);
  assert.equal(board.summary.withoutCharge, 1);
  assert.equal(board.summary.free, 6);
});
