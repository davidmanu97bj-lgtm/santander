import test from 'node:test';
import assert from 'node:assert/strict';
import {
  monthlyChargeMonth, monthlyChargeConcept, monthlyChargeType, monthlyChargeId,
  monthlyChargesForDriver, commitMonthlyExpense
} from '../admin-monthly-charges.js';
import {MemoryStore} from '../tools/preview/memory-store.mjs';

const month = '2026-10';
const stamp = Date.parse('2026-10-15T12:00:00Z');
const expense = (id, expenseType = 'canon', extra = {}) => ({
  id, driverUid: 'driver-1', expenseType, expensePaymentMethod: 'digital',
  amount: 120000, status: 'active', createdAtMs: stamp, ...extra
});
const reminders = rows => monthlyChargesForDriver(rows, 'driver-1', month);

test('el mes cambia a medianoche de Iguazú, también al cambiar de año', () => {
  assert.equal(monthlyChargeMonth(Date.parse('2026-10-01T02:59:59.999Z')), '2026-09');
  assert.equal(monthlyChargeMonth(Date.parse('2026-10-01T03:00:00.000Z')), '2026-10');
  assert.equal(monthlyChargeMonth(Date.parse('2027-01-01T02:59:59.999Z')), '2026-12');
  assert.equal(monthlyChargeMonth(Date.parse('2027-01-01T03:00:00.000Z')), '2027-01');
  assert.equal(monthlyChargeMonth(new Date('2026-10-01T03:00:00Z')), month);
  assert.equal(monthlyChargeMonth(NaN), '');
  assert.equal(monthlyChargeMonth(null), '');
});

test('cada concepto ofrece las dos responsabilidades sin confundir otros gastos', () => {
  for (const [concept, split, type] of [
    ['canon', 'shared', 'canon_compartido'], ['canon', 'driver', 'canon'],
    ['patente', 'shared', 'patente'], ['patente', 'driver', 'patente_chofer']
  ]) {
    assert.equal(monthlyChargeType(concept, split), type);
    assert.equal(monthlyChargeConcept(type), concept);
  }
  assert.equal(monthlyChargeConcept('prestamo'), '');
  assert.equal(monthlyChargeConcept('Canon de octubre'), '');
  assert.equal(monthlyChargeType('canon', 'explora'), '');
  assert.equal(monthlyChargeType('combustible', 'shared'), '');
});

test('faltan dos cargas independientes y sólo se completa el concepto guardado', () => {
  assert.deepEqual(reminders([]), {month, missing: ['canon', 'patente'], completed: [], duplicates: []});
  const canon = expense('canon');
  assert.deepEqual(reminders([canon]), {month, missing: ['patente'], completed: ['canon'], duplicates: []});
  assert.deepEqual(reminders([expense('patente', 'patente')]), {month, missing: ['canon'], completed: ['patente'], duplicates: []});
  assert.deepEqual(reminders([canon, expense('patente', 'patente_chofer')]), {month, missing: [], completed: ['canon', 'patente'], duplicates: []});
  assert.deepEqual(monthlyChargesForDriver([canon], 'driver-1', '2026-11').missing, ['canon', 'patente']);
});

test('un mes explícito prevalece sobre la fecha de carga y sobre detalles libres', () => {
  const october = expense('october', 'canon', {expenseMonth: month, createdAtMs: Date.parse('2026-11-02T12:00:00Z')});
  assert.deepEqual(reminders([october]).completed, ['canon']);
  for (const expenseMonth of ['2026-09', '2026-11', 'octubre', '2026-13', '']) {
    assert.deepEqual(reminders([expense('other-month', 'canon', {expenseMonth})]).missing, ['canon', 'patente']);
  }
  assert.deepEqual(reminders([expense('free-text', 'prestamo', {detail: 'Canon y patente 2026-10'})]).missing, ['canon', 'patente']);
});

