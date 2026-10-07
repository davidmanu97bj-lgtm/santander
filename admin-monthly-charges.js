const concepts = Object.freeze(['canon', 'patente']);
const monthFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit'
});
const text = value => String(value ?? '').trim();
const validMonth = value => /^\d{4}-(0[1-9]|1[0-2])$/.test(value) && !value.startsWith('0000-');

// Iguazú follows Argentina's calendar, regardless of the administrator's device zone.
export function monthlyChargeMonth(ms = Date.now()) {
  if (!(ms instanceof Date) && typeof ms !== 'number') return '';
  const date = ms instanceof Date ? ms : new Date(ms);
  if (!Number.isFinite(date.getTime())) return '';
  const parts = monthFormat.formatToParts(date);
  const month = `${parts.find(part => part.type === 'year').value.padStart(4, '0')}-${parts.find(part => part.type === 'month').value}`;
  return validMonth(month) ? month : '';
}

export function monthlyChargeConcept(typeId) {
  const type = text(typeId).toLowerCase();
  if (type === 'canon' || type === 'canon_compartido') return 'canon';
  if (type === 'patente' || type === 'patente_chofer') return 'patente';
  return '';
}

export function monthlyChargeType(concept, split) {
  if (concept === 'canon') return split === 'shared' ? 'canon_compartido' : split === 'driver' ? 'canon' : '';
  if (concept === 'patente') return split === 'shared' ? 'patente' : split === 'driver' ? 'patente_chofer' : '';
  return '';
}

// This is an admin_audit guard ID. Expenses retain their individual operation IDs
// so an annulled charge can be replaced without overwriting its history.
export function monthlyChargeId(driverUid, month, concept) {
  const uid = text(driverUid);
  if (!uid || !validMonth(month) || !concepts.includes(concept)) throw new Error('Cargo mensual inválido.');
  return `monthly_${encodeURIComponent(uid)}_${month}_${concept}`;
}

function activeExpense(row) {
  if (!row || typeof row !== 'object') return false;
  if (row.isSimulated === true || row.createdBySimulation === true || row.verificationMode === 'simulation') return false;
  if (row.deleted === true || row.isDeleted === true || row.eliminado === true || row.deletedAt || row.deletedAtMs
    || row.active === false || row.activo === false || row.disabled === true) return false;
  return ![row.status, row.estado, row.state, row.reviewStatus, row.deletionStatus]
    .some(value => /reject|rechaz|cancel|anulad|delet|eliminad|borrad|inactiv|disabled|draft|borrador/.test(text(value).toLowerCase()));
}

function timestampMillis(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value?.toMillis === 'function') return value.toMillis();
  const seconds = value?.seconds ?? value?._seconds;
  if (typeof seconds === 'number') return seconds * 1000 + Number(value.nanoseconds ?? value._nanoseconds ?? 0) / 1000000;
  // A timestamp string must declare its zone so browser-local time cannot shift it.
  if (typeof value === 'string' && /T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return Date.parse(value);
  return NaN;
}

function expenseMonth(row) {
  if (row.expenseMonth !== undefined && row.expenseMonth !== null) {
    return validMonth(row.expenseMonth) ? row.expenseMonth : '';
  }
  for (const value of [row.createdAt, row.createdAtMs]) {
    const ms = timestampMillis(value);
    if (Number.isFinite(ms)) {
      const month = monthlyChargeMonth(ms);
      if (month) return month;
    }
  }
  const day = text(row.dayKey);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !validMonth(day.slice(0, 7))) return '';
  const date = new Date(`${day}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day ? day.slice(0, 7) : '';
}

function expenseOwner(row) {
  return text(row.driverUid || row.choferUid || row.driverId || row.choferId || row.uid || row.ownerUid || row.operatorUid);
}

// Reminders are derived only from recorded digital expenses. They never create a
// debt, infer a charge from free text, or depend on whether a receipt was attached.
export function monthlyChargesForDriver(expenses = [], driverUid = '', month = monthlyChargeMonth(), ownerFn = expenseOwner) {
  const uid = text(driverUid);
  const found = {canon: new Set(), patente: new Set()};
  if (uid && validMonth(month)) for (const row of Array.isArray(expenses) ? expenses : []) {
    if (!activeExpense(row) || text(row.expensePaymentMethod).toLowerCase() !== 'digital'
      || text(ownerFn(row)) !== uid || expenseMonth(row) !== month) continue;
    const concept = monthlyChargeConcept(row.expenseType || row.tipo || row.category);
    if (concept) found[concept].add(text(row.id || row.documentId) || row);
  }
  return {
    month,
    missing: concepts.filter(concept => found[concept].size === 0),
    completed: concepts.filter(concept => found[concept].size > 0),
    duplicates: concepts.filter(concept => found[concept].size > 1)
  };
}

const snapshotExists = snapshot => typeof snapshot.exists === 'function' ? snapshot.exists() : snapshot.exists;
const monthlyError = (code, message) => Object.assign(new Error(message), {code});

// Invoke inside runTransaction. The caller supplies prepared timestamps and refs;
// all reads precede writes, and the expense and its guard commit atomically.
export async function commitMonthlyExpense({tx, expenseRef, guardRef, payload, operationId, fingerprint, expenseRefById, guardData}) {
  if (!text(operationId) || !text(fingerprint) || payload?.idempotencyKey !== operationId
    || payload?.submissionFingerprint !== fingerprint) {
    throw monthlyError('monthly-charge-conflict', 'No se pudo identificar el cargo mensual.');
  }
  const existing = await tx.get(expenseRef);
  if (snapshotExists(existing)) {
    const row = existing.data();
    if (row.idempotencyKey === operationId && row.submissionFingerprint === fingerprint) return {id: expenseRef.id, duplicate: true};
    throw monthlyError('monthly-charge-conflict', 'Esta operación ya existe con otros datos.');
  }
  const guard = await tx.get(guardRef);
  const priorId = snapshotExists(guard) ? text(guard.data().expenseId) : '';
  if (priorId && priorId !== expenseRef.id) {
    if (priorId.includes('/')) throw monthlyError('monthly-charge-conflict', 'La referencia del cargo mensual no es válida.');
    const prior = await tx.get(expenseRefById(priorId));
    if (snapshotExists(prior) && activeExpense(prior.data())) {
      throw monthlyError('monthly-charge-exists', 'Este concepto ya fue cargado para el chofer y el mes elegidos.');
    }
  }
  tx.set(expenseRef, payload);
  tx.set(guardRef, {...guardData, expenseId: expenseRef.id});
  return {id: expenseRef.id, duplicate: false};
}
