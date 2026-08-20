"use strict";

const AMOUNT_FIELDS = [
  "amount", "monto", "valor", "finalPrice", "total", "importe", "price", "precio",
  "precioFinal", "montoFinal", "montoCobrado", "importeTotal", "finalAmount", "totalAmount",
  "billingAmount", "chargedAmount", "paidAmount", "fare", "tarifa", "value", "totalCobrado",
  "facturacion", "billingTotal"
];

function safeText(value) {
  return String(value ?? "").trim();
}

function moneyNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const raw = safeText(value).replace(/\s/g, "");
  if (!raw) return 0;
  const cleaned = raw.replace(/[^0-9,.-]/g, "");
  if (!cleaned || cleaned === "-" || cleaned === "," || cleaned === ".") return 0;
  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");
  let normalized = cleaned;
  if (lastComma >= 0 && lastDot >= 0) {
    normalized = lastComma > lastDot
      ? cleaned.replace(/\./g, "").replace(/,/g, ".")
      : cleaned.replace(/,/g, "");
  } else if (lastDot >= 0) {
    normalized = cleaned.slice(lastDot + 1).length === 3 ? cleaned.replace(/\./g, "") : cleaned;
  } else if (lastComma >= 0) {
    normalized = cleaned.slice(lastComma + 1).length === 3
      ? cleaned.replace(/,/g, "")
      : cleaned.replace(/,/g, ".");
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function amountOf(data = {}) {
  for (const field of AMOUNT_FIELDS) {
    if (data[field] === undefined || data[field] === null || data[field] === "") continue;
    const amount = moneyNumber(data[field]);
    if (amount > 0) return amount;
  }
  return 0;
}

function paymentMethodOf(data = {}) {
  const raw = safeText(
    data.paymentMethod || data.metodoPago || data.financialCategory ||
    data.receiptPaymentMethod || data.paymentProvider || data.method || data.tipoPago
  ).toLowerCase();
  if (/cash|efectivo/.test(raw)) return "cash";
  if (/qr/.test(raw)) return "qr";
  if (/card|tarjeta|point|posnet/.test(raw)) return "card";
  if (/transfer|alias|transf/.test(raw)) return "transfer";
  return raw;
}

function timestampMs(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.toDate === "function") return value.toDate().getTime();
  if (typeof value === "number") return value > 100000000000 ? value : value * 1000;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (typeof value._seconds === "number") {
    return value._seconds * 1000 + Math.floor((value._nanoseconds || 0) / 1000000);
  }
  if (typeof value.seconds === "number") {
    return value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1000000);
  }
  return 0;
}

function rowMs(data = {}) {
  return Math.max(
    timestampMs(data.createdAt), timestampMs(data.completedAt), timestampMs(data.updatedAt),
    timestampMs(data.expenseDate), timestampMs(data.fechaISO),
    Number(data.createdAtMs || 0), Number(data.timestampMs || 0), Number(data.completedAtMs || 0)
  );
}

function movementIsDeleted(data = {}) {
  const status = safeText(data.status || data.estado || data.state || data.deletionStatus).toLowerCase();
  return data.deleted === true || data.isDeleted === true || data.eliminado === true ||
    /deleted|eliminado|borrado|anulado/.test(status);
}

function isSimulated(data = {}) {
  return data.isSimulated === true || data.createdBySimulation === true || data.verificationMode === "simulation";
}

function isDriverBillingSettlementPayment(data = {}) {
  const type = safeText(data.type || data.operationType || data.movementType).toLowerCase();
  const source = safeText(data.sourceModule || data.category || data.module).toLowerCase();
  return data.affectsBillingSettlement === true ||
    type === "admin_billing_settlement_payment" ||
    (type === "driver_payment" && /factur|billing/.test(source));
}

function closureKindOf(data = {}) {
  const raw = safeText(
    data.closureKind || data.closureType || data.payTab || data.closeKind ||
    data.kind || data.cierreTipo || data.type || data.category
  ).toLowerCase();
  if (/caja|chica|cashbox|bruto/.test(raw)) return "caja_chica";
  if (/gasto|expense/.test(raw)) return "gastos";
  if (/explora|digital|transfer|qr|card|tarjeta/.test(raw)) return "explora";
  if (/chofer|driver|efectivo|cash/.test(raw)) return "chofer";
  if (/factur|billing|cobro/.test(raw)) return "facturacion";
  return "";
}