test('los cargos existentes infieren el mes desde sus fechas estructuradas', () => {
  for (const dates of [
    {createdAtMs: stamp},
    {createdAtMs: undefined, createdAt: {toMillis: () => stamp}},
    {createdAtMs: undefined, createdAt: {seconds: stamp / 1000}},
    {createdAtMs: undefined, createdAt: {_seconds: stamp / 1000, _nanoseconds: 0}},
    {createdAtMs: undefined, createdAt: new Date(stamp)},
    {createdAtMs: undefined, createdAt: '2026-10-15T12:00:00Z'},
    {createdAtMs: undefined, dayKey: '2026-10-01'}
  ]) assert.deepEqual(reminders([expense('legacy', 'canon', dates)]).completed, ['canon']);
  assert.deepEqual(reminders([expense('utc-boundary', 'canon', {createdAtMs: Date.parse('2026-10-01T02:30:00Z'), dayKey: '2026-10-01'})]).completed, []);
  assert.deepEqual(reminders([expense('server-boundary', 'canon', {createdAt: {seconds: Date.parse('2026-10-01T02:30:00Z') / 1000}, createdAtMs: stamp})]).completed, []);
  for (const dayKey of ['2026-02-31', '2026-10-32', 'octubre']) {
    assert.deepEqual(reminders([expense('bad-day', 'canon', {createdAtMs: undefined, dayKey})]).completed, []);
  }
  assert.deepEqual(reminders([expense('no-date', 'canon', {createdAtMs: undefined, detail: 'Octubre 2026-10'})]).completed, []);
});

test('el recordatorio pertenece al chofer explícito, no al administrador que cargó', () => {
  const rows = [expense('other', 'canon', {driverUid: 'driver-2', createdByUid: 'driver-1'})];
  assert.deepEqual(reminders(rows).completed, []);
  assert.deepEqual(monthlyChargesForDriver(rows, 'driver-2', month).completed, ['canon']);
  assert.deepEqual(reminders([expense('alias', 'canon', {driverUid: undefined, choferUid: 'driver-1'})]).completed, ['canon']);
  assert.deepEqual(reminders([expense('only-author', 'canon', {driverUid: undefined, createdByUid: 'driver-1'})]).completed, []);
  assert.deepEqual(monthlyChargesForDriver([expense('resolved', 'canon', {driverUid: 'legacy'})], 'driver-1', month, row => row.driverUid === 'legacy' ? 'driver-1' : row.driverUid).completed, ['canon']);
});

test('una carga sin comprobante completa el concepto y los gastos en efectivo no lo completan', () => {
  assert.deepEqual(reminders([expense('waived', 'canon', {receiptWaived: true, proofUrl: '', receiptUrl: ''})]).completed, ['canon']);
  assert.deepEqual(reminders([expense('cash', 'canon', {expensePaymentMethod: 'cash'})]).completed, []);
});

test('anular, rechazar o eliminar una carga vuelve a mostrar el recordatorio', () => {
  for (const inactive of [
    {status: 'cancelled'}, {status: 'canceled'}, {status: 'deleted'}, {estado: 'anulado'},
    {reviewStatus: 'rejected'}, {status: 'active', reviewStatus: 'rechazado'},
    {deleted: true}, {isDeleted: true}, {eliminado: true}, {deletedAt: {seconds: 123}},
    {deletedAtMs: stamp}, {active: false}, {activo: false}, {status: 'draft'}
  ]) assert.deepEqual(reminders([expense('inactive', 'canon', inactive)]).missing, ['canon', 'patente']);
});

test('detecta duplicados por concepto sin contar dos veces el mismo documento', () => {
  const row = expense('same');
  assert.deepEqual(reminders([row, {...row}]).duplicates, []);
  assert.deepEqual(reminders([row, expense('second', 'canon_compartido'), expense('deleted', 'patente', {deleted: true})]).duplicates, ['canon']);
});

test('los gastos simulados nunca completan un recordatorio real', () => {
  for (const simulation of [{isSimulated: true}, {createdBySimulation: true}, {verificationMode: 'simulation'}]) {
    assert.deepEqual(reminders([expense('simulation', 'canon', simulation)]).missing, ['canon', 'patente']);
  }
});

test('calcular recordatorios no crea montos, deudas ni mutaciones', () => {
  const row = Object.freeze(expense('prior', 'canon', {expenseMonth: '2026-09'}));
  const rows = Object.freeze([row]);
  assert.deepEqual(reminders(rows), {month, missing: ['canon', 'patente'], completed: [], duplicates: []});
  assert.equal(rows.length, 1);
  assert.equal(row.amount, 120000);
  assert.equal(Object.hasOwn(reminders(rows), 'amount'), false);
});

