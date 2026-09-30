'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {parseFleetCsv, parseMoneyCents, parseTimestamp, parseDistanceKm, MINIMUM_TRIPS_CSV, MINIMUM_PAYMENTS_CSV} = require('../uber-fleet-csv');

test('CSV mínimos explícitos: columnas de viajes y pagos permanecen separadas', () => {
  const trips = parseFleetCsv(MINIMUM_TRIPS_CSV);
  const payments = parseFleetCsv(MINIMUM_PAYMENTS_CSV, {kind: 'payments'});
  assert.deepEqual(trips.issues, []); assert.deepEqual(payments.issues, []);
  assert.equal(trips.rows[0].data.gross, '10000.00');
  assert.equal(trips.rows[0].data.distanceUnit, 'km');
  assert.equal(payments.rows[0].data.transactionId, '33333333-3333-4333-8333-333333333333');
});

test('CSV admite BOM, CRLF, acentos, punto y coma, comillas y saltos dentro de dirección', () => {
  const text = '\uFEFFUUID del viaje;UUID del conductor;Dirección de origen;Dirección de destino;Importe bruto\r\nv1;c1;"Calle; 12\nPiso ""A""";Destino;"1.234,50"\r\n';
  const result = parseFleetCsv(text);
  assert.deepEqual(result.issues, []);
  assert.equal(result.rows[0].rowNumber, 2);
  assert.equal(result.rows[0].data.origin, 'Calle; 12\nPiso "A"');
  assert.equal(result.rows[0].data.gross, '1.234,50');
  assert.equal(parseFleetCsv('Trip UUID\tDriver UUID\nv1\td1').rows[0].data.uberDriverId, 'd1');
});

test('columnas Earnings y Payouts oficiales nunca se interpretan como bruto ni neto', () => {
  const result = parseFleetCsv('Transaction UUID,Trip UUID,Earnings,Payouts\nx1,v1,10000,8000', {kind: 'payments'});
  assert.equal(result.rows[0].data.gross, ''); assert.equal(result.rows[0].data.net, '');
  assert.equal(parseFleetCsv('Trip UUID,Trip distance\nv1,10').rows[0].data.distanceUnit, '');
});

test('CSV ambiguo o malformado falla sin filas parciales', () => {
  for (const text of ['Trip UUID,Trip ID\na,b', 'Trip UUID,Trip UUID\na,a', 'Trip UUID,\na,b', 'Driver UUID,Gross fare\na,10', 'Trip UUID,Driver UUID\na', 'Trip UUID,Driver UUID\na,"b', 'Trip UUID,Driver UUID\na,"b"x', 'Trip UUID,Driver UUID\na,b"c', 'Trip UUID,Driver UUID\na,\0']) {
    const result = parseFleetCsv(text);
    assert.equal(result.rows.length, 0, text); assert.ok(result.issues.some(item => item.fatal), text);
  }
  assert.equal(parseFleetCsv('Trip UUID,Driver UUID\nv1,d1', {kind: 'payments'}).issues[0].code, 'csv_missing_header');
});

test('límites de bytes y filas se aplican antes de devolver datos', () => {
  assert.equal(parseFleetCsv('x'.repeat(2 * 1024 * 1024 + 1)).issues[0].code, 'csv_too_large');
  const text = 'Trip UUID,Driver UUID\n' + Array.from({length: 2001}, (_, i) => `v${i},d1`).join('\n');
  assert.equal(parseFleetCsv(text).issues[0].code, 'csv_too_many_rows');
  assert.equal(parseFleetCsv('').issues[0].code, 'csv_empty');
  assert.deepEqual(parseFleetCsv('', {kind: 'payments'}).issues, []);
});

test('importes a centavos exactos y formatos regionales explícitos', () => {
  for (const [input, expected] of [['10000', 1000000], ['10000.25', 1000025], ['10000,25', 1000025], ['1.234,56', 123456], ['1,234.56', 123456], ['ARS $ 100.50', 10050], ['-12,50', -1250], ['0', 0], ['0.1', 10], ['1,000,000', 100000000]]) {
    assert.deepEqual(parseMoneyCents(input), {value: expected, issue: null}, input);
  }
  for (const input of ['1.000', '1,000', '1,234,56', '1.234.56', '1.234,567', 'NaN', '1e3', 'Infinity', 'USD 10', '', '9007199254740992']) {
    assert.equal(parseMoneyCents(input).value, null, input); assert.ok(parseMoneyCents(input).issue, input);
  }
});

test('fecha inequívoca con zona y calendario válido; no inventa año, zona ni día regional', () => {
  assert.equal(parseTimestamp('2026-09-28T12:30:00-03:00').value, '2026-09-28T15:30:00.000Z');
  assert.equal(parseTimestamp('2026-09-28 15:30Z').value, '2026-09-28T15:30:00.000Z');
  for (const raw of ['09/10/2026', '2026-09-28', '2026-09-28T12:30:00', '2026-02-30T12:00:00Z', '2026-09-28T24:00:00Z', '2026-09-28T12:00:00+15:00']) assert.equal(parseTimestamp(raw).value, null, raw);
  assert.equal(parseTimestamp('2028-02-29T12:00:00Z').issue, null);
});

test('distancia explícita: no interpreta miles ni unidades escritas como kilómetros', () => {
  assert.equal(parseDistanceKm('12,5').value, 12.5);
  for (const raw of ['1.000', '1,000', '12 miles', '-1', '0', '1e3', '']) assert.equal(parseDistanceKm(raw).value, null, raw);
});
