'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {analyzeFleetImport, fleetTripId, CSV_TEMPLATES} = require('../uber-fleet-core');
const {parseFleetCsv} = require('../uber-fleet-csv');
const DRIVER = '22222222-2222-4222-8222-222222222222';
const TRIP = '11111111-1111-4111-8111-111111111111';
const NOW = Date.parse('2026-09-29T15:00:00Z');
const mapping = {[DRIVER]: {driverUid: 'driver-a', digitalRecipient: 'explora'}};
const headers = ['Trip UUID', 'Driver UUID', 'Trip DropOff Time', 'Trip Status', 'Payment Type', 'Trip Pickup Address', 'Trip Drop Off Address', 'Trip Distance (km)', 'Gross fare', 'Uber service fee', 'Net earnings', 'Currency', 'Service scope', 'Payment received'];
const base = [TRIP, DRIVER, '2026-09-28T12:00:00-03:00', 'completed', 'cash', 'Origen sintético', 'Destino sintético', '12.5', '10000.00', '0.00', '10000.00', 'ARS', 'national', 'true'];
const cell = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
function tripsCsv(changes = {}, more = []) {
  const row = [...base];
  for (const [key, value] of Object.entries(changes)) row[headers.indexOf(key)] = value;
  return headers.join(',') + '\n' + [row, ...more].map(values => values.map(cell).join(',')).join('\n');
}
const analyze = (changes = {}, options = {}) => analyzeFleetImport({fleetId: 'fleet-demo', tripsCsv: tripsCsv(changes), driverMappings: mapping, nowMs: NOW, ...options});
const codes = result => result.trips[0].issues.map(issue => issue.code);

test('proyección sobre bruto conserva 60% efectivo y -40% digital, sin efectos externos', () => {
  const cash = analyze();
  assert.equal(cash.trips[0].status, 'planned'); assert.equal(cash.trips[0].walletDeltaCents, 600000);
  const digital = analyze({'Payment Type': 'digital'});
  assert.equal(digital.trips[0].status, 'planned'); assert.equal(digital.trips[0].walletDeltaCents, -400000);
  for (const result of [cash, digital]) {
    assert.equal(result.summary.mode, 'shadow'); assert.equal(result.summary.planned, 1);
    assert.equal(result.trips[0].invoicePreview.isSimulated, true); assert.equal(result.trips[0].invoicePreview.emissionEnabled, false);
    assert.equal(result.trips[0].telegramPreview.isSimulated, true); assert.equal(result.trips[0].telegramPreview.sendEnabled, false);
    assert.equal(result.trips[0].invoiceRequest, undefined);
  }
});

test('reimportación idempotente por flota+viaje; cambios requieren revisión', () => {
  const first = analyze().trips[0];
  const replay = analyze({}, {existingTrips: [first]});
  assert.equal(replay.trips[0].status, 'unchanged'); assert.equal(replay.summary.grossCents, 0);
  const modified = analyze({'Gross fare': '12000', 'Net earnings': '12000'}, {existingTrips: [first]});
  assert.equal(modified.trips[0].id, first.id); assert.ok(codes(modified).includes('source_changed'));
  assert.notEqual(fleetTripId('another-fleet', TRIP), first.id);
});

test('mapeo y fecha de análisis no cambian sourceHash; corregir mapeo reevalúa', () => {
  const missing = analyze({}, {driverMappings: {}}).trips[0];
  assert.equal(missing.status, 'review');
  const corrected = analyze({}, {existingTrips: [missing], nowMs: NOW + 1000}).trips[0];
  assert.equal(corrected.sourceHash, missing.sourceHash); assert.equal(corrected.status, 'planned');
  const remapped = analyze({}, {existingTrips: [corrected], driverMappings: {[DRIVER]: {driverUid: 'driver-b', digitalRecipient: 'explora'}}}).trips[0];
  assert.equal(remapped.sourceHash, corrected.sourceHash); assert.equal(remapped.driverUid, 'driver-b'); assert.equal(remapped.status, 'planned');
});

