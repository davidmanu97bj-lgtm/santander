'use strict';

// Shadow analysis only. Deliberately no Firestore, fetch, ARCA or Telegram client.
const {createHash} = require('node:crypto');
const policy = require('./period-policy');
const csv = require('./uber-fleet-csv');
const PROVIDER = 'uber_fleet';
const VERSION = 'uber_fleet_shadow_net_v2';
const FLEET_NET_POLICY = 'uber_net_after_commission_cashbox_10_v1';
const CSV_TEMPLATES = Object.freeze({trips: csv.MINIMUM_TRIPS_CSV, payments: csv.MINIMUM_PAYMENTS_CSV});
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clean = value => String(value ?? '').trim();
const normalized = csv.normalizeHeader;
const validId = value => /^[a-zA-Z0-9_.:-]{1,180}$/.test(clean(value));
const addIssue = (issues, code, message, extra = {}) => {
  if (!issues.some(item => item.code === code && item.rowNumber === extra.rowNumber)) issues.push({code, message, ...extra});
};
const fleetTripId = (fleetId, tripId) => `uber_${hash([PROVIDER, clean(fleetId), clean(tripId)])}`;
const statusOf = value => ['completed', 'complete', 'finished', 'completado', 'finalizado', 'terminado', 'viajecompletado'].includes(normalized(value)) ? 'completed' : normalized(value);
function methodOf(value) {
  const method = normalized(value);
  if (['cash', 'efectivo'].includes(method)) return 'cash';
  if (['digital', 'card', 'creditcard', 'debitcard', 'tarjeta', 'tarjetadecredito', 'tarjetadedebito', 'transfer', 'transferencia', 'qr', 'noncash', 'nocash'].includes(method)) return 'digital';
  return null;
}
const scopeOf = value => ['national', 'nacional'].includes(normalized(value)) ? 'national' : ['international', 'internacional'].includes(normalized(value)) ? 'international' : null;
const receivedOf = value => ['true', 'yes', 'si', 'confirmed', 'confirmado', 'received', 'recibido', '1'].includes(normalized(value)) ? true : ['false', 'no', 'pending', 'pendiente', '0'].includes(normalized(value)) ? false : null;
const localDay = iso => new Date(Date.parse(iso) - 3 * 3600000).toISOString().slice(0, 10);

function closureDateKey(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < Date.UTC(2000, 0, 1) || value >= Date.UTC(2101, 0, 1)) return null;
    return localDay(new Date(value).toISOString());
  }
  const text = clean(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return csv.parseTimestamp(`${text}T12:00:00Z`).issue ? null : text;
  const parsed = csv.parseTimestamp(text);
  return parsed.issue ? null : localDay(parsed.value);
}

function weeklyClosureRange(row) {
  // Known legacy timestamp fields also appear in normalizeUberClosure(). An
  // isolated dayKey/weekKey is not enough to assume the full covered interval.
  const start = closureDateKey(row.weekStartDate || row.weekStart || row.weekStartMs);
  const close = closureDateKey(row.weekCloseDate || row.weekClose || row.weekEnd || row.weekDisplayEndMs);
  return start && close && close >= start ? {start, close} : null;
}

function canonicalRow(data) {
  const result = {};
  for (const key of Object.keys(data).sort()) {
    const raw = clean(data[key]);
    if (['gross', 'commission', 'net', 'cashCollected'].includes(key)) {
      const parsed = csv.parseMoneyCents(raw);
      result[key] = raw ? (parsed.issue ? {unparsed: raw} : parsed.value) : null;
    } else if (key === 'completedAt') {
      const parsed = csv.parseTimestamp(raw);
      result[key] = raw ? (parsed.issue ? {unparsed: raw} : parsed.value) : null;
    } else if (key === 'distanceKm') {
      const parsed = csv.parseDistanceKm(raw);
      result[key] = raw ? (parsed.issue ? {unparsed: raw} : parsed.value) : null;
    } else if (key === 'currency') result[key] = raw.toUpperCase();
    else if (key === 'method') result[key] = methodOf(raw) || normalized(raw);
    else if (key === 'status') result[key] = statusOf(raw);
    else if (key === 'scope') result[key] = scopeOf(raw) || normalized(raw);
    else if (key === 'paymentReceived') result[key] = raw ? (receivedOf(raw) ?? normalized(raw)) : null;
    else if (key === 'transactionType') result[key] = normalized(raw);
    else result[key] = raw;
  }
  return result;
}

