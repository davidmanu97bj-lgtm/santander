'use strict';

// This parser only understands explicitly named fields. Regional Uber exports
// differ: an unknown earnings column is never silently treated as gross fare.
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 2000;
const normalizeHeader = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const fields = {
  tripId: ['Trip UUID', 'Trip ID', 'UUID del viaje', 'UUID de viaje', 'ID del viaje', 'tripId'],
  uberDriverId: ['Driver UUID', 'Driver ID', 'UUID del conductor', 'UUID de conductor', 'ID del conductor', 'UUID del socio conductor', 'uberDriverId'],
  transactionId: ['Transaction UUID', 'Transaction ID', 'UUID de transacción', 'UUID de la transacción', 'ID de transacción', 'transactionId'],
  completedAt: ['Trip DropOff Time', 'Trip Drop Off Time', 'Dropoff time', 'Completed at', 'Fecha de finalización', 'Hora de finalización del viaje', 'Fecha y hora de finalización', 'completedAt'],
  status: ['Trip status', 'Estado del viaje', 'Estado', 'Status'],
  method: ['Payment type', 'Payment method', 'Método de pago', 'Tipo de pago', 'Forma de pago', 'method'],
  origin: ['Trip Pickup Address', 'Pickup address', 'Dirección de origen', 'Dirección de recogida', 'Origen', 'origin'],
  destination: ['Trip Drop Off Address', 'Trip Dropoff Address', 'Dropoff address', 'Dirección de destino', 'Destino', 'destination'],
  distanceKm: ['Trip distance', 'Trip distance (km)', 'Distance (km)', 'Distancia del viaje', 'Distancia del viaje (km)', 'Distancia (km)', 'distanceKm'],
  distanceUnit: ['Distance unit', 'Trip distance unit', 'Unidad de distancia', 'distanceUnit'],
  gross: ['Gross fare', 'Gross amount', 'Gross trip fare', 'Importe bruto', 'Tarifa bruta', 'Bruto del viaje', 'gross'],
  commission: ['Uber service fee', 'Uber commission', 'Service fee', 'Comisión Uber', 'Comisión de Uber', 'Tarifa de servicio de Uber', 'commission'],
  net: ['Net earnings', 'Net amount', 'Net fare', 'Ganancias netas', 'Importe neto', 'net'],
  currency: ['Currency', 'Currency code', 'Moneda', 'Código de moneda'],
  transactionType: ['Transaction type', 'Tipo de transacción', 'transactionType'],
  scope: ['Service scope', 'Alcance del servicio', 'Ámbito del servicio', 'scope'],
  paymentReceived: ['Payment received', 'Payment confirmed', 'Cobro confirmado', 'Pago recibido', 'paymentReceived'],
  cashCollected: ['Cash collected', 'Efectivo cobrado', 'Efectivo recaudado', 'cashCollected']
};
const aliases = new Map();
for (const [key, names] of Object.entries(fields)) for (const name of names) aliases.set(normalizeHeader(name), key);
const issue = (code, message, rowNumber) => ({code, message, ...(rowNumber ? {rowNumber} : {}), fatal: true});

function delimiterOf(text) {
  let quoted = false;
  const counts = {',': 0, ';': 0, '\t': 0};
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') i++;
      else quoted = !quoted;
    } else if (!quoted) {
      if (char === '\n' || char === '\r') break;
      if (Object.hasOwn(counts, char)) counts[char]++;
    }
  }
  const choices = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return choices[0][1] > 0 && choices[0][1] !== choices[1][1] ? choices[0][0] : null;
}