test('filas repetidas idénticas cuentan una vez; filas contradictorias quedan en revisión', () => {
  const repeated = analyze({}, {tripsCsv: tripsCsv({}, [base])});
  assert.equal(repeated.trips.length, 1); assert.equal(repeated.summary.duplicateRows, 1); assert.equal(repeated.summary.grossCents, 1000000);
  const changed = [...base]; changed[8] = '12000';
  const conflict = analyze({}, {tripsCsv: tripsCsv({}, [changed])});
  assert.ok(codes(conflict).includes('duplicate_trip_conflict')); assert.equal(conflict.trips[0].walletDeltaCents, null);
});

test('hash canónico no depende de formato decimal, moneda minúscula ni zona ISO equivalente', () => {
  const a = analyze().trips[0];
  const b = analyze({'Gross fare': '10000,00', 'Net earnings': '10.000,00', 'Uber service fee': '0', 'Currency': 'ars', 'Trip DropOff Time': '2026-09-28T15:00:00Z'}).trips[0];
  assert.equal(a.sourceHash, b.sourceHash);
});

test('pagos se correlacionan por ambos UUID y no suman una transacción repetida', () => {
  const lines = CSV_TEMPLATES.payments.trim().split('\n');
  const result = analyze({}, {paymentsCsv: lines.concat(lines[1]).join('\n')});
  assert.equal(result.trips[0].status, 'planned'); assert.equal(result.trips[0].source.transactionIds.length, 1); assert.equal(result.summary.duplicateRows, 1);
  const conflict = analyze({}, {paymentsCsv: lines.concat(lines[1].replace('10000.00', '12000.00')).join('\n')});
  assert.ok(codes(conflict).includes('transaction_conflict'));
});

test('bruto puede venir del pago explícito pero nunca de Earnings, Payouts o neto', () => {
  const payment = analyze({'Gross fare': ''}, {paymentsCsv: CSV_TEMPLATES.payments});
  assert.equal(payment.trips[0].amountCents, 1000000); assert.equal(payment.trips[0].status, 'planned');
  const missing = analyze({'Gross fare': ''}, {paymentsCsv: `Transaction UUID,Trip UUID,Earnings,Payouts\nt1,${TRIP},10000,8000`});
  assert.ok(codes(missing).includes('missing_gross')); assert.equal(missing.trips[0].amountCents, null);
});

test('pagos adicionales y propinas no se convierten en nuevas ventas', () => {
  const lines = CSV_TEMPLATES.payments.trim().split('\n');
  const extra = lines[1].replace('33333333-3333-4333-8333-333333333333', 'another-transaction').replace(',trip,', ',tip,');
  const result = analyze({}, {paymentsCsv: lines.concat(extra).join('\n')});
  assert.equal(result.trips.length, 1); assert.ok(codes(result).includes('transaction_type_requires_review')); assert.ok(codes(result).includes('multiple_payments_require_review'));
  const orphan = analyze({}, {paymentsCsv: lines[0] + '\n' + lines[1].replace(TRIP, 'other-trip')});
  assert.equal(orphan.summary.unlinkedPayments, 1); assert.equal(orphan.issues[0].code, 'payment_without_trip');
});

test('faltantes y datos ambiguos permanecen pendientes, sin default monetario o temporal', () => {
  for (const [field, value, code] of [['Gross fare', '1.000', 'gross_ambiguous_amount'], ['Trip DropOff Time', '09/10/2026', 'ambiguous_date'], ['Currency', '', 'missing_currency'], ['Currency', 'USD', 'unsupported_currency'], ['Trip Status', '', 'missing_status'], ['Trip Status', 'cancelled', 'trip_not_completed'], ['Trip Pickup Address', '', 'missing_route'], ['Trip Distance (km)', '', 'missing_distance'], ['Service scope', '', 'scope_requires_review'], ['Uber service fee', '', 'missing_commission'], ['Net earnings', '', 'missing_net'], ['Payment Type', '', 'missing_method']]) {
    const result = analyze({[field]: value});
    assert.equal(result.trips[0].status, 'review', field); assert.ok(codes(result).includes(code), field); assert.equal(result.trips[0].walletDeltaCents, null, field);
  }
});