test('la referencia de unicidad separa chofer, mes y concepto, y no contiene barras', () => {
  const id = monthlyChargeId('driver/a%20', month, 'canon');
  assert.equal(id, 'monthly_driver%2Fa%2520_2026-10_canon');
  assert.equal(id.includes('/'), false);
  assert.notEqual(id, monthlyChargeId('driver/a%20', month, 'patente'));
  assert.notEqual(id, monthlyChargeId('driver/a%20', '2026-11', 'canon'));
  assert.notEqual(id, monthlyChargeId('driver/b', month, 'canon'));
  assert.throws(() => monthlyChargeId('', month, 'canon'));
  assert.throws(() => monthlyChargeId('driver', '2026-13', 'canon'));
  assert.throws(() => monthlyChargeId('driver', month, 'prestamo'));
});

function fixture(store, operationId, concept = 'canon') {
  const fingerprint = `fingerprint-${operationId}`;
  return {
    expenseRef: store.collection('gastos').doc(operationId),
    guardRef: store.collection('admin_audit').doc(monthlyChargeId('driver-1', month, concept)),
    payload: {...expense(operationId, concept), expenseMonth: month, idempotencyKey: operationId, submissionFingerprint: fingerprint},
    operationId, fingerprint,
    expenseRefById: id => store.collection('gastos').doc(id),
    guardData: {driverUid: 'driver-1', expenseMonth: month, concept}
  };
}
const save = (store, args) => store.runTransaction(tx => commitMonthlyExpense({tx, ...args}));

test('dos administradores concurrentes sólo pueden registrar un gasto por concepto y mes', async () => {
  const store = new MemoryStore();
  const results = await Promise.allSettled([save(store, fixture(store, 'first')), save(store, fixture(store, 'second'))]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'monthly-charge-exists');
  assert.deepEqual([...store.data.keys()].filter(key => key.startsWith('gastos/')), ['gastos/first']);
  await save(store, fixture(store, 'patente', 'patente'));
  assert.equal([...store.data.keys()].filter(key => key.startsWith('gastos/')).length, 2);
});

test('reintentar la misma operación no escribe de nuevo y cambiar sus datos falla', async () => {
  const store = new MemoryStore(), args = fixture(store, 'retry');
  assert.deepEqual(await save(store, args), {id: 'retry', duplicate: false});
  const original = store.data.get('gastos/retry');
  assert.deepEqual(await save(store, args), {id: 'retry', duplicate: true});
  assert.equal(store.data.get('gastos/retry'), original);
  await assert.rejects(save(store, {...args, fingerprint: 'changed', payload: {...args.payload, submissionFingerprint: 'changed'}}), {code: 'monthly-charge-conflict'});
});

test('reemplazar un gasto anulado conserva su historia y cambia la referencia', async () => {
  for (const status of ['cancelled', 'deleted', 'rejected']) {
    const store = new MemoryStore();
    const original = fixture(store, 'original');
    await save(store, original);
    store.data.set('gastos/original', {...store.data.get('gastos/original'), status});
    assert.deepEqual(reminders([store.data.get('gastos/original')]).missing, ['canon', 'patente']);
    await save(store, fixture(store, 'replacement'));
    assert.equal(store.data.get('gastos/original').status, status);
    assert.equal(store.data.get(original.guardRef.path).expenseId, 'replacement');
    assert.deepEqual(reminders([...store.data].filter(([path]) => path.startsWith('gastos/')).map(([, row]) => row)).completed, ['canon']);
  }
});

test('una transacción fallida no deja gasto ni marca de cumplimiento', async () => {
  const store = new MemoryStore(), args = fixture(store, 'failed');
  await assert.rejects(store.runTransaction(async tx => {
    await commitMonthlyExpense({tx, ...args});
    throw new Error('write failed');
  }), /write failed/);
  assert.equal(store.data.size, 0);
  assert.deepEqual(reminders([]).missing, ['canon', 'patente']);
});

test('las lecturas preceden a todas las escrituras y admite snapshots del SDK web', async () => {
  const store = new MemoryStore(), first = fixture(store, 'first');
  await save(store, first);
  store.data.set('gastos/first', {...store.data.get('gastos/first'), deleted: true});
  const events = [];
  await store.runTransaction(tx => commitMonthlyExpense({
    ...fixture(store, 'replacement'),
    tx: {
      async get(ref) { events.push('read'); const snap = await tx.get(ref); return {...snap, exists: () => snap.exists}; },
      set(ref, row) { events.push('write'); tx.set(ref, row); }
    }
  }));
  assert.deepEqual(events, ['read', 'read', 'read', 'write', 'write']);
});
