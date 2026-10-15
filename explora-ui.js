// Shared visual vocabulary. This module does not calculate or persist money.
const paths = {
  cash: '<path d="M7 3h14v13M4 6h14v13"/><rect x="1" y="9" width="14" height="12" rx="1"/><circle cx="8" cy="15" r="2.5"/><path d="M2 12h1m9 0h2M2 18h1m9 0h2"/>',
  digital: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M15 15h1m2 0h1"/>',
  expense: '<path d="M5 2h10l5 5v15H5zM14 2v6h6M8 12h8M8 16h6M8 7h3"/>',
  debt: '<path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5m0 3v.5"/>',
  management: '<path d="M2 22h21M4 22V14h4v8m3 0V8h4v14m3 0V2h4v20"/>',
  home: '<path d="m3 10 9-8 9 8v11h-6v-7H9v7H3Z"/>',
  wallet: '<path d="M3 8 17 2l2 6M3 8h18v13H3zM21 12h-6v5h6M17 14.5h.1"/>',
  upload: '<path d="M8 22H4V2h10l6 6v5M14 2v6h6M14 23V13m-5 5 5-5 5 5"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M3 9h18M7 1v6m10-6v6M7 13h1m3 0h1m3 0h1M7 17h1m3 0h1m3 0h1"/>',
  arrow: '<path d="M3 12h18m-8-8 8 8-8 8"/>'
};
export function exploraIcon(kind) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[kind] || paths.management}</svg>`;
}
export function activityKind(item) {
  if (/debt/.test(item.type || '')) return 'debt';
  if (item.method === 'expense' || /expense/.test(item.type || '')) return 'expense';
  if (/settlement|compensation|debt|advance|cashbox/.test(item.type || '')) return 'management';
  return item.method === 'digital' ? 'digital' : item.method === 'cash' || item.method === 'uber' ? 'cash' : 'management';
}
export function escapeUi(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function receiptTimestamp(value) {
  if (value == null || value === '') return 0;
  const ms = typeof value?.toMillis === 'function' ? value.toMillis()
    : typeof value?.toDate === 'function' ? value.toDate().getTime()
    : value instanceof Date ? value.getTime()
    : typeof value === 'number' ? value
    : typeof value?.seconds === 'number' ? value.seconds * 1000 + (value.nanoseconds || 0) / 1e6
    : typeof value?._seconds === 'number' ? value._seconds * 1000 + (value._nanoseconds || 0) / 1e6
    : /^\d+(?:\.\d+)?$/.test(String(value)) ? Number(value) : Date.parse(value);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}
const receiptRaw = row => row.receiptCycleRecord || row;
const firstReceiptTime = values => values.map(receiptTimestamp).find(Boolean) || 0;
export function receiptRecordedAtMs(row = {}) {
  const raw = receiptRaw(row);
  // Registration defines the cycle: a backdated expense entered after a close
  // belongs to the new cycle; editing an old receipt never reopens it.
  return firstReceiptTime([raw.createdAt, raw.createdAtMs, raw.timestampMs,
    raw.completedAt, raw.completedAtMs, raw.receiptUploadedAt, raw.receiptUploadedAtMs,
    raw.expenseDate, raw.fechaISO, raw.date, raw.fecha, row.time]);
}
function completedReceiptClosure(row = {}) {
  const raw = receiptRaw(row);
  const tokens = [raw.status, raw.estado, raw.closureStatus, raw.reviewStatus, raw.paymentStatus,
    raw.receiptStatus, raw.rejectionReason, raw.rollbackStatus, raw.closureMode, raw.periodType]
    .map(value => String(value || '').trim().toLowerCase());
  if (raw.deleted || raw.isDeleted || raw.eliminado || raw.isSimulated || raw.createdBySimulation || raw.verificationMode === 'simulation' || raw.rejected || raw.rollbackRestored || raw.invalidatesCutoff || raw.cutoffActive === false ||
    tokens.some(value => /reject|rechaz|cancel|anulad|deleted|eliminad|borrad|partial|parcial|no aceptado/.test(value))) return false;
  const primaryStatus = String(raw.status || raw.estado || raw.closureStatus || '').toLowerCase();
  if (/pending|pendiente|awaiting|requested|solicit/.test(primaryStatus)) return false;
  const kind = String(raw.closureKind || raw.closureType || raw.payTab || raw.closeKind || raw.kind || raw.cierreTipo || raw.type || raw.category || raw.homeModule || raw.moduleKey || '').toLowerCase();
  if (/gasto|expense|caja|chica|cashbox|uber|deuda|debt|pendiente/.test(kind)) return false;
  const remainingKnown = raw._receiptCycleBalanceKnown !== false && raw.remainingAmount != null;
  if (remainingKnown && Number(raw.remainingAmount) > .5) return false;
  const finalStatuses = new Set(['completed','closed','paid','confirmed','completado','cerrado','pagado','confirmado','al_dia','al día']);
  return raw.completed === true || raw.closed === true || raw.paid === true || tokens.some(value => finalStatuses.has(value)) ||
    (tokens.includes('approved') && remainingKnown && Number(raw.remainingAmount) <= .5);
}
export function receiptCycle(closures = []) {
  const completed = closures.filter(completedReceiptClosure).map(receiptRaw);
  const cutoffAtMs = completed.reduce((latest, row) => Math.max(latest, firstReceiptTime([
    row.cutoffAtMs, row.cutoffAt, row.requestedAtMs, row.requestedAt, row.createdAtMs, row.createdAt,
    row.completedAtMs, row.completedAt, row.closedAtMs, row.closedAt, row.confirmedAtMs, row.confirmedAt
  ])), 0);
  const ids = fields => new Set(completed.flatMap(row => fields.flatMap(field => Array.isArray(row[field]) ? row[field] : row[field] ? [row[field]] : [])).map(String));
  return {cutoffAtMs, closureIds:ids(['id','closureId']),
    billingIds:ids(['includedBillingIds','includedBillingSettlementPaymentIds','paymentRecordId']),
    expenseIds:ids(['includedExpenseIds']), uberIds:ids(['includedUberIds','includedUberWeekIds']),
    debtIds:ids(['includedDebtIds'])};
}
export function currentCycleReceipts(rows = [], cycle = receiptCycle()) {
  if (!cycle.cutoffAtMs) return [...rows];
  return rows.filter(row => {
    const raw = receiptRaw(row), id = String(raw.id || ''), linkedClosure = String(raw.closureId || raw.periodClosureId || '');
    if (linkedClosure && cycle.closureIds.has(linkedClosure)) return false;
    const group = String(row._receiptGroupKey || '').split(':');
    const source = row.receiptCycleSource || group[0] || row.kind || row.method || '';
    const sourceId = group.length > 1 ? group.slice(1).join(':') : id;
    if (source === 'closure' && cycle.closureIds.has(id)) return false;
    if (['payment','billing','cash','digital'].includes(source) && cycle.billingIds.has(sourceId)) return false;
    if (source === 'expense' && cycle.expenseIds.has(sourceId)) return false;
    if (source === 'uber' && cycle.uberIds.has(sourceId)) return false;
    if (source === 'debt' && cycle.debtIds.has(sourceId)) return false;
    const time = receiptRecordedAtMs(row);
    // Keep undated legacy documents reviewable when their membership is unknown.
    return !time || time > cycle.cutoffAtMs;
  });
}
export function recentActivitiesMarkup(receipts, {money, timestamp, now = new Date(), periodStartedAt = 0}) {
  const entries = receipts.filter(item => !['cashbox_receipt','expense_reimbursement_receipt'].includes(item.type))
    .filter(item => item.migrationVersion !== 'opening_balance_20260918_v1')
    .filter(item => !periodStartedAt || timestamp(item) > periodStartedAt).slice(0,5);
  if (!entries.length) return `<div class="activity-empty">${periodStartedAt ? 'PERIODO NUEVO INICIADO, SIN ACTIVIDADES' : 'Todavía no hay movimientos. Tus próximas actividades aparecerán acá.'}</div>`;
  return entries.map(item => `<article class="activity-row">${activityRowContent(item,{money,timestamp,now})}</article>`).join('');
}
export function activityRowContent(item,{money,timestamp,now=new Date()}) {
    const kind = activityKind(item);
    const incoming = kind === 'cash' || kind === 'digital' || item.adjustmentDirection === 'explora_to_driver';
    const closure = /settlement|closure|cierre/.test(item.type || '') || Boolean(item.periodClosureId);
    const charge = !closure && ['billing','payment'].includes(item.type) && ['cash','digital'].includes(item.method);
    const amountTone = closure ? 'closure' : charge ? 'income' : 'outgoing';
    const title = item.service || item.expenseLabel || ({cash:'Cobro en efectivo',digital:'Cobro digital',expense:'Gasto',debt:'Deuda',management:'Gestión'}[kind]);
    const date = new Date(timestamp(item));
    const label = date.toDateString() === now.toDateString()
      ? date.toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit'})
      : date.toLocaleDateString('es-AR',{day:'numeric',month:'short'});
    return `<span class="activity-icon icon-${kind}">${exploraIcon(kind)}</span><div class="activity-copy"><strong>${escapeUi(title)}</strong><span>${escapeUi(item.detail || ({cash:'Cobro en efectivo',digital:'Cobro digital',expense:'Gasto registrado',debt:'Deuda registrada',management:'Movimiento de cuenta'}[kind]))}</span></div><div class="activity-value"><strong class="${amountTone}">${incoming ? '+' : '−'} ${escapeUi(money(item.amount))}</strong><time datetime="${date.toISOString()}">${escapeUi(label)}</time></div>`;
}