test('comisiones, neto incongruente y cobros no confirmados requieren revisión', () => {
  const commission = analyze({'Uber service fee': '-2000', 'Net earnings': '8000'});
  assert.ok(codes(commission).includes('commission_policy_required')); assert.equal(commission.trips[0].commissionCents, 200000); assert.equal(commission.trips[0].walletDeltaCents, null);
  assert.equal(commission.trips[0].grossWalletDeltaCents, 600000);
  assert.ok(codes(analyze({'Net earnings': '8000'})).includes('gross_net_mismatch'));
  assert.ok(codes(analyze({'Payment received': ''})).includes('payment_receipt_unconfirmed'));
  for (const recipient of ['unknown', 'driver']) assert.ok(codes(analyze({'Payment Type': 'digital'}, {driverMappings: {[DRIVER]: {driverUid: 'driver-a', digitalRecipient: recipient}}})).includes('digital_recipient_requires_review'));
});

test('Cash Collected explícito confirma efectivo; no reemplaza bruto ni confirma digital', () => {
  const csv = tripsCsv({'Payment received': ''}).split('\n');
  const input = csv[0] + ',Cash Collected\n' + csv[1] + ',10000.00';
  assert.equal(analyze({}, {tripsCsv: input}).trips[0].status, 'planned');
  assert.ok(codes(analyze({}, {tripsCsv: input.replace(',10000.00', ',8000.00')})).includes('cash_collected_mismatch'));
});

test('no se interpreta distancia de reporte sin unidad confirmada', () => {
  const result = analyze({}, {tripsCsv: tripsCsv().replace('Trip Distance (km)', 'Trip Distance')});
  assert.ok(codes(result).includes('distance_unit_requires_review'));
});

test('solapamiento semanal y cobro real bloquean segunda contabilización', () => {
  const row = {driverUid: 'driver-a', weekStartDate: '2026-09-28', weekCloseDate: '2026-10-05', status: 'completed'};
  assert.ok(codes(analyze({}, {weeklyClosures: [row]})).includes('weekly_closure_overlap'));
  assert.equal(analyze({}, {weeklyClosures: [{...row, deleted: true}]}).trips[0].status, 'planned');
  assert.ok(codes(analyze({}, {existingPayments: [{id: 'manual-id', source: {provider: 'uber_fleet', fleetId: 'fleet-demo', tripId: TRIP}}]})).includes('already_posted'));
});

test('coincidencia con cobro manual es revisión, nunca deduplicación automática por importe', () => {
  const manual = {id: 'manual', driverUid: 'driver-a', type: 'billing', amount: 10000, invoiceRequest: {serviceDate: '2026-09-28'}};
  const possible = analyze({}, {existingPayments: [manual]});
  assert.ok(codes(possible).includes('possible_manual_duplicate')); assert.equal(possible.trips[0].status, 'review');
  assert.equal(analyze({}, {existingPayments: [{...manual, amount: 9999}]}).trips[0].status, 'planned');
  assert.equal(analyze({}, {existingPayments: [{...manual, driverUid: 'another'}]}).trips[0].status, 'planned');
  assert.equal(analyze({}, {existingPayments: [{...manual, isSimulated: true}]}).trips[0].status, 'planned');
});

test('UUID transacción contradictorio también bloquea si el primer pago era huérfano', () => {
  const lines = CSV_TEMPLATES.payments.trim().split('\n');
  const result = analyze({}, {paymentsCsv: [lines[0], lines[1].replace(TRIP, 'other-trip'), lines[1]].join('\n')});
  assert.ok(codes(result).includes('transaction_conflict')); assert.equal(result.trips[0].status, 'review');
});

test('Transaction UUID de una importación anterior no puede reasignarse a otro viaje', () => {
  const previous = analyze({}, {paymentsCsv: CSV_TEMPLATES.payments}).trips[0];
  const nextId = 'other-trip';
  const reused = analyze({'Trip UUID': nextId}, {paymentsCsv: CSV_TEMPLATES.payments.replace(TRIP, nextId), existingTrips: [previous]});
  assert.ok(codes(reused).includes('transaction_already_linked'));
  assert.equal(reused.trips[0].status, 'review'); assert.equal(reused.trips[0].walletDeltaCents, null);
  assert.equal(analyze({}, {paymentsCsv: CSV_TEMPLATES.payments, existingTrips: [previous]}).trips[0].status, 'unchanged');
  const otherFleet = {...previous, source: {...previous.source, fleetId: 'other-fleet'}};
  assert.equal(analyze({'Trip UUID': nextId}, {paymentsCsv: CSV_TEMPLATES.payments.replace(TRIP, nextId), existingTrips: [otherFleet]}).trips[0].status, 'planned');
});