function parseFleetCsv(input, {kind = 'trips', maxBytes = MAX_BYTES, maxRows = MAX_ROWS} = {}) {
  const result = {rows: [], issues: [], headers: []};
  if (typeof input !== 'string') {
    result.issues.push(issue('csv_input_invalid', 'El CSV debe ser texto UTF-8.'));
    return result;
  }
  if (Buffer.byteLength(input, 'utf8') > Math.min(MAX_BYTES, maxBytes)) {
    result.issues.push(issue('csv_too_large', 'El archivo supera el límite de 2 MB.'));
    return result;
  }
  const text = input.replace(/^\uFEFF/, '');
  if (!text.trim()) {
    if (kind !== 'payments') result.issues.push(issue('csv_empty', 'Falta el CSV de viajes.'));
    return result;
  }
  if (text.includes('\0')) {
    result.issues.push(issue('csv_encoding_invalid', 'El CSV contiene caracteres nulos; exportalo como UTF-8.'));
    return result;
  }
  const delimiter = delimiterOf(text);
  if (!delimiter) {
    result.issues.push(issue('csv_delimiter_ambiguous', 'No se reconoce un separador único: usá coma, punto y coma o tabulador.'));
    return result;
  }
  const records = [];
  let row = [], value = '', quoted = false, closed = false, rowNumber = 1, startRow = 1;
  function finishRow() {
    row.push(value);
    if (row.some(cell => cell.trim())) records.push({values: row, rowNumber: startRow});
    row = []; value = ''; closed = false;
  }
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {value += '"'; i++;}
        else {quoted = false; closed = true;}
      } else {value += char; if (char === '\n') rowNumber++;}
    } else if (char === '"') {
      if (value || closed) {result.issues.push(issue('csv_malformed', 'Comillas inesperadas en el CSV.', rowNumber)); return result;}
      quoted = true;
    } else if (char === delimiter) {
      row.push(value); value = ''; closed = false;
    } else if (char === '\n' || char === '\r') {
      finishRow();
      if (char === '\r' && text[i + 1] === '\n') i++;
      rowNumber++; startRow = rowNumber;
    } else if (closed) {
      if (!/[ \t]/.test(char)) {result.issues.push(issue('csv_malformed', 'Hay contenido después de una celda entre comillas.', rowNumber)); return result;}
    } else value += char;
    if (records.length > Math.min(MAX_ROWS, maxRows) + 1 || row.length > 300) {
      result.issues.push(issue('csv_too_many_rows', 'El CSV supera 2000 filas o 300 columnas.'));
      return result;
    }
  }
  if (quoted) {result.issues.push(issue('csv_malformed', 'Hay una celda con comillas sin cerrar.', rowNumber)); return result;}
  if (value || row.length || closed) finishRow();
  if (!records.length) {result.issues.push(issue('csv_empty', 'El CSV no contiene encabezados.')); return result;}
  result.headers = records.shift().values.map(cell => cell.trim());
  if (records.length > Math.min(MAX_ROWS, maxRows)) {result.issues.push(issue('csv_too_many_rows', 'El CSV supera 2000 filas.')); return result;}
  const seen = new Set(), mapped = new Set();
  const columns = result.headers.map(header => {
    const normalized = normalizeHeader(header), key = aliases.get(normalized);
    if (!normalized || seen.has(normalized) || (key && mapped.has(key))) result.issues.push(issue('csv_ambiguous_headers', 'Hay encabezados vacíos, repetidos o dos columnas para el mismo dato.'));
    seen.add(normalized); if (key) mapped.add(key);
    return key;
  });
  for (const required of kind === 'payments' ? ['tripId', 'transactionId'] : ['tripId']) {
    if (!mapped.has(required)) result.issues.push(issue('csv_missing_header', `Falta la columna ${required === 'tripId' ? 'Trip UUID / UUID del viaje' : 'Transaction UUID / UUID de transacción'}. Usá el modelo CSV disponible.`));
  }
  if (result.issues.length) return result;
  for (const record of records) {
    if (record.values.length !== result.headers.length) {
      result.issues.push(issue('csv_column_count', 'La cantidad de celdas no coincide con los encabezados.', record.rowNumber));
      result.rows = []; return result;
    }
    const data = Object.fromEntries(Object.keys(fields).map(key => [key, '']));
    record.values.forEach((cell, index) => {if (columns[index]) data[columns[index]] = cell.trim();});
    if (!data.distanceUnit && result.headers.some((header, index) => columns[index] === 'distanceKm' && /km$/.test(normalizeHeader(header)))) data.distanceUnit = 'km';
    result.rows.push({rowNumber: record.rowNumber, data});
  }
  return result;
}