function analyzeFleetImport({fleetId, tripsCsv, paymentsCsv = '', driverMappings = {}, existingTrips = [], existingPayments = [], weeklyClosures = [], nowMs = Date.now()} = {}) {
  const issues = [];
  const summary = {mode: 'shadow', version: VERSION, policyVersion: FLEET_NET_POLICY, basePolicyVersion: policy.VERSION, total: 0, planned: 0, review: 0, unchanged: 0, grossCents: 0, netCents: 0, commissionCents: 0, observedGrossCents: 0, cashCents: 0, digitalCents: 0, walletDeltaCents: 0, duplicateRows: 0, paymentRows: 0, unlinkedPayments: 0, inputRejected: false};
  const rejected = (code, message) => {issues.push({code, message, fatal: true}); summary.inputRejected = true; return {trips: [], summary, issues};};
  fleetId = clean(fleetId);
  if (!validId(fleetId)) return rejected('invalid_fleet_id', 'Ingresá el identificador de la flota de Uber, sin espacios ni rutas.');
  if (typeof tripsCsv !== 'string' || typeof paymentsCsv !== 'string') return rejected('csv_input_invalid', 'Los archivos de viajes y pagos deben ser texto CSV.');
  if (Buffer.byteLength(tripsCsv, 'utf8') + Buffer.byteLength(paymentsCsv, 'utf8') > csv.MAX_BYTES) return rejected('csv_too_large', 'Los dos archivos juntos no pueden superar 2 MB.');
  if (!Number.isFinite(nowMs)) return rejected('invalid_analysis_time', 'La fecha del análisis no es válida.');
  if (!driverMappings || typeof driverMappings !== 'object' || Array.isArray(driverMappings) || !Array.isArray(existingTrips) || !Array.isArray(existingPayments) || !Array.isArray(weeklyClosures)) return rejected('invalid_context', 'El mapeo de choferes o el contexto de conciliación no es válido.');
  const tripFile = csv.parseFleetCsv(tripsCsv, {kind: 'trips'});
  const paymentFile = csv.parseFleetCsv(paymentsCsv, {kind: 'payments'});
  issues.push(...tripFile.issues.map(item => ({...item, file: 'trips'})), ...paymentFile.issues.map(item => ({...item, file: 'payments'})));
  if (issues.some(item => item.fatal)) {summary.inputRejected = true; return {trips: [], summary, issues};}
  if (tripFile.rows.length + paymentFile.rows.length > csv.MAX_ROWS) return rejected('csv_too_many_rows', 'Los dos archivos juntos no pueden superar 2000 filas de datos.');
  summary.paymentRows = paymentFile.rows.length;

  const groups = new Map();
  for (const row of tripFile.rows) {
    const tripId = clean(row.data.tripId);
    const facts = canonicalRow(row.data), fingerprint = hash(facts);
    const key = tripId || `missing_${fingerprint}`;
    const group = groups.get(key);
    if (!group) groups.set(key, {tripId, row, facts, fingerprint, rows: [row.rowNumber], issues: []});
    else {
      group.rows.push(row.rowNumber); summary.duplicateRows++;
      if (group.fingerprint !== fingerprint) addIssue(group.issues, 'duplicate_trip_conflict', 'El mismo viaje tiene datos diferentes dentro del archivo.');
    }
  }

  const transactionRows = new Map(), paymentsByTrip = new Map();
  for (const row of paymentFile.rows) {
    const tripId = clean(row.data.tripId), transactionId = clean(row.data.transactionId);
    const fingerprint = hash(canonicalRow(row.data));
    const previous = transactionId && transactionRows.get(transactionId);
    if (previous) {
      summary.duplicateRows++;
      if (previous.fingerprint !== fingerprint) {
        for (const id of new Set([tripId, previous.tripId])) {
          const affected = groups.get(id);
          if (affected) addIssue(affected.issues, 'transaction_conflict', 'El mismo Transaction UUID tiene datos diferentes.');
        }
        addIssue(issues, 'transaction_conflict', 'Un Transaction UUID aparece con datos o viajes diferentes.', {transactionId});
      }
      continue;
    }
    if (transactionId) transactionRows.set(transactionId, {fingerprint, tripId});
    if (!groups.has(tripId)) {
      summary.unlinkedPayments++;
      addIssue(issues, 'payment_without_trip', 'Hay un pago sin viaje asociado en este archivo; queda pendiente de conciliación.', {rowNumber: row.rowNumber, transactionId, tripId});
      continue;
    }
    const list = paymentsByTrip.get(tripId) || [];
    const paymentIssues = groups.get(tripId).issues;
    if (!validId(transactionId)) addIssue(paymentIssues, 'missing_transaction_id', 'Un pago asociado no tiene un Transaction UUID válido.', {rowNumber: row.rowNumber});
    list.push(row); paymentsByTrip.set(tripId, list);
  }

  const existingById = new Map(existingTrips.filter(row => row && typeof row === 'object').map(row => [row.id, row]));
  const trips = [];
  for (const group of groups.values()) {
    const data = group.row.data, tripIssues = [...group.issues];
    const tripId = group.tripId, uberDriverId = clean(data.uberDriverId);
    const payments = paymentsByTrip.get(tripId) || [];
    const allRows = [group.row, ...payments];
    if (!validId(tripId)) addIssue(tripIssues, 'missing_trip_id', 'Falta un Trip UUID válido; no se puede identificar ni deduplicar este viaje.');
    if (!validId(uberDriverId)) addIssue(tripIssues, 'missing_driver_id', 'Falta el Driver UUID de Uber; los nombres no se usan para asociar choferes.');
    const mapping = Object.hasOwn(driverMappings, uberDriverId) ? driverMappings[uberDriverId] : null;
    const driverUid = mapping && validId(mapping.driverUid) ? clean(mapping.driverUid) : null;
    if (!driverUid) addIssue(tripIssues, 'driver_unmapped', 'Asociá el Driver UUID de Uber con un chofer de Explora.');
    for (const payment of payments) {
      if (payment.data.uberDriverId && payment.data.uberDriverId !== uberDriverId) addIssue(tripIssues, 'payment_driver_conflict', 'El pago y el viaje pertenecen a distintos Driver UUID.');
      const type = normalized(payment.data.transactionType);
      if (type && !['trip', 'fare', 'tripfare', 'viaje', 'tarifa', 'tarifadelviaje'].includes(type)) addIssue(tripIssues, 'transaction_type_requires_review', 'El pago incluye un ajuste, propina, liquidación u otro concepto que requiere revisión.');
    }
    if (payments.length > 1) addIssue(tripIssues, 'multiple_payments_require_review', 'Hay varias transacciones para el viaje; no se suman automáticamente como nuevas ventas.');

    function mergeField(field, parser, missingCode, message) {
      const values = [];
      for (const row of allRows) {
        if (!clean(row.data[field])) continue;
        const parsed = parser(row.data[field]);
        if (parsed.issue) addIssue(tripIssues, `${field}_${parsed.issue}`, `${message}: formato no válido o ambiguo.`, {rowNumber: row.rowNumber});
        else values.push(parsed.value);
      }
      if (!values.length && missingCode) addIssue(tripIssues, missingCode, `${message}: falta un dato explícito del reporte.`);
      if (new Set(values.map(value => JSON.stringify(value))).size > 1) addIssue(tripIssues, `${field}_conflict`, `${message}: los archivos contienen valores diferentes.`);
      return values[0] ?? null;
    }
    const amountCents = mergeField('gross', csv.parseMoneyCents, 'missing_gross', 'Importe bruto del viaje');
    const rawCommission = mergeField('commission', csv.parseMoneyCents, 'missing_commission', 'Comisión de Uber');
    const commissionCents = rawCommission === null ? null : Math.abs(rawCommission);
    const netCents = mergeField('net', csv.parseMoneyCents, 'missing_net', 'Importe neto liquidado');
    const currency = mergeField('currency', raw => ({value: clean(raw).toUpperCase(), issue: null}), 'missing_currency', 'Moneda');
    if (currency && currency !== 'ARS') addIssue(tripIssues, 'unsupported_currency', 'Sólo se analiza ARS; no se convierten otras monedas.');
    if (amountCents !== null && (amountCents <= 0 || amountCents > 10000000000)) addIssue(tripIssues, 'gross_out_of_range', 'El bruto debe ser positivo y no superar $100.000.000.');
    if (netCents !== null && netCents < 0) addIssue(tripIssues, 'negative_net', 'Un neto negativo requiere conciliar el ajuste.');
    if (amountCents !== null && commissionCents !== null && netCents !== null && amountCents - commissionCents !== netCents) addIssue(tripIssues, 'gross_net_mismatch', 'Bruto menos comisión no coincide con el neto; conciliá propinas, impuestos y ajustes.');

    const completed = csv.parseTimestamp(data.completedAt), completedAt = completed.value;
    if (completed.issue) addIssue(tripIssues, completed.issue, 'Falta una fecha de finalización ISO válida con zona horaria.');
    else if (Date.parse(completedAt) > nowMs) addIssue(tripIssues, 'future_trip', 'La finalización del viaje está en el futuro.');
    const tripStatus = statusOf(data.status);
    if (!tripStatus) addIssue(tripIssues, 'missing_status', 'Falta el estado explícito del viaje.');
    else if (tripStatus !== 'completed') addIssue(tripIssues, 'trip_not_completed', 'El viaje no está completado; se conserva pendiente sin proyectar un cobro.');
    const method = mergeField('method', raw => ({value: methodOf(raw), issue: methodOf(raw) ? null : 'unknown_method'}), 'missing_method', 'Método de pago');
    // Cash held by the driver can still be gross even though Uber reports net
    // earnings. A fee charged to the fleet and a fee paid by the driver create
    // different debts; the current reports do not establish which occurred.
    if (method === 'cash' && commissionCents > 0) addIssue(tripIssues, 'cash_commission_settlement_requires_review', 'El chofer recibe efectivo bruto. Falta corroborar si la comisión la pagó el chofer o se descontó de la cuenta de Explora; no se convierte el efectivo retenido en neto automáticamente.');
    const digitalRecipient = ['explora', 'driver', 'unknown'].includes(mapping?.digitalRecipient) ? mapping.digitalRecipient : 'unknown';
    if (method === 'digital' && digitalRecipient !== 'explora') addIssue(tripIssues, 'digital_recipient_requires_review', digitalRecipient === 'driver' ? 'El dinero digital lo recibe el chofer; la billetera digital actual representa dinero recibido por Explora.' : 'Falta confirmar quién recibe el dinero digital.');
    const confirmation = mergeField('paymentReceived', raw => ({value: receivedOf(raw), issue: receivedOf(raw) === null ? 'unknown_confirmation' : null}), null, 'Confirmación del cobro');
    const cashCollected = mergeField('cashCollected', csv.parseMoneyCents, null, 'Efectivo cobrado');
    const received = confirmation === true || (method === 'cash' && amountCents > 0 && cashCollected === amountCents);
    if (confirmation === false || !received) addIssue(tripIssues, 'payment_receipt_unconfirmed', 'El método o el destinatario no acreditan el cobro: falta confirmación explícita de recepción.');
    if (method === 'cash' && cashCollected !== null && cashCollected !== amountCents) addIssue(tripIssues, 'cash_collected_mismatch', 'El efectivo cobrado no coincide con el bruto del viaje.');

    const distance = csv.parseDistanceKm(data.distanceKm);
    const route = {origin: clean(data.origin) || null, destination: clean(data.destination) || null, distanceKm: distance.value};
    if (!route.origin || !route.destination) addIssue(tripIssues, 'missing_route', 'Falta origen o destino del reporte; no se inventa el recorrido.');
    if (distance.issue) addIssue(tripIssues, distance.issue, 'Falta una distancia explícita en kilómetros con formato inequívoco.');
    if (!['km', 'kilometers', 'kilometres', 'kilometros'].includes(normalized(data.distanceUnit))) addIssue(tripIssues, 'distance_unit_requires_review', 'El reporte no confirma que la distancia esté expresada en kilómetros.');
    const scope = scopeOf(data.scope);
    if (!scope) addIssue(tripIssues, 'scope_requires_review', 'Falta corroborar si el servicio es nacional o internacional.');
    else if (scope === 'international') addIssue(tripIssues, 'international_requires_review', 'El servicio internacional requiere revisión fiscal antes de cualquier emisión.');
    else if (route.distanceKm > 100) addIssue(tripIssues, 'national_distance_requires_fiscal_review', 'El servicio nacional supera 100 km; la política fiscal B actual requiere revisión y no se presupone su tratamiento.');
    if (completedAt && localDay(completedAt) < localDay(new Date(nowMs - 10 * 86400000).toISOString())) addIssue(tripIssues, 'invoice_date_requires_review', 'La fecha del servicio requiere revisión en el flujo fiscal actual.');

    const sourceFacts = {provider: PROVIDER, fleetId, trip: group.facts, payments: payments.map(row => canonicalRow(row.data)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))};
    const sourceHash = hash(sourceFacts);
    const id = validId(tripId) ? fleetTripId(fleetId, tripId) : `uber_review_${hash([fleetId, sourceHash])}`;
    const previous = existingById.get(id);
    if (previous && previous.sourceHash !== sourceHash) addIssue(tripIssues, 'source_changed', 'Este viaje ya fue analizado con datos distintos; revisá el cambio antes de reemplazarlo.');
    const transactionIds = new Set(payments.map(row => clean(row.data.transactionId)).filter(Boolean));
    const reusedTransaction = transactionIds.size > 0 && existingTrips.some(row => {
      if (!row || row.id === id || !Array.isArray(row.source?.transactionIds)) return false;
      const previousFleetId = clean(row.source?.fleetId || row.fleetId);
      const previousTripId = clean(row.source?.tripId || row.tripId);
      if (previousFleetId && previousFleetId !== fleetId) return false;
      if (previousTripId === tripId) return false;
      return row.source.transactionIds.some(transactionId => transactionIds.has(clean(transactionId)));
    });
    if (reusedTransaction) addIssue(tripIssues, 'transaction_already_linked', 'Un Transaction UUID ya está asociado a otro viaje importado; requiere conciliación antes de volver a utilizarlo.');
    const posted = existingPayments.some(row => row && (row.id === id || (
      clean(row.source?.fleetId || row.fleetId || row.uberFleetId) === fleetId &&
      clean(row.source?.tripId || row.tripId || row.uberTripId || row.externalTripId) === tripId &&
      [PROVIDER, 'uber'].includes(clean(row.source?.provider || row.provider || row.sourceProvider))
    )));
    if (posted) addIssue(tripIssues, 'already_posted', 'Existe un cobro real vinculado a este viaje; no se debe registrar otra vez.');
    if (driverUid && completedAt && amountCents > 0) {
      const day = localDay(completedAt);
      const possibleManualPayment = existingPayments.some(row => {
        if (!row || row.deleted || row.isDeleted || row.isSimulated || row.createdBySimulation || row.verificationMode === 'simulation' || /reject|rechaz|cancel|anulad|deleted/i.test(clean(row.status))) return false;
        if (clean(row.source?.tripId || row.tripId || row.uberTripId || row.externalTripId)) return false;
        if (row.type && !['billing', 'payment'].includes(row.type)) return false;
        if (clean(row.driverUid || row.choferUid || row.uid || row.driverId) !== driverUid) return false;
        const cents = Number.isSafeInteger(row.amountCents) ? row.amountCents : Math.round(Number(row.grossAmount ?? row.amount) * 100);
        if (cents !== amountCents) return false;
        const serviceDay = clean(row.invoiceRequest?.serviceDate || row.serviceDate || row.dayKey);
        if (/^\d{4}-\d{2}-\d{2}$/.test(serviceDay)) return serviceDay === day;
        const time = Number(row.createdAtMs || row.createdAt?.toMillis?.() || 0);
        return time > 0 && Number.isFinite(time) && localDay(new Date(time).toISOString()) === day;
      });
      if (possibleManualPayment) addIssue(tripIssues, 'possible_manual_duplicate', 'Hay un cobro manual del mismo chofer, fecha e importe. Puede corresponder a este viaje; requiere revisión, sin deduplicarlo automáticamente.');
    }
    if (completedAt && driverUid) {
      const day = localDay(completedAt);
      for (const row of weeklyClosures) {
        if (!row || row.deleted || row.isDeleted || /reject|rechaz|cancel|anulad|deleted/i.test(clean(row.reviewStatus || row.status)) || clean(row.driverUid || row.choferUid || row.uid || row.driverId) !== driverUid) continue;
        const range = weeklyClosureRange(row);
        if (!range) addIssue(tripIssues, 'weekly_closure_range_unknown', 'Hay una liquidación semanal de este chofer con fechas incompletas o ambiguas; no se puede descartar un solapamiento.');
        else if (day >= range.start && day <= range.close) addIssue(tripIssues, 'weekly_closure_overlap', 'Ya hay una liquidación semanal para este chofer y fecha; conciliá el solapamiento para no duplicar ingresos.');
      }
    }

    // Only Uber's reconciled net is the settlement base. Passenger fare and the
    // fiscal preview remain gross. This module never writes a real balance.
    const reconciledNet = Number.isSafeInteger(amountCents) && amountCents > 0 && amountCents <= 10000000000 &&
      Number.isSafeInteger(commissionCents) && Number.isSafeInteger(netCents) && netCents >= 0 && amountCents - commissionCents === netCents;
    const settlementBaseCents = reconciledNet ? netCents : null;
    const projectedDeltaCents = reconciledNet && currency === 'ARS' &&
      ((method === 'cash' && commissionCents === 0) || (method === 'digital' && digitalRecipient === 'explora'))
      ? Math.round(policy.chargeDelta(netCents / 100, method) * 100) : null;
    let status = tripIssues.length ? 'review' : 'planned';
    if (!tripIssues.length && previous?.sourceHash === sourceHash && previous.policyVersion === FLEET_NET_POLICY && ['planned', 'unchanged'].includes(previous.status) && previous.driverUid === driverUid && previous.walletDeltaCents === projectedDeltaCents) status = 'unchanged';
    const walletDeltaCents = status === 'review' ? null : projectedDeltaCents;
    const invoicePreview = {isSimulated: true, fiscalValidity: false, emissionEnabled: false, status: 'preparation_only', currency, amountCents, scope, serviceDate: completedAt ? localDay(completedAt) : null, route, customer: null, missingIssuerAndCustomerVerification: true};
    const amountLabel = amountCents === null ? 'pendiente' : `$ ${(amountCents / 100).toFixed(2)} ${currency || '(moneda pendiente)'}`;
    const netLabel = settlementBaseCents === null ? 'pendiente de conciliación' : `$ ${(settlementBaseCents / 100).toFixed(2)} ${currency || '(moneda pendiente)'}`;
    const telegramPreview = {isSimulated: true, sendEnabled: false, text: `PRUEBA PARALELA · Viaje Uber ${tripId || '(sin UUID)'}\nBruto: ${amountLabel}\nNeto tras comisión: ${netLabel}\n${route.origin || 'Origen pendiente'} → ${route.destination || 'Destino pendiente'}\nEstado: ${status === 'review' ? 'requiere revisión' : status === 'unchanged' ? 'sin cambios' : 'proyección disponible'}\nNo se registró un cobro ni se emitió una factura.`};
    const trip = {id, tripId: tripId || null, uberDriverId: uberDriverId || null, driverUid, status, issues: tripIssues, sourceHash, completedAt, amountCents, commissionCents, netCents, method, currency, settlementBaseCents, policyVersion: FLEET_NET_POLICY, walletDeltaCents, invoicePreview, telegramPreview, route,
      source: {provider: PROVIDER, fleetId, tripId: tripId || null, tripRow: group.row.rowNumber, tripRows: [...group.rows], paymentRows: payments.map(row => row.rowNumber), transactionIds: payments.map(row => row.data.transactionId).filter(Boolean).sort(), tripStatus, digitalRecipient, paymentReceived: received, version: VERSION}};
    trips.push(trip);
    summary.total++; summary[status]++;
    if (amountCents > 0 && Number.isSafeInteger(amountCents)) summary.observedGrossCents += amountCents;
    if (status === 'planned') {
      summary.grossCents += amountCents; summary.netCents += netCents; summary.commissionCents += commissionCents;
      summary[method === 'cash' ? 'cashCents' : 'digitalCents'] += amountCents; summary.walletDeltaCents += walletDeltaCents;
    }
  }
  return {trips, summary, issues};
}
module.exports = {analyzeFleetImport, fleetTripId, CSV_TEMPLATES, VERSION, FLEET_NET_POLICY};