function closureInvalidatesCutoff(data = {}) {
  const fields = [
    data.status, data.estado, data.closureStatus, data.paymentStatus, data.receiptStatus,
    data.statusLabel, data.rejectionReason, data.rollbackStatus, data.closureMode, data.periodType
  ];
  const joined = fields.map(value => safeText(value).toLowerCase()).filter(Boolean).join(" | ");
  return data.rejected === true || data.rollbackRestored === true || data.invalidatesCutoff === true ||
    data.cutoffActive === false || /reject|rechaz|cancel|anulad|no aceptado|rejected_on_demand/.test(joined);
}

function isActiveBillingClosure(data = {}) {
  const mode = safeText(data.closureMode || data.periodType).toLowerCase();
  const kind = closureKindOf(data);
  const isBilling = data.billingClosure === true || ["chofer", "explora", "facturacion"].includes(kind);
  return mode === "on_demand" && isBilling && !closureInvalidatesCutoff(data);
}

function closureCutMs(data = {}) {
  const explicit = Number(data.cutoffAtMs || 0) || timestampMs(data.cutoffAt);
  if (explicit > 0) return explicit;
  const requested = Number(data.requestedAtMs || 0) || timestampMs(data.requestedAt) ||
    Number(data.createdAtMs || 0) || timestampMs(data.createdAt);
  if (requested > 0) return requested;
  return Math.max(
    Number(data.driverUploadedAtMs || 0), Number(data.adminUploadedAtMs || 0),
    Number(data.receiptUploadedAtMs || 0), Number(data.confirmedAtMs || 0), Number(data.closedAtMs || 0),
    timestampMs(data.driverUploadedAt), timestampMs(data.adminUploadedAt),
    timestampMs(data.receiptUploadedAt), timestampMs(data.confirmedAt),
    timestampMs(data.closedAt), rowMs(data)
  );
}

function latestBillingCutoffMs(closures = []) {
  return closures
    .filter(isActiveBillingClosure)
    .map(closureCutMs)
    .filter(value => value > 0)
    .reduce((latest, value) => Math.max(latest, value), 0);
}

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function calculateOpenBillingBalance({ records = [], closures = [] } = {}) {
  const cutoffMs = latestBillingCutoffMs(closures);
  let cash = 0;
  let digital = 0;
  let includedCount = 0;
  let settlementPaymentTotal = 0;
  let settlementPaymentCount = 0;

  for (const record of records) {
    if (!record || movementIsDeleted(record) || isSimulated(record) || rowMs(record) <= cutoffMs) continue;
    const amount = amountOf(record);
    if (isDriverBillingSettlementPayment(record)) {
      if (amount > 0) {
        settlementPaymentTotal += amount;
        settlementPaymentCount += 1;
      }
      continue;
    }
    const method = paymentMethodOf(record);
    if (!(amount > 0) || !["cash", "card", "qr", "transfer"].includes(method)) continue;
    if (method === "cash") cash += amount;
    else digital += amount;
    includedCount += 1;
  }

  cash = roundMoney(cash);
  digital = roundMoney(digital);
  const gross = roundMoney(cash + digital);
  const shareEach = roundMoney(gross * 0.5);
  const netBeforePayments = roundMoney(shareEach - cash);
  settlementPaymentTotal = roundMoney(settlementPaymentTotal);
  const netToDriver = roundMoney(netBeforePayments + settlementPaymentTotal);

  return {
    cutoffMs,
    includedCount,
    cash,
    digital,
    gross,
    shareEach,
    settlementPaymentCount,
    settlementPaymentTotal,
    netBeforePayments,
    netToDriver,
    amountFromDriver:roundMoney(Math.max(0, -netToDriver)),
    amountToDriver:roundMoney(Math.max(0, netToDriver))
  };
}

module.exports = {
  calculateOpenBillingBalance,
  isDriverBillingSettlementPayment,
  latestBillingCutoffMs
};