function parseMoneyCents(raw) {
  if (typeof raw !== 'string' && typeof raw !== 'number') return {value: null, issue: 'missing_amount'};
  let text = String(raw).trim();
  if (!text) return {value: null, issue: 'missing_amount'};
  text = text.replace(/^(?:ARS\s*\$?|\$)\s*/i, '').replace(/\s*ARS$/i, '').trim();
  if (!/^-?\d+(?:[.,]\d+)*$/.test(text)) return {value: null, issue: 'invalid_amount'};
  const negative = text.startsWith('-');
  if (negative) text = text.slice(1);
  let whole = text, decimal = '';
  const dots = (text.match(/\./g) || []).length, commas = (text.match(/,/g) || []).length;
  if (dots && commas) {
    const last = Math.max(text.lastIndexOf('.'), text.lastIndexOf(','));
    const separator = text[last], grouping = separator === '.' ? ',' : '.';
    decimal = text.slice(last + 1); whole = text.slice(0, last);
    if (!/^\d{1,2}$/.test(decimal) || !new RegExp('^\\d{1,3}(?:\\' + grouping + '\\d{3})+$').test(whole)) return {value: null, issue: 'ambiguous_amount'};
    whole = whole.split(grouping).join('');
  } else if (dots || commas) {
    const separator = dots ? '.' : ',', parts = text.split(separator);
    if (parts.length === 2) {
      if (!/^\d{1,2}$/.test(parts[1])) return {value: null, issue: 'ambiguous_amount'};
      [whole, decimal] = parts;
    } else {
      if (!/^\d{1,3}$/.test(parts[0]) || !parts.slice(1).every(part => /^\d{3}$/.test(part))) return {value: null, issue: 'ambiguous_amount'};
      whole = parts.join('');
    }
  }
  const cents = Number(whole) * 100 + Number(decimal.padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? {value: negative ? -cents : cents, issue: null} : {value: null, issue: 'amount_out_of_range'};
}

function parseTimestamp(raw) {
  const text = String(raw || '').trim();
  if (!text) return {value: null, issue: 'missing_date'};
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/);
  if (!match) return {value: null, issue: 'ambiguous_date'};
  const [, y, m, d, h, minute, second = '00', , offset] = match;
  const calendar = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  const offsetHour = offset === 'Z' ? 0 : Number(offset.slice(1, 3));
  const offsetMinute = offset === 'Z' ? 0 : Number(offset.slice(4));
  if (Number(y) < 2000 || Number(y) > 2100 || calendar.getUTCFullYear() !== Number(y) || calendar.getUTCMonth() + 1 !== Number(m) || calendar.getUTCDate() !== Number(d) || Number(h) > 23 || Number(minute) > 59 || Number(second) > 59 || offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) return {value: null, issue: 'invalid_date'};
  const value = Date.parse(text.replace(' ', 'T'));
  return Number.isFinite(value) ? {value: new Date(value).toISOString(), issue: null} : {value: null, issue: 'invalid_date'};
}

function parseDistanceKm(raw) {
  const text = String(raw || '').trim();
  if (!text) return {value: null, issue: 'missing_distance'};
  if (!/^\d+(?:[.,]\d{1,3})?$/.test(text)) return {value: null, issue: 'invalid_distance'};
  // A lone group of three digits is indistinguishable from a thousands marker.
  if (/^[1-9]\d{0,2}[.,]\d{3}$/.test(text)) return {value: null, issue: 'ambiguous_distance'};
  const value = Number(text.replace(',', '.'));
  return Number.isFinite(value) && value > 0 && value <= 20000 ? {value, issue: null} : {value: null, issue: 'invalid_distance'};
}

const MINIMUM_TRIPS_CSV = 'Trip UUID,Driver UUID,Trip DropOff Time,Trip Status,Payment Type,Trip Pickup Address,Trip Drop Off Address,Trip Distance (km),Gross fare,Uber service fee,Net earnings,Currency,Service scope,Payment received\n11111111-1111-4111-8111-111111111111,22222222-2222-4222-8222-222222222222,2026-09-28T12:00:00-03:00,completed,cash,Origen sintético,Destino sintético,12.5,10000.00,0.00,10000.00,ARS,national,true\n';
const MINIMUM_PAYMENTS_CSV = 'Transaction UUID,Trip UUID,Driver UUID,Transaction type,Gross fare,Uber service fee,Net earnings,Currency\n33333333-3333-4333-8333-333333333333,11111111-1111-4111-8111-111111111111,22222222-2222-4222-8222-222222222222,trip,10000.00,0.00,10000.00,ARS\n';

module.exports = {parseFleetCsv, parseMoneyCents, parseTimestamp, parseDistanceKm, normalizeHeader, MINIMUM_TRIPS_CSV, MINIMUM_PAYMENTS_CSV, MAX_BYTES, MAX_ROWS};