test('nacional mayor de 100 km requiere revisión fiscal explícita', () => {
  assert.equal(analyze({'Trip Distance (km)': '100'}).trips[0].status, 'planned');
  const longer = analyze({'Trip Distance (km)': '100.01'});
  assert.ok(codes(longer).includes('national_distance_requires_fiscal_review'));
  assert.equal(longer.trips[0].status, 'review'); assert.equal(longer.trips[0].walletDeltaCents, null);
});

test('fechas semanales históricas válidas se concilian; intervalos incompletos quedan en revisión', () => {
  const owner = {driverUid: 'driver-a', status: 'completed'};
  for (const dates of [{weekStart: '2026-09-28', weekEnd: '2026-10-05'}, {weekStartMs: Date.parse('2026-09-28T00:00:00-03:00'), weekDisplayEndMs: Date.parse('2026-10-05T00:00:00-03:00')}]) {
    assert.ok(codes(analyze({}, {weeklyClosures: [{...owner, ...dates}]})).includes('weekly_closure_overlap'));
  }
  for (const dates of [{weekStart: '2026-09-28'}, {dayKey: '2026-09-28'}, {weekKey: '2026-W40'}, {weekStartDate: '2026-09-30', weekCloseDate: '2026-09-01'}, {weekStartDate: '2026-02-30', weekCloseDate: '2026-10-05'}]) {
    const result = analyze({}, {weeklyClosures: [{...owner, ...dates}]});
    assert.ok(codes(result).includes('weekly_closure_range_unknown'));
    assert.equal(result.trips[0].status, 'review'); assert.equal(result.trips[0].walletDeltaCents, null);
  }
  assert.equal(analyze({}, {weeklyClosures: [{...owner, weekStart: '2026-09-01', weekEnd: '2026-09-08'}]}).trips[0].status, 'planned');
  assert.equal(analyze({}, {weeklyClosures: [{...owner, driverUid: 'another-driver'}, {...owner, deleted: true}]}).trips[0].status, 'planned');
});

test('fecha futura, viaje viejo y pago con conductor distinto requieren revisión', () => {
  assert.ok(codes(analyze({'Trip DropOff Time': '2026-10-01T12:00:00-03:00'})).includes('future_trip'));
  assert.ok(codes(analyze({'Trip DropOff Time': '2026-08-01T12:00:00-03:00'})).includes('invoice_date_requires_review'));
  assert.ok(codes(analyze({}, {paymentsCsv: CSV_TEMPLATES.payments.replace(DRIVER, 'other-driver')})).includes('payment_driver_conflict'));
});

test('UUID ausente se conserva para revisión y los nombres no mapean choferes', () => {
  const missing = analyze({'Trip UUID': '', 'Driver UUID': ''}, {driverMappings: {'Nombre del chofer': {driverUid: 'driver-a'}}});
  assert.equal(missing.trips.length, 1); assert.equal(missing.trips[0].driverUid, null); assert.match(missing.trips[0].id, /^uber_review_/);
  assert.ok(codes(missing).includes('missing_trip_id')); assert.ok(codes(missing).includes('driver_unmapped'));
});

test('límites combinados, entrada inválida y encabezados incompletos fallan sin análisis parcial', () => {
  assert.equal(analyze({}, {fleetId: ''}).summary.inputRejected, true);
  assert.equal(analyze({}, {tripsCsv: 'x'.repeat(2 * 1024 * 1024), paymentsCsv: 'xx'}).summary.inputRejected, true);
  assert.equal(analyze({}, {tripsCsv: 'Driver UUID,Gross fare\na,10'}).summary.inputRejected, true);
  const many = 'Trip UUID,Driver UUID\n' + Array.from({length: 2000}, (_, i) => `trip${i},d1`).join('\n');
  assert.equal(analyze({}, {tripsCsv: many, paymentsCsv: CSV_TEMPLATES.payments}).issues[0].code, 'csv_too_many_rows');
});

test('analizador no muta mapeos ni contexto y conserva los modelos CSV públicos', () => {
  const options = {driverMappings: structuredClone(mapping), existingTrips: [], existingPayments: [], weeklyClosures: []};
  const before = structuredClone(options);
  analyze({}, options); assert.deepEqual(options, before);
  assert.equal(parseFleetCsv(CSV_TEMPLATES.trips).rows.length, 1);
});
