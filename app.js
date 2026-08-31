import * as firebaseSettings from "./firebase-config.js?v=20260824-15";

const { firebaseConfig, BUSINESS_ID, USER_EMAIL_DOMAIN } = firebaseSettings;
const LOGIN_ALIASES = firebaseSettings.LOGIN_ALIASES || {};

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
  setPersistence, browserLocalPersistence, browserSessionPersistence, inMemoryPersistence
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import {
  initializeFirestore, collection, addDoc, doc, getDoc, getDocFromServer, getDocs, setDoc,
  onSnapshot, serverTimestamp, query, where, limit, writeBatch, runTransaction
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import {
  getStorage, ref, uploadBytes, getDownloadURL
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-storage.js";
import {
  getFunctions, httpsCallable
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-functions.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = initializeFirestore(app, { experimentalAutoDetectLongPolling: true });
const storage = getStorage(app);
const functions = getFunctions(app, "southamerica-east1");
const adminCreateDriverCallable = httpsCallable(functions, "adminCreateDriver");
const adminUpdateDriverCallable = httpsCallable(functions, "adminUpdateDriver");
const ensureTeamRealtimeBalancesCallable = httpsCallable(functions, "ensureTeamRealtimeBalances");
const adminDeleteFinancialMovementCallable = httpsCallable(functions, "adminDeleteFinancialMovement");
const adminModifyExpenseAmountCallable = httpsCallable(functions, "adminModifyExpenseAmount");
const adminModifyBillingAmountCallable = httpsCallable(functions, "adminModifyBillingAmount");
const authReady = setPersistence(auth, browserLocalPersistence)
  .catch(() => setPersistence(auth, browserSessionPersistence))
  .catch(() => setPersistence(auth, inMemoryPersistence))
  .catch(err => console.warn("No se pudo guardar la persistencia de sesión:", err));
const AUTH_READY_TIMEOUT_MS = 2500;

const $ = id => document.getElementById(id);

function photoPicker(key) {
  return document.querySelector(`[data-photo-picker="${key}"]`);
}

function selectedPhotoFile(key) {
  const picker = photoPicker(key);
  if (!picker) return null;
  const selectedInput = $(picker.dataset.selectedInput || "");
  if (selectedInput?.files?.[0]) return selectedInput.files[0];
  return Array.from(picker.querySelectorAll(".photo-source-input"))
    .map(input => input.files?.[0] || null)
    .find(Boolean) || null;
}

function clearPhotoPicker(key) {
  const picker = photoPicker(key);
  if (!picker) return;
  picker.querySelectorAll(".photo-source-input").forEach(input => { input.value = ""; });
  delete picker.dataset.selectedInput;
  const selection = picker.querySelector("[data-photo-selection]");
  if (selection) {
    selection.textContent = "Ninguna foto seleccionada.";
    selection.classList.remove("has-photo");
  }
}

function setPhotoPickerDisabled(key, disabled) {
  const picker = photoPicker(key);
  if (!picker) return;
  picker.querySelectorAll(".photo-source-input, [data-photo-input]").forEach(control => {
    control.disabled = Boolean(disabled);
  });
}

function initializePhotoSourcePickers() {
  document.querySelectorAll("[data-photo-picker]").forEach(picker => {
    picker.querySelectorAll("[data-photo-input]").forEach(button => {
      button.addEventListener("click", () => {
        const input = $(button.dataset.photoInput || "");
        if (!input || input.disabled) return;
        input.click();
      });
    });

    picker.querySelectorAll(".photo-source-input").forEach(input => {
      input.addEventListener("change", () => {
        const file = input.files?.[0];
        if (!file) return;
        picker.querySelectorAll(".photo-source-input").forEach(other => {
          if (other !== input) other.value = "";
        });
        picker.dataset.selectedInput = input.id;
        const selection = picker.querySelector("[data-photo-selection]");
        if (selection) {
          const source = input.dataset.photoSource === "camera" ? "Foto tomada" : "Foto de galería";
          selection.textContent = `${source}: ${file.name || "imagen seleccionada"}`;
          selection.classList.add("has-photo");
        }
      });
    });

    picker.closest("form")?.addEventListener("reset", () => {
      window.setTimeout(() => clearPhotoPicker(picker.dataset.photoPicker), 0);
    });
  });
}

initializePhotoSourcePickers();
const SPLASH_MIN_VISIBLE_MS = 900;
let splashStartedAt = Date.now();
let splashProgress = 4;
let splashTimer = null;
let splashTransition = 0;
let unsubscribePayments = null;
let unsubscribeExpenses = null;
let unsubscribeUber = null;
let unsubscribeClosures = null;
let unsubscribeDebts = null;
let unsubscribeDebtPayments = null;
let unsubscribeAdvances = null;
let payments = [];
let expenses = [];
let uberClosures = [];
let closures = [];
let debts = [];
let debtPayments = [];
let advances = [];
let advancesLoaded = false;
let currentProfile = null;
let teamRealtimeBalances = [];
let unsubscribeTeamRealtimeBalances = null;
let teamRealtimeLoadError = "";
let unsubscribeOwnProfileStatus = null;
let disabledProfileSignoutInProgress = false;

// Estado exclusivo del panel Admin. Se mantiene separado de la pantalla del chofer.
let adminDrivers = [];
let adminPayments = [];
let adminExpenses = [];
let adminUberClosures = [];
let adminAllClosures = [];
let adminDebts = [];
let adminDebtPayments = [];
let adminAdvances = [];
let adminUnsubscribers = [];
let adminPendingAction = null;
const adminDismissedPendingActionIds = new Set();
// Históricos de Santander pueden usar aliases anteriores a driverUid.
// Se cargan una vez y se fusionan con el listener canónico en tiempo real.
const legacyOwnedCache = new Map();
const canonicalOwnedCache = new Map();
const OWNERSHIP_FIELDS = [
  "driverUid", "choferUid", "uid", "ownerUid", "driverId", "choferId",
  "driver_id", "chofer_id", "userUid", "userId", "createdByUid", "ownerId",
  "conductorUid", "conductorId", "assignedDriverUid", "enteredOnBehalfOf", "simulationDriverUid"
];
let selectedCloseDirection = "";
let selectedAdminClosureId = "";
const RECENT_RECEIPTS_LIMIT = 10;
const RECEIPTS_PAGE_SIZE = 10;
let visibleReceiptCount = RECENT_RECEIPTS_LIMIT;
let pendingOperationPreview = null;
// Primera semana administrada por este selector. Desde aquí, toda semana
// cerrada sin comprobante permanece pendiente hasta que el chofer la cargue.
const UBER_TRACKING_START_DATE = "2026-08-24";
const ADVANCE_MAX_AMOUNT = 400000;
const ADVANCE_INTEREST_RATE = 0.40;
const ADVANCE_DIFFERENCE_LIMIT = 50000;
const EXPLORA_TRANSFER_ALIAS = "MP.explora";
const EXPLORA_CUIT = "20-40411688-7";
const EXPLORA_ADMIN_UIDS = new Set(["2LziyTTdFcZzSOhK3hLbAKs2U4s2"]);
const ROOT_COLLECTIONS = Object.freeze({
  payments: "billing_records",
  expenses: "gastos",
  uber: "uber_weekly_closures",
  closures: "cierres_semanales",
  debts: "deudas_choferes",
  debtPayments: "deuda_pagos",
  advances: "prestamos_operativos"
});
const TEAM_REALTIME_BALANCES_COLLECTION = "team_realtime_balances";
const PENDING_OPERATION_STORAGE_PREFIX = "explora_pending_operations_v1";
const PENDING_OPERATION_TTL_MS = 48 * 60 * 60 * 1000;
const pendingOperationFallback = new Map();
const activeSubmissionLocks = new Set();

function operationStorageKey(kind, uid) {
  return `${PENDING_OPERATION_STORAGE_PREFIX}:${String(uid || "anonymous")}:${kind}`;
}

function safePendingRegistry(kind, uid) {
  const key = operationStorageKey(kind, uid);
  let registry = pendingOperationFallback.get(key) || {};
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const stored = JSON.parse(raw);
      if (stored && typeof stored === "object" && !Array.isArray(stored)) registry = stored;
    }
  } catch (_) {}

  const now = Date.now();
  const fresh = Object.fromEntries(Object.entries(registry).filter(([, entry]) => (
    entry && typeof entry.operationId === "string" && Number(entry.expiresAtMs || 0) > now
  )));
  pendingOperationFallback.set(key, fresh);
  try { localStorage.setItem(key, JSON.stringify(fresh)); } catch (_) {}
  return fresh;
}

function savePendingRegistry(kind, uid, registry) {
  const key = operationStorageKey(kind, uid);
  pendingOperationFallback.set(key, registry);
  try { localStorage.setItem(key, JSON.stringify(registry)); } catch (_) {}
}

function randomOperationToken() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID().replace(/-/g, "");
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  return Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
}

function reservePendingOperation(kind, uid, fingerprint) {
  const registry = safePendingRegistry(kind, uid);
  const current = registry[fingerprint];
  if (current?.operationId) return current;
  const createdAtMs = Date.now();
  const entry = {
    operationId: `${kind}_${randomOperationToken()}`,
    createdAtMs,
    expiresAtMs: createdAtMs + PENDING_OPERATION_TTL_MS
  };
  registry[fingerprint] = entry;
  savePendingRegistry(kind, uid, registry);
  return entry;
}

function clearPendingOperation(kind, uid, fingerprint, operationId) {
  const registry = safePendingRegistry(kind, uid);
  if (registry[fingerprint]?.operationId !== operationId) return;
  delete registry[fingerprint];
  savePendingRegistry(kind, uid, registry);
}

function fallbackHash(value) {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}

async function sha256Hex(input) {
  try {
    if (globalThis.crypto?.subtle) {
      const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
      const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
      return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
    }
  } catch (_) {}
  const fallbackValue = typeof input === "string"
    ? input
    : Array.from(new Uint8Array(input)).join(",");
  return fallbackHash(fallbackValue);
}

async function buildSubmissionFingerprint(kind, fields) {
  const normalizedFields = Object.fromEntries(Object.entries(fields).map(([key, value]) => [
    key,
    typeof value === "string"
      ? value.trim().normalize("NFKC").replace(/\s+/g, " ").toLocaleLowerCase("es-AR")
      : value
  ]));
  return `sha256_${await sha256Hex(JSON.stringify({ kind, fields:normalizedFields }))}`;
}

function acquireSubmissionLock(kind) {
  if (activeSubmissionLocks.has(kind)) return false;
  activeSubmissionLocks.add(kind);
  return true;
}

function releaseSubmissionLock(kind) {
  activeSubmissionLocks.delete(kind);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function firebaseErrorCode(error) {
  return String(error?.code || error?.name || "").toLowerCase();
}

function isTransientFirebaseError(error) {
  const code = firebaseErrorCode(error);
  return [
    "unavailable",
    "deadline-exceeded",
    "aborted",
    "resource-exhausted",
    "internal",
    "unknown",
    "network-request-failed",
    "storage/retry-limit-exceeded",
    "storage/unknown",
    "storage/server-file-wrong-size"
  ].some(value => code.includes(value));
}

async function retryFirebaseOperation(task, attempts = 4) {
  const waits = [0, 650, 1500, 3000];
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (waits[attempt]) await delay(waits[attempt]);
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (!isTransientFirebaseError(error) || attempt >= attempts - 1) throw error;
    }
  }
  throw lastError;
}

async function runTransactionWithRetry(handler) {
  return retryFirebaseOperation(() => runTransaction(db, handler), 4);
}

async function confirmCommittedOperation(documentRef, operationId, fingerprint) {
  // Primero revisa el estado que ya conoce el cliente. Esto cubre el caso
  // típico de una conexión 4G inestable donde Firebase confirma el write
  // localmente pero la respuesta final del servidor se corta.
  const matchesOperation = snapshot => {
    if (!snapshot?.exists?.()) return false;
    const data = snapshot.data() || {};
    return data.idempotencyKey === operationId && data.submissionFingerprint === fingerprint;
  };

  try {
    const localOrServerSnapshot = await getDoc(documentRef);
    if (matchesOperation(localOrServerSnapshot)) return true;
  } catch (_) {}

  // Si todavía no aparece, reintenta contra servidor durante unos segundos.
  // Nunca genera otro documento: siempre consulta el mismo operationId.
  const waits = [0, 500, 1200, 2200, 3800, 6000];
  for (const waitMs of waits) {
    if (waitMs) await delay(waitMs);
    try {
      const snapshot = await getDocFromServer(documentRef);
      if (matchesOperation(snapshot)) return true;
    } catch (_) {}
  }
  return false;
}

function assertSameCommittedOperation(snapshot, operationId, fingerprint) {
  if (!snapshot.exists()) return false;
  const data = snapshot.data() || {};
  if (data.idempotencyKey === operationId && data.submissionFingerprint === fingerprint) return true;
  const error = new Error("El identificador de la operación ya está ocupado por otro registro.");
  error.code = "operation-id-conflict";
  throw error;
}

function profileRole(profile = {}, user = auth.currentUser) {
  if (user?.uid && EXPLORA_ADMIN_UIDS.has(user.uid)) return "admin";
  const raw = String(profile.role || profile.rol || profile.tipoUsuario || profile.tipo || "chofer").trim().toLowerCase();
  return ["admin", "administrador", "owner", "superadmin"].includes(raw) ? "admin" : "barber";
}

function moneyNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = String(value ?? "").replace(/\s/g, "");
  if (!text) return 0;
  const cleaned = text.replace(/[^0-9,.-]/g, "");
  if (!cleaned || cleaned === "-" || cleaned === "," || cleaned === ".") return 0;
  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");
  let normalized = cleaned;
  if (lastComma >= 0 && lastDot >= 0) {
    normalized = lastComma > lastDot ? cleaned.replace(/\./g, "").replace(/,/g, ".") : cleaned.replace(/,/g, "");
  } else if (lastDot >= 0) {
    const tail = cleaned.slice(lastDot + 1);
    normalized = tail.length === 3 ? cleaned.replace(/\./g, "") : cleaned;
  } else if (lastComma >= 0) {
    const tail = cleaned.slice(lastComma + 1);
    normalized = tail.length === 3 ? cleaned.replace(/,/g, "") : cleaned.replace(/,/g, ".");
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function recordAmount(item = {}) {
  for (const value of [item.amount, item.monto, item.valor, item.finalPrice, item.totalAmount, item.total, item.importe,
    item.price, item.precio, item.precioFinal, item.montoFinal, item.montoCobrado, item.importeTotal,
    item.finalAmount, item.billingAmount, item.chargedAmount, item.paidAmount, item.fare, item.tarifa,
    item.value, item.totalCobrado, item.facturacion, item.billingTotal]) {
    if (value === null || value === undefined || value === "") continue;
    const parsed = moneyNumber(value);
    if (parsed >= 0) return parsed;
  }
  return 0;
}

function recordTimestampMs(item = {}) {
  const candidates = [item.createdAt, item.completedAt, item.updatedAt, item.expenseDate, item.receiptUploadedAt];
  for (const value of candidates) {
    if (!value) continue;
    if (typeof value.toMillis === "function") return value.toMillis();
    if (typeof value.toDate === "function") return value.toDate().getTime();
    if (value instanceof Date) return value.getTime();
  }
  for (const value of [item.createdAtMs, item.completedAtMs, item.updatedAtMs, item.timestampMs]) {
    const parsed = Number(value || 0);
    if (parsed > 0) return parsed;
  }
  for (const value of [item.fechaISO, item.date, item.fecha]) {
    const parsed = Date.parse(String(value || ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function recordDayKey(item = {}) {
  if (item.dayKey) return String(item.dayKey);
  const ms = recordTimestampMs(item);
  return ms ? localDayKey(new Date(ms)) : "";
}

function recordProofUrl(item = {}) {
  return String(item.proofUrl || item.receiptUrl || item.downloadURL || item.comprobanteUrl || item.notificationPhotoUrl || "");
}

function recordProofPath(item = {}) {
  return String(item.proofPath || item.receiptPath || item.storagePath || item.fullPath || item.comprobantePath || "");
}

function normalizePaymentRecord(id, item = {}) {
  const rawMethod = String(item.method || item.paymentMethod || item.metodoPago || item.financialCategory || "").toLowerCase();
  const method = /cash|efectivo/.test(rawMethod) ? "cash" : "digital";
  const originalType = String(item.type || item.operationType || "");
  const sourceModule = String(item.sourceModule || item.category || item.module || "").toLowerCase();
  let adjustmentDirection = String(item.adjustmentDirection || item.settlementDirection || item.paymentDirection || "").toLowerCase();
  if (["driver_pays_explora", "chofer_a_explora", "chofer_a_david"].includes(adjustmentDirection)) adjustmentDirection = "driver_to_explora";
  if (["explora_pays_driver", "explora_a_chofer", "david_a_chofer"].includes(adjustmentDirection)) adjustmentDirection = "explora_to_driver";
  const isLegacyBillingSettlement = item.affectsBillingSettlement === true ||
    originalType.toLowerCase() === "admin_billing_settlement_payment" ||
    (String(item.operationType || item.movementType || "").toLowerCase() === "driver_payment" && /factur|billing/.test(sourceModule));
  if (isLegacyBillingSettlement && !adjustmentDirection) adjustmentDirection = "driver_to_explora";
  let type = originalType;
  // No convertir las compensaciones de gastos: también son internas, pero tienen
  // una lógica propia distinta de un pago de cierre.
  if (adjustmentDirection || isLegacyBillingSettlement) type = "settlement_adjustment";
  return {
    ...item,
    id,
    amount: recordAmount(item),
    method,
    type,
    adjustmentDirection,
    service: item.service || item.serviceDescription || item.categoryLabel || (method === "cash" ? "Cobro en efectivo" : "Cobro digital"),
    detail: item.detail || item.notes || item.detalle || item.descripcion || "Servicio registrado",
    proofUrl: recordProofUrl(item),
    proofPath: recordProofPath(item),
    dayKey: recordDayKey(item),
    operatorUid: item.operatorUid || item.driverUid || item.choferUid || item.uid || "",
    operatorName: item.operatorName || item.driverName || item.choferNombre || item.nombreChofer || ""
  };
}

function normalizeExpenseRecord(id, item = {}) {
  return {
    ...item,
    id,
    amount: recordAmount(item),
    detail: item.detail || item.notes || item.detalle || item.descripcion || item.expenseType || item.tipo || "Gasto",
    proofUrl: recordProofUrl(item),
    proofPath: recordProofPath(item),
    dayKey: recordDayKey(item),
    operatorUid: item.operatorUid || item.driverUid || item.choferUid || item.uid || item.ownerUid || "",
    operatorName: item.operatorName || item.driverName || item.choferNombre || ""
  };
}

function normalizeUberRecord(id, item = {}) {
  const dayKey = recordDayKey(item);
  const weekCloseDate = item.weekCloseDate || (item.weekDisplayEndMs ? localDayKey(new Date(Number(item.weekDisplayEndMs))) : dayKey);
  return {
    ...item,
    id,
    amount: recordAmount({ amount: item.grossAmount ?? item.totalAmount ?? item.amount ?? item.monto }),
    weekKey: item.weekKey || item.weekId || id,
    weekLabel: item.weekLabel || item.weekId || id,
    weekStartDate: item.weekStartDate || (item.weekStartMs ? localDayKey(new Date(Number(item.weekStartMs))) : ""),
    weekCloseDate,
    proofUrl: recordProofUrl(item),
    proofPath: recordProofPath(item),
    dayKey,
    operatorUid: item.operatorUid || item.driverUid || item.choferUid || item.uid || "",
    operatorName: item.operatorName || item.driverName || item.choferNombre || ""
  };
}

function normalizeDebtRecord(id, item = {}) {
  const remaining = Number(item.remainingAmount ?? item.saldoPendiente ?? item.amount ?? item.totalAmount ?? 0);
  const status = String(item.status || item.debtStatus || item.estado || "active").toLowerCase();
  return {
    ...item,
    id,
    amount: /paid|pagad|closed|cerrad|cancel/.test(status) ? 0 : Math.max(0, Number.isFinite(remaining) ? remaining : 0),
    detail: item.detail || item.reason || item.notes || item.descripcion || "Deuda",
    proofUrl: recordProofUrl(item),
    proofPath: recordProofPath(item),
    dayKey: recordDayKey(item),
    operatorUid: item.operatorUid || item.driverUid || item.choferUid || item.uid || ""
  };
}

function normalizeDebtPaymentRecord(id, item = {}) {
  const rawMethod = String(item.paymentMethod || item.method || item.paymentChannel || "").toLowerCase();
  const usesExpenses = item.expenseOffset === true || item.usedExpenseBalance === true ||
    rawMethod === "expense_offset" || /expense.*offset|gasto.*deuda|deuda.*gasto/.test(rawMethod) ||
    String(item.type || item.operationType || "").toLowerCase() === "debt_expense_offset";
  return {
    ...item,
    id,
    amount: recordAmount(item),
    expenseOffset: usesExpenses,
    dayKey: recordDayKey(item),
    operatorUid: item.operatorUid || item.driverUid || item.choferUid || item.uid || item.ownerUid || ""
  };
}

function normalizeClosureRecord(id, item = {}) {
  let direction = String(item.direction || item.paymentDirection || "");
  if (["driver_to_explora", "chofer_a_david", "chofer_a_explora"].includes(direction)) direction = "driver_pays_explora";
  if (["explora_to_driver", "david_a_chofer", "explora_a_chofer"].includes(direction)) direction = "explora_pays_driver";
  if (!direction) {
    if (Number(item.amountDueFromDriver || item.amountFromDriver || 0) > 0) direction = "driver_pays_explora";
    else if (Number(item.amountDueToDriver || item.amountToDriver || 0) > 0) direction = "explora_pays_driver";
  }
  const settlementAmount = Number(item.settlementAmount ?? item.requestedAmount ?? item.amountDueFromDriver ?? item.amountFromDriver ?? item.amountDueToDriver ?? item.amountToDriver ?? 0) || 0;
  const paidAmountTotal = Number(item.paidAmountTotal ?? item.amountPaid ?? item.billingSettlementPaymentTotal ?? 0) || 0;
  return {
    ...item,
    id,
    direction,
    settlementAmount,
    requestedAmount: Number(item.requestedAmount ?? settlementAmount) || settlementAmount,
    paidAmountTotal,
    remainingAmount: Number(item.remainingAmount ?? Math.max(0, settlementAmount - paidAmountTotal)) || 0,
    operatorUid: item.operatorUid || item.driverUid || item.choferUid || item.uid || "",
    operatorName: item.operatorName || item.driverName || item.choferNombre || item.nombreChofer || "",
    proofUrl: recordProofUrl(item),
    proofPath: recordProofPath(item),
    dayKey: recordDayKey(item),
    requestedAt: item.requestedAt || item.createdAt || null
  };
}

function normalizeAdvanceRecord(id, item = {}) {
  return {
    ...item,
    id,
    type: item.type || item.loanType || "",
    remainingAmount: Number(item.remainingAmount ?? item.balance ?? item.saldoPendiente ?? item.totalDebt ?? 0) || 0,
    totalDebt: Number(item.totalDebt ?? item.totalAmount ?? item.originalAmount ?? item.amount ?? 0) || 0
  };
}

function currentWeeklyPeriodId(reference = new Date()) {
  const date = new Date(reference);
  date.setHours(12, 0, 0, 0);
  const daysSinceSaturday = (date.getDay() - 6 + 7) % 7;
  date.setDate(date.getDate() - daysSinceSaturday);
  return localDayKey(date);
}

function currentDriverUid() {
  return auth.currentUser?.uid || "";
}

function currentDriverName() {
  return currentProfile?.displayName || currentProfile?.nombre || currentProfile?.nombreCompleto || currentProfile?.username || auth.currentUser?.displayName || "Chofer";
}

function formatCuit(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length === 11 ? `${digits.slice(0,2)}-${digits.slice(2,10)}-${digits.slice(10)}` : String(value || "").trim() || "No informado";
}

function ownedQuery(collectionName, uid = currentDriverUid()) {
  return query(collection(db, collectionName), where("driverUid", "==", uid));
}

function cacheKey(collectionName, uid) {
  return `${collectionName}::${uid}`;
}

function mergeOwnedRows(collectionName, uid, canonicalRows = []) {
  const key = cacheKey(collectionName, uid);
  const map = new Map();
  for (const row of legacyOwnedCache.get(key) || []) map.set(row.id, row);
  for (const row of canonicalRows || []) map.set(row.id, row);
  return Array.from(map.values());
}

async function loadOwnedHistory(collectionName, uid) {
  const targetUid = String(uid || "").trim();
  if (!targetUid) return [];
  const key = cacheKey(collectionName, targetUid);
  const map = new Map();
  const tasks = OWNERSHIP_FIELDS.map(async field => {
    try {
      const snap = await getDocs(query(collection(db, collectionName), where(field, "==", targetUid), limit(900)));
      snap.forEach(d => map.set(d.id, { id:d.id, ...d.data() }));
    } catch (err) {
      // Algunos aliases pueden no estar permitidos por reglas/índices; seguimos con los demás.
      console.warn("EXPLORA_HISTORY_QUERY", collectionName, field, err?.code || err?.message || err);
    }
  });
  await Promise.allSettled(tasks);
  const rows = Array.from(map.values());
  legacyOwnedCache.set(key, rows);
  return rows;
}

function setCanonicalRows(collectionName, uid, rows) {
  canonicalOwnedCache.set(cacheKey(collectionName, uid), rows || []);
}

function canonicalRows(collectionName, uid) {
  return canonicalOwnedCache.get(cacheKey(collectionName, uid)) || [];
}

function setSplashProgress(value) {
  const progress = Math.max(0, Math.min(100, Number(value) || 0));
  splashProgress = progress;

  const arc = $("splashProgressArc");
  const dot = $("splashProgressDot");
  const progressBox = document.querySelector(".splash-progress");
  if (arc) arc.style.strokeDashoffset = String(100 - progress);
  if (progressBox) progressBox.setAttribute("aria-valuenow", String(Math.round(progress)));

  if (dot) {
    const angle = (-90 + (360 * progress / 100)) * Math.PI / 180;
    dot.setAttribute("cx", String(60 + 48 * Math.cos(angle)));
    dot.setAttribute("cy", String(60 + 48 * Math.sin(angle)));
  }
}

function startSplash() {
  splashTransition += 1;
  splashStartedAt = Date.now();
  splashProgress = 4;
  $("splashScreen")?.classList.remove("hidden", "is-leaving");
  $("loginScreen")?.classList.add("hidden");
  $("app")?.classList.add("hidden");
  setSplashProgress(splashProgress);

  if (splashTimer) window.clearInterval(splashTimer);
  splashTimer = window.setInterval(() => {
    const remaining = 91 - splashProgress;
    setSplashProgress(Math.min(91, splashProgress + Math.max(1.1, remaining * .075)));
  }, 90);
}

async function finishSplash(targetId) {
  const transitionId = ++splashTransition;
  if (splashTimer) {
    window.clearInterval(splashTimer);
    splashTimer = null;
  }

  const elapsed = Date.now() - splashStartedAt;
  if (elapsed < SPLASH_MIN_VISIBLE_MS) {
    await new Promise(resolve => window.setTimeout(resolve, SPLASH_MIN_VISIBLE_MS - elapsed));
  }
  if (transitionId !== splashTransition) return;

  setSplashProgress(100);
  await new Promise(resolve => window.setTimeout(resolve, 190));
  if (transitionId !== splashTransition) return;

  const splash = $("splashScreen");
  splash?.classList.add("is-leaving");
  await new Promise(resolve => window.setTimeout(resolve, 220));
  if (transitionId !== splashTransition) return;

  splash?.classList.add("hidden");
  splash?.classList.remove("is-leaving");
  $("loginScreen")?.classList.toggle("hidden", targetId !== "loginScreen");
  $("app")?.classList.toggle("hidden", targetId !== "app");
}

startSplash();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js")
      .catch(err => console.warn("No se pudo registrar el acceso directo:", err));
  });
}

const money = value => new Intl.NumberFormat("es-AR", {
  style: "currency", currency: "ARS", maximumFractionDigits: 0
}).format(value || 0);
const signedMoney = value => {
  const numericValue = Number(value || 0);
  if (Math.abs(numericValue) < 0.5) return money(0);
  return `${numericValue > 0 ? "+" : "−"} ${money(Math.abs(numericValue))}`;
};
const moneyInputFormatter = new Intl.NumberFormat("es-AR", { maximumFractionDigits: 0 });
const moneyAnimationFrames = new WeakMap();

function moneyForElement(element, value) {
  return element?.dataset.moneyFormat === "signed" ? signedMoney(value) : money(value);
}

function canAnimateMoney() {
  try {
    const reducesMotion = typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    return !reducesMotion
      && typeof window.requestAnimationFrame === "function"
      && typeof window.cancelAnimationFrame === "function";
  } catch {
    return false;
  }
}

function setAnimatedMoney(elementOrId, targetValue) {
  const element = typeof elementOrId === "string" ? $(elementOrId) : elementOrId;
  if (!element) return;

  const target = Number(targetValue || 0);
  const storedCurrent = Number(element.dataset.moneyCurrent);
  const hasPreviousValue = element.dataset.moneyCurrent !== undefined && Number.isFinite(storedCurrent);
  const previous = hasPreviousValue ? storedCurrent : target;
  const activeFrame = moneyAnimationFrames.get(element);

  if (activeFrame !== undefined) {
    window.cancelAnimationFrame(activeFrame);
    moneyAnimationFrames.delete(element);
  }

  // El valor correcto se muestra primero. La animación es una mejora visual y
  // nunca debe impedir el inicio de sesión ni dejar una cifra desactualizada.
  element.textContent = moneyForElement(element, target);
  element.dataset.moneyCurrent = String(target);
  element.setAttribute("aria-label", moneyForElement(element, target));

  if (!hasPreviousValue || Math.abs(target - previous) < 0.5 || !canAnimateMoney()) {
    element.classList.remove("money-rolling");
    return;
  }

  try {
    element.classList.remove("money-rolling");
    void element.offsetWidth;
    element.classList.add("money-rolling");
    element.addEventListener("animationend", () => {
      element.classList.remove("money-rolling");
    }, { once: true });

    let startedAt;
    const duration = 760;

    const tick = now => {
      if (startedAt === undefined) startedAt = now;
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      const current = previous + (target - previous) * eased;

      element.textContent = moneyForElement(element, Math.round(current));
      element.dataset.moneyCurrent = String(current);

      if (progress < 1) {
        moneyAnimationFrames.set(element, window.requestAnimationFrame(tick));
        return;
      }

      element.textContent = moneyForElement(element, target);
      element.dataset.moneyCurrent = String(target);
      moneyAnimationFrames.delete(element);
    };

    moneyAnimationFrames.set(element, window.requestAnimationFrame(tick));
  } catch (err) {
    console.warn("Animación de importes desactivada:", err);
    element.classList.remove("money-rolling");
    element.textContent = money(target);
    element.dataset.moneyCurrent = String(target);
    moneyAnimationFrames.delete(element);
  }
}

function moneyInputDigits(value) {
  return String(value ?? "").replace(/\D/g, "");
}

function parseMoneyInput(value) {
  const digits = moneyInputDigits(value);
  return digits ? Number(digits) : 0;
}

function formattedMoneyInput(value) {
  const amount = typeof value === "number" ? Math.round(value) : parseMoneyInput(value);
  return amount > 0 ? moneyInputFormatter.format(amount) : "";
}

function setMoneyInput(inputOrId, value) {
  const input = typeof inputOrId === "string" ? $(inputOrId) : inputOrId;
  if (input) input.value = formattedMoneyInput(value);
}

document.querySelectorAll("[data-money-input]").forEach(input => {
  input.addEventListener("input", () => {
    const digits = moneyInputDigits(input.value);
    input.value = digits ? moneyInputFormatter.format(Number(digits)) : "";
  });
});

function localDayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,"0");
  const day = String(d.getDate()).padStart(2,"0");
  return `${y}-${m}-${day}`;
}
function safeUsername(value) {
  return value.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/\s+/g,"").replace(/[^a-z0-9._-]/g,"");
}

async function loginEmailCandidates(usernameOrEmail) {
  const value = usernameOrEmail.trim().toLowerCase();
  if (value.includes("@")) return [value];

  const username = safeUsername(value);
  const candidates = [
    LOGIN_ALIASES[value],
    username ? `${username}@${USER_EMAIL_DOMAIN}` : ""
  ].filter(Boolean);

  if (username) {
    try {
      const aliasSnap = await getDoc(doc(db, "login_aliases", username));
      if (aliasSnap.exists()) {
        const data = aliasSnap.data() || {};
        const aliasEmail = String(data.authEmail || data.email || data.correo || data.firebaseEmail || "").trim().toLowerCase();
        if (aliasEmail.includes("@")) candidates.push(aliasEmail);
      }
    } catch (err) {
      console.warn("No se pudo consultar login_aliases; se intenta el acceso histórico.", err?.code || err);
    }
  }

  return [...new Set(candidates)];
}

function isCredentialError(err) {
  return ["auth/invalid-credential", "auth/wrong-password", "auth/user-not-found", "auth/invalid-email"]
    .includes(String(err?.code || ""));
}

async function waitForAuthReady() {
  await Promise.race([
    authReady,
    new Promise(resolve => setTimeout(resolve, AUTH_READY_TIMEOUT_MS))
  ]);
}

async function signInFromLogin(usernameOrEmail, password) {
  const candidates = await loginEmailCandidates(usernameOrEmail);
  let lastError = Object.assign(new Error("Faltan credenciales"), { code: "auth/invalid-credential" });

  for (const email of candidates) {
    try {
      return await signInWithEmailAndPassword(auth, email, password);
    } catch (err) {
      lastError = err;
      if (!isCredentialError(err)) throw err;
    }
  }

  throw lastError;
}

function loginErrorMessage(err) {
  const code = String(err?.code || "");
  if (["auth/invalid-credential", "auth/wrong-password", "auth/user-not-found", "auth/invalid-email"].includes(code)) {
    return "El usuario o la contraseña no son correctos.";
  }
  if (code === "auth/too-many-requests") {
    return "Hubo varios intentos. Esperá un momento y volvé a probar.";
  }
  if (code === "auth/network-request-failed") {
    return "No hay conexión con Firebase. Revisá internet e intentá nuevamente.";
  }
  if (code === "auth/unauthorized-domain") {
    return "Este dominio todavía no está autorizado en Firebase.";
  }
  if (code === "auth/operation-not-allowed") {
    return "Activá el acceso con correo y contraseña en Firebase Authentication.";
  }
  return "No se pudo iniciar sesión. Intentá nuevamente.";
}

function fallbackProfile(user) {
  const username = user.email?.split("@")[0] || "explora";
  return { username, displayName: user.displayName || username, role: EXPLORA_ADMIN_UIDS.has(user.uid) ? "admin" : "barber", active: true, uid:user.uid };
}
function isSettlementAdjustment(item) {
  return item.type === "settlement_adjustment";
}
function isReimbursementCompensation(item) {
  // El tipo anterior se conserva para interpretar correctamente cualquier
  // comprobante que ya se haya generado antes de esta corrección.
  return item.type === "reimbursement_compensation" || item.type === "debt_compensation";
}
function isAdminDebt(item) {
  return item.type === "admin_debt";
}
function isExpenseReceipt(item) {
  return item.type === "expense_receipt";
}
function isUberReceipt(item) {
  return item.type === "uber_receipt";
}
function isCashboxReceipt(item) {
  return item.type === "cashbox_receipt";
}
function isCashAdvance(item) {
  return item.type === "cash_advance";
}
function movementIsDeleted(item = {}) {
  const status = String(item.status || item.estado || item.state || item.deletionStatus || "").toLowerCase();
  return item.deleted === true || item.isDeleted === true || item.eliminado === true || /deleted|eliminado|borrado|anulado/.test(status);
}
function cashboxIsExcluded(item = {}) {
  return item.excludeFromCashbox === true || item.cashboxExcluded === true || item.cajaChicaEliminada === true || item.ignoreCashbox === true || item.noCashbox === true;
}
function revenueTotalFor(method) {
  return openBillingPayments()
    .filter(p => !movementIsDeleted(p) && p.method === method && !isSettlementAdjustment(p) && !isReimbursementCompensation(p))
    .reduce((a,p)=>a+Number(p.amount||0),0);
}
function adjustmentTotal(direction) {
  return openBillingPayments()
    .filter(p => !movementIsDeleted(p) && isSettlementAdjustment(p) && p.adjustmentDirection === direction)
    .reduce((total, item) => {
      const amount = Number(item.amount || 0);
      const paidToAdvance = direction === "driver_to_explora"
        ? Number(item.advanceRepaymentAmount || 0)
        : 0;
      return total + Math.max(0, amount - paidToAdvance);
    }, 0);
}
function expensesTotal() {
  return openExpenses().reduce((a,e)=>a+Number(e.amount||0),0);
}

// Gastos que participan de "Quién paga a quién".
// Se toman con la misma base de Facturación (no con el cierre independiente de Gastos),
// para que cerrar el módulo Gastos no borre el 50% que ya impactó en la liquidación.
function billingExpensesTotal() {
  const baseline = billingMigrationBaselineMs();
  return expenses
    .filter(item => !movementIsDeleted(item))
    .filter(item => recordTimestampMs(item) > baseline)
    .reduce((sum, item) => sum + Number(item.amount || 0), 0);
}

// IMPORTANTE · migración del 26/08/2026:
// Los gastos anteriores al cambio de "50% automático" NO pueden aplicarse de golpe
// a Facturación, porque algunos ya habían sido utilizados manualmente como reintegro.
// Las versiones v68+ dejan una fotografía del saldo en el propio gasto; además desde
// esta corrección guardamos marcadores explícitos. Así distinguimos con seguridad los
// gastos nuevos de los históricos sin depender de una hora fija de despliegue.
function expenseUsesAutomaticBilling50(item = {}) {
  if (item.autoApplyToBilling === true || item.gastoAuto50 === true) return true;
  if (String(item.billingImpactMode || "").toLowerCase() === "auto_50") return true;
  const hasAuto50Snapshot = Object.prototype.hasOwnProperty.call(item, "telegramSettlementBeforeBalance") ||
    Object.prototype.hasOwnProperty.call(item, "telegramSettlementAfterBalance") ||
    Object.prototype.hasOwnProperty.call(item, "telegramExpenseRecognizedAmount");
  return hasAuto50Snapshot;
}

function automaticExpenseBillingImpactTotal(sourceExpenses = expenses, baseline = billingMigrationBaselineMs()) {
  return sourceExpenses
    .filter(item => !movementIsDeleted(item))
    .filter(item => recordTimestampMs(item) > baseline)
    .filter(expenseUsesAutomaticBilling50)
    .reduce((sum, item) => sum + (Number(item.amount || 0) * 0.50), 0);
}
function isAdminSettlementDebt(item = {}) {
  const type = String(item.type || item.debtType || "").toLowerCase();
  const role = String(item.createdByRole || item.registeredByRole || "").toLowerCase();
  const source = String(item.sourceModule || item.registrationOrigin || item.origin || "").toLowerCase();
  if (/uber_weekly/.test(source) || type === "uber_weekly") return false;
  return type === "admin_debt" || role === "admin" || role === "administrador" || source === "admin_debt_menu";
}

// Desde esta versión, las deudas nuevas cargadas por Admin requieren confirmación
// explícita del chofer antes de impactar en "Quién paga a quién". Las deudas
// históricas no llevan este marcador y conservan exactamente su comportamiento.
function debtRequiresDriverConfirmation(item = {}) {
  return isAdminSettlementDebt(item) && item.driverConfirmationRequired === true;
}

function debtImpactsSettlement(item = {}) {
  return isAdminSettlementDebt(item)
    && (!debtRequiresDriverConfirmation(item) || item.acknowledgedByDriver === true);
}

function pendingDriverDebtConfirmations() {
  if (isAdminProfile()) return [];
  return debts
    .filter(item => !movementIsDeleted(item))
    .filter(item => Number(item.amount || 0) > 0.5)
    .filter(item => debtRequiresDriverConfirmation(item) && item.acknowledgedByDriver !== true)
    .sort((a, b) => recordTimestampMs(a) - recordTimestampMs(b));
}

function debtsTotal() {
  return debts
    .filter(item => !movementIsDeleted(item) && debtImpactsSettlement(item))
    .reduce((a,item)=>a+Number(item.amount||0),0);
}
function advanceRemaining(item) {
  const status = String(item.status || item.approvalStatus || "active").toLowerCase();
  if (/pending|solicit|reject|rechaz|cancel/.test(status)) return 0;
  return Math.max(0, Number(item.remainingAmount ?? item.totalDebt ?? 0) || 0);
}
function advancesOutstandingTotal() {
  return advances.reduce((total, item) => total + advanceRemaining(item), 0);
}
function advanceRepaymentAppliedTotal() {
  return payments
    .filter(item => item.method === "digital" && !isSettlementAdjustment(item))
    .reduce((total, item) => total + Number(item.advanceRepaymentAmount || 0), 0);
}
function planAdvanceRepayment(availableAmount, sourceAdvances = advances) {
  let available = Math.max(0, Number(availableAmount || 0));
  const allocations = [];
  const activeAdvances = [...sourceAdvances]
    .filter(item => advanceRemaining(item) > 0.5)
    .sort((a, b) => {
      const aMs = a.createdAt?.toMillis ? a.createdAt.toMillis() : 0;
      const bMs = b.createdAt?.toMillis ? b.createdAt.toMillis() : 0;
      return aMs - bMs;
    });

  for (const advance of activeAdvances) {
    if (available <= 0.5) break;
    const before = advanceRemaining(advance);
    const applied = Math.min(before, available);
    const after = Math.max(0, before - applied);
    allocations.push({
      id: advance.id,
      applied,
      remainingAmount: after,
      repaidAmount: Math.max(0, Number(advance.totalDebt || 0) - after),
      status: after <= 0.5 ? "paid" : "active"
    });
    available -= applied;
  }

  return {
    allocations,
    totalApplied: allocations.reduce((total, item) => total + item.applied, 0)
  };
}
function reimbursementCompensationTotal() {
  const cutoff = lastExpensesClosureMs();

  // Compatibilidad completa con Santander Main:
  // 1) los ajustes históricos de deuda con Gastos viven en `deuda_pagos`;
  // 2) las compensaciones creadas por esta interfaz viven en `billing_records`.
  // Ambos reducen el reintegro bruto del 50% de gastos del período abierto.
  const legacyDebtOffsets = debtPayments
    .filter(item => {
      const linkedPeriodStart = Number(item.expensePeriodStartMs || item.gastosPeriodStartMs || 0);
      return linkedPeriodStart > 0 ? linkedPeriodStart === cutoff : recordTimestampMs(item) > cutoff;
    })
    .filter(item => item.expenseOffset === true)
    .reduce((sum, item) => sum + Math.max(0, Number(item.amount || 0)), 0);

  const newCompensations = payments
    .filter(item => recordTimestampMs(item) > cutoff)
    .filter(isReimbursementCompensation)
    .reduce((sum, item) => sum + Math.max(0, Number(item.amount || 0)), 0);

  return legacyDebtOffsets + newCompensations;
}

// Impacto histórico sobre Facturación. A diferencia del saldo disponible del módulo
// Gastos, este efecto debe sobrevivir a un cierre de Gastos y permanecer hasta el
// próximo cierre/base de Facturación.
function billingExpenseCompensationImpactTotal() {
  const baseline = billingMigrationBaselineMs();
  const legacyDebtOffsets = debtPayments
    .filter(item => recordTimestampMs(item) > baseline)
    .filter(item => item.expenseOffset === true)
    .reduce((sum, item) => sum + Math.max(0, Number(item.amount || 0)), 0);

  const paymentCompensations = payments
    .filter(item => recordTimestampMs(item) > baseline)
    .filter(isReimbursementCompensation)
    .reduce((sum, item) => sum + Math.max(0, Number(item.amount || 0)), 0);

  return legacyDebtOffsets + paymentCompensations;
}

function latestReimbursementSettlementAnchor(sourcePayments = payments, baseline = billingMigrationBaselineMs()) {
  const anchors = sourcePayments
    .filter(item => !movementIsDeleted(item))
    .filter(isReimbursementCompensation)
    .map(item => ({
      item,
      timestamp: recordTimestampMs(item),
      settlementAfter: Number(item.settlementAfter)
    }))
    .filter(entry => entry.timestamp > baseline && Number.isFinite(entry.settlementAfter))
    .sort((a, b) => b.timestamp - a.timestamp);

  if (!anchors.length) return null;
  const latest = anchors[0];
  return {
    item: latest.item,
    timestamp: latest.timestamp,
    balance: Math.abs(latest.settlementAfter) > 0.5 ? latest.settlementAfter : 0,
    amount: Math.max(0, Number(latest.item.amount || latest.item.monto || 0))
  };
}

function settlementMovementDeltaSince(cutoffMs, sourcePayments = payments, sourceUber = uberClosures, sourceExpenses = expenses) {
  const scopedPayments = sourcePayments
    .filter(item => !movementIsDeleted(item))
    .filter(item => recordTimestampMs(item) > cutoffMs);

  const cashRevenue = scopedPayments
    .filter(item => item.method === "cash" && !isSettlementAdjustment(item) && !isReimbursementCompensation(item))
    .reduce((sum, item) => sum + Number(item.amount || 0), 0);

  const cashboxEligibleCash = scopedPayments
    .filter(item => item.method === "cash" && !isSettlementAdjustment(item) && !isReimbursementCompensation(item))
    .filter(item => !cashboxIsExcluded(item))
    .reduce((sum, item) => sum + Number(item.amount || 0), 0);

  const digitalRevenue = scopedPayments
    .filter(item => item.method === "digital" && !isSettlementAdjustment(item) && !isReimbursementCompensation(item))
    .reduce((sum, item) => sum + Number(item.amount || 0), 0);

  const driverPaid = scopedPayments
    .filter(item => isSettlementAdjustment(item) && item.adjustmentDirection === "driver_to_explora")
    .reduce((sum, item) => sum + Math.max(0, Number(item.amount || 0) - Number(item.advanceRepaymentAmount || 0)), 0);

  const exploraPaid = scopedPayments
    .filter(item => isSettlementAdjustment(item) && item.adjustmentDirection === "explora_to_driver")
    .reduce((sum, item) => sum + Number(item.amount || 0), 0);

  const uberRevenue = sourceUber
    .filter(item => !movementIsDeleted(item))
    .filter(item => recordTimestampMs(item) > cutoffMs)
    .filter(item => !/reject|rechaz/.test(String(item.reviewStatus || item.status || "").toLowerCase()))
    .reduce((sum, item) => sum + Number(item.amount || 0), 0);

  const cashBox = (cashboxEligibleCash + uberRevenue) * 0.05;
  const automaticExpenseImpact = automaticExpenseBillingImpactTotal(sourceExpenses, cutoffMs);
  const delta = (cashRevenue * 0.50) + (uberRevenue * 0.50) + cashBox
    - (digitalRevenue * 0.50) - automaticExpenseImpact - driverPaid + exploraPaid;

  return {
    cashRevenue, digitalRevenue, uberRevenue, cashBox, automaticExpenseImpact,
    driverPaid, exploraPaid, delta
  };
}

function uberTodayItems() {
  const today = localDayKey();
  return uberClosures.filter(item => item.dayKey === today);
}
function uberTodayTotal() {
  return uberTodayItems().reduce((a,item)=>a+Number(item.amount||0),0);
}
function isoWeekKey(dateString) {
  const [y,m,d] = String(dateString).split("-").map(Number);
  if (!y || !m || !d) return "";
  const date = new Date(Date.UTC(y, m - 1, d));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2,"0")}`;
}
function parseLocalDateKey(dateString) {
  const [year, month, day] = String(dateString || "").split("-").map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day, 12, 0, 0, 0);
}
function addLocalDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}
function startOfUberWeek(referenceDate = new Date()) {
  const date = new Date(referenceDate);
  date.setHours(12, 0, 0, 0);
  const daysSinceMonday = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - daysSinceMonday);
  return date;
}
function formatUberWeekDate(dateString) {
  const date = parseLocalDateKey(dateString);
  if (!date) return "Sin fecha";
  return new Intl.DateTimeFormat("es-AR", { day: "numeric", month: "short" })
    .format(date)
    .replace(/\./g, "");
}
function buildUberWeek(startDate) {
  const start = new Date(startDate);
  const close = addLocalDays(start, 7);
  const weekStartDate = localDayKey(start);
  const weekCloseDate = localDayKey(close);
  return {
    weekStartDate,
    weekCloseDate,
    weekKey: isoWeekKey(weekCloseDate),
    label: `${formatUberWeekDate(weekStartDate)} – ${formatUberWeekDate(weekCloseDate)}`
  };
}
function currentUberWeek(referenceDate = new Date()) {
  return buildUberWeek(startOfUberWeek(referenceDate));
}
function uberWeekLabelForItem(item) {
  if (item.weekLabel) return item.weekLabel;
  const close = parseLocalDateKey(item.weekCloseDate);
  if (!close) return item.weekKey || "Semana sin fecha";
  const start = item.weekStartDate || localDayKey(addLocalDays(close, -7));
  return `${formatUberWeekDate(start)} – ${formatUberWeekDate(item.weekCloseDate)}`;
}
function isUberWeekLoaded(week) {
  return uberClosures.some(item =>
    item.weekStartDate === week.weekStartDate
    || item.weekCloseDate === week.weekCloseDate
    || item.weekKey === week.weekKey
    || item.id === week.weekKey
  );
}
function pendingUberWeeks(referenceDate = new Date()) {
  const firstWeek = parseLocalDateKey(UBER_TRACKING_START_DATE);
  const today = parseLocalDateKey(localDayKey(referenceDate));
  if (!firstWeek || !today) return [];

  const pending = [];
  let cursor = firstWeek;
  let safety = 0;
  while (cursor.getTime() < today.getTime() && safety < 520) {
    const week = buildUberWeek(cursor);
    const closeDate = parseLocalDateKey(week.weekCloseDate);
    // El comprobante se habilita al día siguiente del cierre. Ejemplo:
    // la semana 24–31 de agosto empieza a solicitarse el 1 de septiembre.
    if (!closeDate || closeDate.getTime() >= today.getTime()) break;
    if (!isUberWeekLoaded(week)) pending.push(week);
    cursor = addLocalDays(cursor, 7);
    safety += 1;
  }
  return pending;
}
function selectedPendingUberWeek() {
  const selectedStart = $("uberWeekSelect")?.value || "";
  return pendingUberWeeks().find(week => week.weekStartDate === selectedStart) || null;
}
function updateUberWeekSummary() {
  const week = selectedPendingUberWeek();
  const startLabel = $("uberWeekStartLabel");
  const endLabel = $("uberWeekEndLabel");
  const stateLabel = $("uberWeekStateLabel");
  if (!startLabel || !endLabel || !stateLabel) return;

  startLabel.textContent = week ? formatUberWeekDate(week.weekStartDate) : "—";
  endLabel.textContent = week ? formatUberWeekDate(week.weekCloseDate) : "—";
  stateLabel.textContent = week ? "Falta cargar" : "Al día";
}
function renderUberWeekSelector() {
  const select = $("uberWeekSelect");
  const notice = $("uberPendingNotice");
  const amountInput = $("uberAmount");
  const saveButton = $("saveUberBtn");
  if (!select || !notice || !amountInput || !photoPicker("uber") || !saveButton) return;

  const pending = pendingUberWeeks();
  const previousValue = select.value;
  const hasPending = pending.length > 0;

  notice.classList.toggle("is-clear", !hasPending);
  if (hasPending) {
    notice.innerHTML = `<strong>${pending.length} ${pending.length === 1 ? "semana pendiente" : "semanas pendientes"}</strong><span>${pending.length === 1 ? "Seleccioná la semana cerrada y cargá su comprobante." : "Los comprobantes atrasados se acumulan. Cargá uno por cada semana."}</span>`;
    select.innerHTML = pending
      .map(week => `<option value="${week.weekStartDate}">${week.label} · Falta cargar</option>`)
      .join("");
    select.value = pending.some(week => week.weekStartDate === previousValue)
      ? previousValue
      : pending[0].weekStartDate;
  } else {
    const activeWeek = currentUberWeek();
    notice.innerHTML = `<strong>Comprobantes al día</strong><span>La semana ${activeWeek.label} todavía está en curso.</span>`;
    select.innerHTML = `<option value="">No hay semanas cerradas pendientes</option>`;
  }

  select.disabled = !hasPending;
  amountInput.disabled = !hasPending;
  setPhotoPickerDisabled("uber", !hasPending);
  saveButton.disabled = !hasPending;
  updateUberWeekSummary();
}
function renderUberPendingBadge() {
  const button = $("addUberBtn");
  const badge = $("uberPendingBadge");
  if (!button || !badge) return;
  const count = pendingUberWeeks().length;
  badge.textContent = String(count);
  badge.classList.toggle("hidden", count === 0);
  button.classList.toggle("has-pending-alert", count > 0);
  button.title = count
    ? `${count} ${count === 1 ? "semana de Uber pendiente" : "semanas de Uber pendientes"}`
    : "No hay semanas de Uber pendientes";
}
function formatDate(dateString) {
  const [y,m,d] = String(dateString || "").split("-").map(Number);
  if (!y || !m || !d) return "Sin fecha";
  return new Intl.DateTimeFormat("es-AR", {day:"2-digit", month:"2-digit", year:"2-digit"}).format(new Date(y,m-1,d));
}
function escapeHtml(s="") {
  return String(s).replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[c]));
}

function closureCutoffMs(item = {}) {
  const direct = Number(item.cutoffAtMs || item.requestedAtMs || item.createdAtMs || 0);
  if (direct > 0) return direct;
  return recordTimestampMs({
    createdAt: item.cutoffAt || item.requestedAt || item.createdAt || item.completedAt || item.closedAt,
    createdAtMs: item.cutoffAtMs || item.requestedAtMs || item.createdAtMs || item.completedAtMs || item.closedAtMs
  });
}

function closureInvalidatesCutoff(item = {}) {
  const text = [item.status, item.estado, item.closureStatus, item.paymentStatus, item.receiptStatus,
    item.rejectionReason, item.rollbackStatus, item.closureMode, item.periodType]
    .map(v => String(v || "").toLowerCase()).join(" | ");
  return item.rejected === true || item.rollbackRestored === true || item.invalidatesCutoff === true ||
    item.cutoffActive === false || /reject|rechaz|cancel|anulad|no aceptado|rejected_on_demand/.test(text);
}

function closureKind(item = {}) {
  const raw = String(item.closureKind || item.closureType || item.payTab || item.closeKind || item.kind ||
    item.cierreTipo || item.type || item.category || item.homeModule || item.homeTab || item.moduleKey || "").toLowerCase();
  if (/gasto|expense/.test(raw)) return "gastos";
  if (/caja|chica|cashbox/.test(raw)) return "caja_chica";
  if (/factur|billing|cobro|explora|digital|transfer|qr|card|tarjeta|chofer|driver|efectivo|cash/.test(raw)) return "facturacion";
  return "";
}

function closureUsesCutoff(item = {}) {
  const mode = String(item.closureMode || item.periodType || "").toLowerCase();
  // Misma regla que Santander Main: solo un cierre on_demand válido corta el período abierto.
  return mode === "on_demand" && !closureInvalidatesCutoff(item);
}

function lastBillingClosureMs() {
  return closures
    .filter(closureUsesCutoff)
    .filter(item => closureKind(item) === "facturacion")
    .map(closureCutoffMs)
    .filter(Boolean)
    .sort((a,b) => b-a)[0] || 0;
}

function lastExpensesClosureMs() {
  return closures
    .filter(closureUsesCutoff)
    .filter(item => closureKind(item) === "gastos")
    .map(closureCutoffMs)
    .filter(Boolean)
    .sort((a,b) => b-a)[0] || 0;
}

function billingClosureClosesCashbox(item = {}) {
  const affects = Array.isArray(item.affectsTabs) ? item.affectsTabs.map(v => String(v || "").toLowerCase()) : [];
  return item.autoClosesCashbox === true || item.cashboxClosedWithBilling === true || item.cashboxAutoClosed === true ||
    affects.some(v => /caja|cashbox/.test(v));
}

function lastCashboxResetMs() {
  // Un cierre de Facturación NO reinicia la caja chica ni la facturación.
  // Solo un cierre explícito del módulo Caja chica puede cortar ese módulo.
  return closures
    .filter(closureUsesCutoff)
    .filter(item => closureKind(item) === "caja_chica")
    .map(closureCutoffMs).filter(Boolean).sort((a,b)=>b-a)[0] || 0;
}

function billingMigrationBaselineMs() {
  // Conservamos exactamente el período abierto que ya existía en Santander Main.
  // Solo los cierres históricos `on_demand` anteriores a la migración fijan la base.
  // Los cierres nuevos usan `settlement_only`, por lo que NUNCA vuelven a reiniciar
  // la facturación: únicamente registran pagos/ajustes hasta llevar el saldo a cero.
  return lastBillingClosureMs();
}

function openBillingPayments() {
  const baseline = billingMigrationBaselineMs();
  return payments
    .filter(item => !movementIsDeleted(item))
    .filter(item => recordTimestampMs(item) > baseline);
}

function openCashboxAmount() {
  // Caja chica = 5% de (Efectivo + Uber) dentro del período abierto heredado
  // de Santander. Desde la migración en adelante no vuelve a reiniciarse.
  const baseline = billingMigrationBaselineMs();
  const regularCash = payments
    .filter(item => !movementIsDeleted(item) && !cashboxIsExcluded(item))
    .filter(item => recordTimestampMs(item) > baseline)
    .filter(item => item.method === "cash" && !isSettlementAdjustment(item) && !isReimbursementCompensation(item))
    .reduce((sum,item) => sum + Number(item.amount || 0), 0);
  const uberCash = uberClosures
    .filter(item => !movementIsDeleted(item))
    .filter(item => recordTimestampMs(item) > baseline)
    .filter(item => !/reject|rechaz/.test(String(item.reviewStatus || item.status || "").toLowerCase()))
    .reduce((sum,item) => sum + Number(item.amount || 0), 0);
  return (regularCash + uberCash) * 0.05;
}

function openExpenses() {
  const cutoff = lastExpensesClosureMs();
  return expenses.filter(item => recordTimestampMs(item) > cutoff);
}

// Billeteras espejo compensadas — regla operativa vigente:
// - Facturación compartida = efectivo + Uber + digital.
// - El chofer conserva físicamente 100% de efectivo y Uber, pero debe reintegrar 50% de ambos a Explora.
// - Caja chica = 5% de (efectivo + Uber) y también se suma a lo que debe liquidar el chofer.
// - Cada gasto lo paga el chofer y Explora reconoce automáticamente el 50%: ese 50%
//   se descuenta de lo que el chofer debe a Explora o se suma a lo que Explora debe al chofer.
// - Deudas y adelantos continúan como módulos separados.

// - Explora → Chofer: 50% de Digital que no se haya aplicado a un adelanto + 50% de Gastos.
// - El saldo positivo identifica quién debe compensar; el negativo, quién recibe.
// - Ambas billeteras muestran siempre el mismo saldo con signos opuestos.
function settlementModel() {
  const cashRevenue = revenueTotalFor("cash");
  const digitalRevenue = revenueTotalFor("digital");
  const driverPaid = adjustmentTotal("driver_to_explora");
  const exploraPaid = adjustmentTotal("explora_to_driver");
  const billingBaseline = billingMigrationBaselineMs();
  const uberRevenue = uberClosures
    .filter(item => !movementIsDeleted(item))
    .filter(item => recordTimestampMs(item) > billingBaseline)
    .filter(item => !/reject|rechaz/.test(String(item.reviewStatus || item.status || "").toLowerCase()))
    .reduce((sum,item) => sum + Number(item.amount || 0), 0);
  const cash = cashRevenue;
  const digital = digitalRevenue;
  const expense = billingExpensesTotal();
  const cashShare = cashRevenue * 0.50;
  const uberShare = uberRevenue * 0.50;
  const digitalShare = digitalRevenue * 0.50;
  const cashBox = openCashboxAmount();
  const expenseHalf = expense * 0.50;
  // Toda deuda creada por Explora se incorpora al saldo central al 100 %.
  // Las antiguas deudas automáticas de Uber quedan fuera para evitar duplicar
  // el 50 % de Uber que ya participa en Facturación.
  const adminDebt = debtsTotal();

  // MIGRACIÓN v69.2:
  // Las compensaciones históricas del sistema anterior NO eran acumulativas dentro
  // del cálculo de Facturación. Cada una guardaba una fotografía autoritativa
  // `settlementAfter` que también fue la que Telegram informó al chofer.
  // Por eso no sumamos $414.200 de comprobantes viejos: tomamos solamente la última
  // fotografía válida y, desde ese instante, aplicamos únicamente movimientos nuevos.
  const legacyAnchor = latestReimbursementSettlementAnchor(payments, billingBaseline);
  const postAnchor = legacyAnchor
    ? settlementMovementDeltaSince(legacyAnchor.timestamp, payments, uberClosures, expenses)
    : null;

  const automaticExpenseImpact = legacyAnchor
    ? postAnchor.automaticExpenseImpact
    : automaticExpenseBillingImpactTotal(expenses, billingBaseline);
  const reimbursementApplied = legacyAnchor ? legacyAnchor.amount : 0;
  const expenseBillingImpact = automaticExpenseImpact;
  const expenseReimbursement = Math.max(0, expenseHalf - reimbursementApplied - automaticExpenseImpact);

  let baseBalance;
  let balance;
  if (legacyAnchor) {
    baseBalance = legacyAnchor.balance;
    balance = legacyAnchor.balance + postAnchor.delta + adminDebt;
  } else {
    baseBalance = cashShare + uberShare + cashBox + adminDebt - digitalShare - automaticExpenseImpact;
    balance = baseBalance - driverPaid + exploraPaid;
  }

  const normalizedBalance = Math.abs(balance) > 0.5 ? balance : 0;
  const compensationAvailable = 0;

  return {
    cash, uber:uberRevenue, digital, expense,
    adminDebt, advanceDebt:advancesOutstandingTotal(), advanceRepaidToday:advanceRepaymentAppliedTotal(),
    driverHeld:cashRevenue + uberRevenue,
    cashShare, uberShare, digitalShare, digitalShareGross:digitalShare,
    cashBox, expenseHalf, expenseReimbursement, reimbursementApplied, automaticExpenseImpact, expenseBillingImpact, compensationAvailable,
    cashRevenue, digitalRevenue, driverPaid, exploraPaid, baseBalance,
    cashAdjusted:cashShare + uberShare + cashBox + exploraPaid,
    digitalAdjusted:digitalShare + automaticExpenseImpact + driverPaid,
    cashDebt:cashShare + uberShare + cashBox,
    digitalDebt:digitalShare + automaticExpenseImpact,
    balance:normalizedBalance, amount:Math.abs(normalizedBalance),
    driverWallet:normalizedBalance, exploraWallet:-normalizedBalance,
    from:normalizedBalance > 0.5 ? "cash" : normalizedBalance < -0.5 ? "digital" : "balanced",
    to:normalizedBalance > 0.5 ? "digital" : normalizedBalance < -0.5 ? "cash" : "balanced",
    grand:cashRevenue + uberRevenue + digitalRevenue,
    billingShareEach:(cashRevenue + uberRevenue + digitalRevenue) * 0.50,
    billingCutoffMs:billingBaseline,
    legacySettlementAnchor: legacyAnchor
  };
}

function renderDriverNews(settlementBalance) {
  const card = $("driverNewsCard");
  const title = $("driverNewsTitle");
  const text = $("driverNewsText");
  if (!card || !title || !text) return;

  const balance = Number(settlementBalance || 0);
  const amount = Math.abs(balance);
  card.classList.remove("is-driver-owes", "is-explora-owes", "is-balanced");

  if (amount <= 0.5) {
    card.classList.add("is-balanced");
    title.textContent = "Todo está en orden";
    text.textContent = "Tu cuenta está equilibrada con Explora. Seguí así.";
    return;
  }

  if (balance > 0.5) {
    card.classList.add("is-driver-owes");
    title.textContent = "Estás en rojo";
    text.textContent = "Pedí a los pasajeros que paguen en digital o pedí un cierre para pagar tu deuda con efectivo sobrante en mano, alias o depósito.";
    return;
  }

  card.classList.add("is-explora-owes");
  title.textContent = "Estás en verde";
  text.textContent = "Priorizá cobrar en efectivo. También podés pedir un cierre para cobrar a Explora la deuda pendiente.";
}

function renderWalletStatus(elementId, settlementBalance) {
  const element = $(elementId);
  if (!element) return;

  renderDriverNews(settlementBalance);

  const differenceHint = $("settlementDifferenceHint");
  const amount = Math.abs(Number(settlementBalance || 0));

  element.classList.remove(
    "is-paying",
    "is-receiving",
    "is-balanced",
    "is-hidden-direction",
    "is-driver-owes",
    "is-explora-owes"
  );
  if (differenceHint) {
    differenceHint.classList.remove("is-driver-owes", "is-explora-owes", "is-balanced");
  }

  if (amount <= 0.5) {
    element.textContent = "Cuentas equilibradas";
    element.classList.add("is-balanced");
    if (differenceHint) {
      differenceHint.textContent = "Vos y Explora están equilibrados. No hay diferencia pendiente.";
      differenceHint.classList.add("is-balanced");
    }
    return;
  }

  if (settlementBalance > 0.5) {
    element.textContent = "Chofer debe liquidar a Explora";
    element.classList.add("is-driver-owes");
    if (differenceHint) {
      differenceHint.textContent = `Tenés ${money(amount)} más de tu lado que Explora. Esa diferencia corresponde a Explora.`;
      differenceHint.classList.add("is-driver-owes");
    }
    return;
  }

  element.textContent = "Explora debe liquidar al chofer";
  element.classList.add("is-explora-owes");
  if (differenceHint) {
    differenceHint.textContent = `Explora tiene ${money(amount)} más de su lado que vos. Esa diferencia te corresponde a vos.`;
    differenceHint.classList.add("is-explora-owes");
  }
}

function openDebtCompensationModal() {
  const modal = $("debtCompensationModal");
  if (!modal) return;
  const model = settlementModel();

  $("compensationReimbursementAvailable").textContent = money(model.expenseReimbursement);
  $("compensationDebtAvailable").textContent = money(Math.max(0, model.balance));
  $("compensationMaximum").textContent = money(model.compensationAvailable);
  if (model.compensationAvailable > 0.5) {
    $("compensationOutcome").textContent = `Se utilizarán ${money(model.compensationAvailable)}. El nuevo saldo que el chofer deberá compensar será de ${money(model.balance - model.compensationAvailable)} y el reintegro pendiente quedará en ${money(model.expenseReimbursement - model.compensationAvailable)}.`;
  } else if (model.expenseReimbursement <= 0.5) {
    $("compensationOutcome").textContent = "Todavía no hay dinero pendiente de reintegro para utilizar en una compensación.";
  } else {
    $("compensationOutcome").textContent = "El chofer no tiene una diferencia pendiente a favor de Explora para compensar con este reintegro.";
  }
  $("debtCompensationStatus").textContent = "";
  $("debtCompensationStatus").className = "status";
  $("confirmDebtCompensation").disabled = model.compensationAvailable <= 0.5;
  $("confirmDebtCompensation").textContent = model.compensationAvailable > 0.5 ? "OK, compensar" : "Sin saldo para compensar";
  modal.classList.remove("hidden");
}

function advanceQuote(principalValue) {
  const principal = Math.max(0, Number(principalValue || 0));
  const interest = Math.round(principal * ADVANCE_INTEREST_RATE);
  return { principal, interest, total: principal + interest };
}

function renderAdvanceQuote() {
  const input = $("advanceAmount");
  if (!input) return;
  const quote = advanceQuote(parseMoneyInput(input.value));
  const principal = $("advancePrincipalPreview");
  const interest = $("advanceInterestPreview");
  const total = $("advanceTotalPreview");
  if (principal) principal.textContent = money(quote.principal);
  if (interest) interest.textContent = money(quote.interest);
  if (total) total.textContent = money(quote.total);
}

function openAdvanceModal() {
  if (isAdminProfile()) return;
  const form = $("advanceForm");
  const modal = $("advanceModal");
  if (!form || !modal) return;
  form.reset();
  $("advanceStatus").textContent = "";
  $("advanceStatus").className = "status";
  $("confirmAdvanceBtn").disabled = false;
  $("confirmAdvanceBtn").textContent = "Confirmar adelanto";
  renderAdvanceQuote();
  modal.classList.remove("hidden");
}


function buildUnifiedReceipts() {
  const regularPayments = payments
    .filter(item => !movementIsDeleted(item))
    .map(item => ({ ...item, _sortPriority: 2 }));

  // Cada cobro en efectivo muestra dos comprobantes visuales: el cobro y el
  // 5 % que se generó automáticamente. El segundo se deriva del primero para
  // que una corrección o eliminación nunca deje valores huérfanos.
  const cashboxReceipts = regularPayments
    .filter(item => item.method === "cash")
    .filter(item => !isSettlementAdjustment(item) && !isReimbursementCompensation(item))
    .filter(item => !cashboxIsExcluded(item))
    .map(item => ({
      ...item,
      id: `${item.id}_cashbox_5`,
      type: "cashbox_receipt",
      service: "Caja chica 5%",
      detail: `Generada automáticamente por el cobro en efectivo${item.detail ? ` · ${item.detail}` : ""}`,
      amount: Number(item.amount || 0) * 0.05,
      proofUrl: "",
      proofPath: "",
      _sortPriority: 1
    }));

  const debtReceipts = debts
    .filter(item => !movementIsDeleted(item) && debtImpactsSettlement(item))
    .map(item => ({
      ...item,
      method: "debt",
      type: "admin_debt",
      service: "Deuda agregada por Explora",
      amount: Number(item.totalAmount || item.originalAmount || item.amount || 0),
      detail: item.detail || item.reason || "Deuda del chofer",
      _sortPriority: 2
    }));

  const advanceReceipts = advances.map(item => {
    const state = String(item.approvalStatus || item.status || "active").toLowerCase();
    const pending = /pending/.test(state);
    const rejected = /reject|rechaz/.test(state);
    return {
      ...item,
      method: "advance",
      type: "cash_advance",
      amount: Number(item.principalAmount || item.originalAmount || item.amount || 0),
      service: pending ? "Adelanto solicitado" : rejected ? "Adelanto rechazado" : "Adelanto en efectivo",
      detail: pending
        ? `Pendiente de aprobación de Admin · Total si se aprueba: ${money(item.totalDebt)}`
        : rejected
          ? `Solicitud rechazada por Admin · Monto solicitado: ${money(item.principalAmount || item.originalAmount || item.amount || 0)}`
          : `Deuda con 40%: ${money(item.totalDebt)} · Saldo pendiente: ${money(advanceRemaining(item))}`,
      _sortPriority: 2
    };
  });

  const uberReceipts = uberClosures
    .filter(item => !movementIsDeleted(item))
    .map(item => ({
      ...item,
      method: "uber",
      type: "uber_receipt",
      service: "Comprobante de Uber",
      detail: `Semana ${uberWeekLabelForItem(item)} · incluye caja chica 5%`,
      _sortPriority: 2
    }));

  const expenseReceipts = expenses
    .filter(item => !movementIsDeleted(item))
    .map(item => ({
      ...item,
      method: "expense",
      type: "expense_receipt",
      service: "Gasto",
      detail: `${item.detail || "Gasto"} · Explora reconoce 50%: ${money(Number(item.amount || 0) * 0.5)}`,
      _sortPriority: 2
    }));

  return [
    ...regularPayments,
    ...cashboxReceipts,
    ...debtReceipts,
    ...advanceReceipts,
    ...uberReceipts,
    ...expenseReceipts
  ].sort((a, b) => {
    const byDate = recordTimestampMs(b) - recordTimestampMs(a);
    if (byDate) return byDate;
    return Number(b._sortPriority || 0) - Number(a._sortPriority || 0);
  });
}

function render() {
  syncDriverDebtConfirmationModal();
  const model = settlementModel();
  const receipts = buildUnifiedReceipts();
  const visibleReceipts = receipts.slice(0, Math.max(RECENT_RECEIPTS_LIMIT, visibleReceiptCount));

  setAnimatedMoney("settlementTotal", model.balance);
  renderWalletStatus("settlementDirection", model.balance);
  $("receiptCount").textContent = receipts.length;

  const toggle = $("receiptsToggle");
  toggle.classList.toggle("hidden", visibleReceiptCount >= receipts.length);
  toggle.textContent = "Ver más comprobantes";

  renderUberPendingBadge();
  renderList("receiptList", visibleReceipts);
  window.setTimeout(maybeShowDriverDebtConfirmation, 0);
}

function debtProofIsImage(item = {}) {
  const mime = String(item.proofMimeType || item.receiptMimeType || "").toLowerCase();
  if (mime.startsWith("image/")) return true;
  if (mime === "application/pdf") return false;
  const path = String(item.proofPath || item.receiptPath || item.proofFileName || item.receiptFileName || item.proofUrl || "").toLowerCase();
  if (/\.pdf(?:$|[?#])/.test(path)) return false;
  return /\.(?:png|jpe?g|webp|gif|heic|heif)(?:$|[?#])/.test(path) || Boolean(item.proofUrl);
}

function settlementPreviewCopy(balance) {
  const value = Math.abs(Number(balance || 0)) <= 0.5 ? 0 : Number(balance || 0);
  if (value > 0) return { label:"Vos debés a Explora", amount:value, tone:"driver" };
  if (value < 0) return { label:"Explora te debe", amount:Math.abs(value), tone:"explora" };
  return { label:"Cuenta equilibrada", amount:0, tone:"balanced" };
}

let activeDriverDebtConfirmationId = "";
let acceptingDriverDebtConfirmation = false;

function closeDriverDebtConfirmationModal() {
  $("driverDebtConfirmationModal")?.classList.add("hidden");
  document.documentElement.classList.remove("driver-debt-modal-open");
  document.body.classList.remove("driver-debt-modal-open");
  activeDriverDebtConfirmationId = "";
}

function syncDriverDebtConfirmationModal() {
  if (acceptingDriverDebtConfirmation || !activeDriverDebtConfirmationId) return;
  const modal = $("driverDebtConfirmationModal");
  if (!modal || modal.classList.contains("hidden")) return;
  const stillPending = pendingDriverDebtConfirmations().some(item => item.id === activeDriverDebtConfirmationId);
  if (!stillPending) closeDriverDebtConfirmationModal();
}

function renderDriverDebtConfirmation(item = {}) {
  const modal = $("driverDebtConfirmationModal");
  const body = $("driverDebtConfirmationBody");
  const accept = $("acceptDriverDebtBtn");
  const status = $("driverDebtConfirmationStatus");
  if (!modal || !body || !accept || !status || !item?.id) return;

  const amount = Math.max(0, Number(item.totalAmount || item.originalAmount || item.amount || 0));
  const currentBalance = Number(settlementModel().balance || 0);
  const afterBalance = currentBalance + amount;
  const before = settlementPreviewCopy(currentBalance);
  const after = settlementPreviewCopy(afterBalance);
  const concept = String(item.detail || item.reason || item.notes || "Deuda agregada por Explora").trim();
  const proofUrl = String(item.proofUrl || item.receiptUrl || "");
  const imageProof = proofUrl && debtProofIsImage(item);

  activeDriverDebtConfirmationId = item.id;
  acceptingDriverDebtConfirmation = false;
  status.textContent = "";
  status.className = "status driver-debt-confirmation-status";
  accept.disabled = false;
  accept.textContent = "Aceptar deuda";

  body.innerHTML = `
    <div class="driver-debt-alert-badge">Explora agregó una deuda</div>
    <div class="driver-debt-confirmation-amount">${money(amount)}</div>
    <div class="driver-debt-confirmation-concept"><span>Concepto</span><strong>${escapeHtml(concept)}</strong></div>
    ${proofUrl ? (imageProof
      ? `<a class="driver-debt-confirmation-proof" target="_blank" rel="noopener" href="${escapeHtml(proofUrl)}" aria-label="Abrir comprobante de deuda"><img src="${escapeHtml(proofUrl)}" alt="Comprobante de ${escapeHtml(concept)}"></a>`
      : `<a class="driver-debt-confirmation-proof-link" target="_blank" rel="noopener" href="${escapeHtml(proofUrl)}">Abrir comprobante adjunto</a>`)
      : `<div class="driver-debt-confirmation-proof-missing">Comprobante no disponible.</div>`}
    <div class="driver-debt-balance-grid" aria-label="Saldo antes y después de aceptar la deuda">
      <div class="driver-debt-balance-card is-${before.tone}">
        <span>Ahora</span>
        <strong>${escapeHtml(before.label)}</strong>
        <b>${money(before.amount)}</b>
      </div>
      <div class="driver-debt-balance-card is-${after.tone}">
        <span>Después de aceptar</span>
        <strong>${escapeHtml(after.label)}</strong>
        <b>${money(after.amount)}</b>
      </div>
    </div>
    <p class="driver-debt-confirmation-note">Al tocar “Aceptar deuda”, este importe se incorporará al saldo con Explora y aparecerá abajo como comprobante.</p>`;

  modal.classList.remove("hidden");
  document.documentElement.classList.add("driver-debt-modal-open");
  document.body.classList.add("driver-debt-modal-open");
  window.setTimeout(() => accept.focus({ preventScroll:true }), 60);
}

function maybeShowDriverDebtConfirmation() {
  if (!auth.currentUser || isAdminProfile() || acceptingDriverDebtConfirmation) return;
  const modal = $("driverDebtConfirmationModal");
  if (!modal) return;
  if (!modal.classList.contains("hidden")) return;

  const anotherModalOpen = Array.from(document.querySelectorAll(".modal:not(.hidden)"))
    .some(node => node.id !== "driverDebtConfirmationModal");
  if (anotherModalOpen) return;

  const pending = pendingDriverDebtConfirmations();
  if (pending.length) renderDriverDebtConfirmation(pending[0]);
}

async function acceptDriverDebtConfirmation() {
  if (acceptingDriverDebtConfirmation || !activeDriverDebtConfirmationId || isAdminProfile()) return;
  const user = auth.currentUser;
  const item = debts.find(row => row.id === activeDriverDebtConfirmationId);
  const accept = $("acceptDriverDebtBtn");
  const status = $("driverDebtConfirmationStatus");
  if (!user || !item || !debtRequiresDriverConfirmation(item)) {
    closeDriverDebtConfirmationModal();
    acceptingDriverDebtConfirmation = false;
    window.setTimeout(maybeShowDriverDebtConfirmation, 0);
    return;
  }

  acceptingDriverDebtConfirmation = true;
  accept.disabled = true;
  accept.textContent = "Confirmando…";
  status.textContent = "Guardando aceptación…";
  status.className = "status driver-debt-confirmation-status";

  try {
    await setDoc(doc(db, ROOT_COLLECTIONS.debts, item.id), {
      acknowledgedByDriver: true,
      acknowledgedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }, { merge:true });

    item.acknowledgedByDriver = true;
    status.textContent = "Deuda aceptada y sumada al saldo.";
    status.className = "status success driver-debt-confirmation-status";
    accept.textContent = "Aceptada ✓";
    render();
    window.setTimeout(() => {
      closeDriverDebtConfirmationModal();
      acceptingDriverDebtConfirmation = false;
      window.setTimeout(maybeShowDriverDebtConfirmation, 120);
    }, 700);
  } catch (err) {
    console.error("No se pudo aceptar la deuda:", err);
    acceptingDriverDebtConfirmation = false;
    accept.disabled = false;
    accept.textContent = "Aceptar deuda";
    status.textContent = "No se pudo confirmar. Revisá la conexión e intentá nuevamente.";
    status.className = "status error driver-debt-confirmation-status";
  }
}

$("acceptDriverDebtBtn")?.addEventListener("click", acceptDriverDebtConfirmation);

function receiptFooterLabel(item = {}) {
  if (isUberReceipt(item)) return `Semana ${escapeHtml(uberWeekLabelForItem(item))}`;
  if (isCashAdvance(item)) {
    const state = String(item.approvalStatus || item.status || "").toLowerCase();
    if (/pending/.test(state)) return "Pendiente de Admin";
    if (/reject|rechaz/.test(state)) return "Rechazado";
    return advanceRemaining(item) <= 0.5 ? "Adelanto pagado" : "Sin vencimiento";
  }
  const timestamp = recordTimestampMs(item);
  if (!timestamp) return "Ahora";
  const date = new Date(timestamp);
  const time = date.toLocaleTimeString("es-AR", { hour:"2-digit", minute:"2-digit" });
  return recordDayKey(item) === localDayKey()
    ? `Hoy · ${time}`
    : `${date.toLocaleDateString("es-AR", { day:"2-digit", month:"2-digit", year:"2-digit" })} · ${time}`;
}

function renderList(containerId, items) {
  const box = $(containerId);
  if (!items.length) {
    box.innerHTML = `<div class="empty">Los cobros, gastos, Uber y deudas aparecerán acá.</div>`;
    return;
  }

  box.innerHTML = items.map(item => {
    const uberReceipt = isUberReceipt(item);
    const debtCompensation = isReimbursementCompensation(item);
    const cashAdvance = isCashAdvance(item);
    const expenseReceipt = isExpenseReceipt(item);
    const cashboxReceipt = isCashboxReceipt(item);
    const adminDebt = isAdminDebt(item);
    const digitalReceipt = item.method === "digital" && !isSettlementAdjustment(item);
    const regularCashReceipt = item.method === "cash"
      && !isSettlementAdjustment(item)
      && !adminDebt
      && !debtCompensation
      && !cashAdvance
      && !expenseReceipt
      && !uberReceipt
      && !cashboxReceipt;
    const proofUrl = String(item.proofUrl || item.receiptUrl || "");
    const imageProof = proofUrl && debtProofIsImage(item);
    const proofLabel = cashboxReceipt
      ? "Caja chica"
      : regularCashReceipt
        ? "Cobro en efectivo"
        : debtCompensation
          ? "Comprobante interno"
          : cashAdvance
            ? (/pending/.test(String(item.approvalStatus || item.status || "").toLowerCase()) ? "Esperando Admin" : /reject|rechaz/.test(String(item.approvalStatus || item.status || "").toLowerCase()) ? "Rechazado" : "Aprobado")
            : adminDebt
              ? "Deuda agregada"
              : digitalReceipt
                ? "Cobro digital"
                : expenseReceipt
                  ? "Gasto"
                  : uberReceipt
                    ? "Uber"
                    : isSettlementAdjustment(item)
                      ? "Cierre"
                      : "Operación registrada";
    const proof = proofUrl
      ? (imageProof
          ? `<a class="receipt-proof-thumb" target="_blank" rel="noopener" href="${escapeHtml(proofUrl)}" aria-label="Abrir comprobante"><img src="${escapeHtml(proofUrl)}" alt="Comprobante de ${escapeHtml(item.service || proofLabel)}"></a>`
          : `<a class="receipt-proof-file" target="_blank" rel="noopener" href="${escapeHtml(proofUrl)}" aria-label="Abrir archivo adjunto">PDF</a>`)
      : `<span class="proof internal-proof">${escapeHtml(proofLabel)}</span>`;

    const icon = cashboxReceipt
      ? `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="8" r="2"/><circle cx="16" cy="16" r="2"/><path d="M7 17 17 7"/></svg>`
      : expenseReceipt
        ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>`
        : uberReceipt
          ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 16h14M7 16l1-5h8l1 5M8 11l1.2-3h5.6l1.2 3M6.5 19a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM17.5 19a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"/></svg>`
          : debtCompensation
            ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 12 4 4 8-9M5 20h14"/></svg>`
            : cashAdvance
              ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v18M7 7.5h7.2a3 3 0 0 1 0 6H9.8a3 3 0 0 0 0 6H17"/></svg>`
              : adminDebt
                ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M12 19h.01M5 21h14L12 3 5 21Z"/></svg>`
                : digitalReceipt
                  ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8"/></svg>`
                  : `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>`;

    const amountPrefix = debtCompensation ? "−" : "+";
    const receiptToneClass = expenseReceipt
      ? "receipt-tone-expense"
      : uberReceipt
        ? "receipt-tone-uber"
        : (cashboxReceipt || regularCashReceipt)
          ? "receipt-tone-cash"
          : digitalReceipt
            ? "receipt-tone-digital"
            : "receipt-tone-other";

    const receiptClass = [
      item.method === "digital" ? "receipt-digital" : "receipt-cash",
      receiptToneClass,
      isSettlementAdjustment(item) ? "receipt-adjustment" : "",
      adminDebt ? "receipt-debt" : "",
      expenseReceipt ? "receipt-expense" : "",
      uberReceipt ? "receipt-uber" : "",
      cashboxReceipt ? "receipt-cashbox" : "",
      debtCompensation ? "receipt-debt-compensation" : "",
      cashAdvance ? "receipt-advance" : ""
    ].filter(Boolean).join(" ");

    return `<article class="receipt ${receiptClass}">
      <div class="receipt-main">
        <span class="receipt-icon">${icon}</span>
        <div class="receipt-copy">
          <strong>${escapeHtml(item.service || "Comprobante")}</strong>
          <small>${escapeHtml(item.detail || "Operación registrada")}</small>
        </div>
        <div class="amount">${amountPrefix}${money(item.amount)}</div>
      </div>
      <div class="receipt-footer">
        <span>${receiptFooterLabel(item)}</span>${proof}
      </div>
    </article>`;
  }).join("");
}

$("receiptsToggle")?.addEventListener("click", () => {
  visibleReceiptCount += RECEIPTS_PAGE_SIZE;
  render();
});

async function loadProfile(user) {
  const directRefs = [doc(db, "usuarios", user.uid), doc(db, "choferes", user.uid)];
  for (const profileRef of directRefs) {
    try {
      const snap = await getDoc(profileRef);
      if (snap.exists()) {
        const data = snap.data() || {};
        return {
          ...data,
          username: data.username || data.usuario || user.email?.split("@")[0] || "explora",
          displayName: data.displayName || data.nombre || data.nombreCompleto || user.displayName || user.email?.split("@")[0] || "Explora",
          role: profileRole(data, user),
          active: !(data.active === false || data.activo === false || String(data.estado || "").toLowerCase() === "inactivo")
        };
      }
    } catch (_) {}
  }

  try {
    const byUid = await getDocs(query(collection(db, "choferes"), where("uid", "==", user.uid), limit(1)));
    if (!byUid.empty) {
      const data = byUid.docs[0].data() || {};
      return {
        ...data,
        username: data.username || data.usuario || user.email?.split("@")[0] || "explora",
        displayName: data.displayName || data.nombre || data.nombreCompleto || user.displayName || user.email?.split("@")[0] || "Explora",
        role: profileRole(data, user),
        active: !(data.active === false || data.activo === false || String(data.estado || "").toLowerCase() === "inactivo")
      };
    }
  } catch (_) {}

  if (user.email) {
    try {
      const byEmail = await getDocs(query(collection(db, "choferes"), where("email", "==", user.email.toLowerCase()), limit(1)));
      if (!byEmail.empty) {
        const data = byEmail.docs[0].data() || {};
        return {
          ...data,
          username: data.username || data.usuario || user.email.split("@")[0],
          displayName: data.displayName || data.nombre || data.nombreCompleto || user.displayName || user.email.split("@")[0],
          role: profileRole(data, user),
          active: !(data.active === false || data.activo === false || String(data.estado || "").toLowerCase() === "inactivo")
        };
      }
    } catch (_) {}
  }

  return fallbackProfile(user);
}

function subscribeToday(user) {
  if (unsubscribePayments) unsubscribePayments();
  if (unsubscribeExpenses) unsubscribeExpenses();
  if (unsubscribeUber) unsubscribeUber();
  if (unsubscribeDebts) unsubscribeDebts();
  if (unsubscribeDebtPayments) unsubscribeDebtPayments();
  if (unsubscribeAdvances) unsubscribeAdvances();
  advancesLoaded = false;

  const uid = user.uid;
  const setup = ({ collectionName, normalizer, assign, onError, afterRender }) => {
    // Primero recupera todos los aliases históricos de Santander.
    loadOwnedHistory(collectionName, uid).then(rows => {
      const merged = mergeOwnedRows(collectionName, uid, canonicalRows(collectionName, uid));
      assign(merged.map(row => normalizer(row.id, row)).sort((a,b)=>recordTimestampMs(b)-recordTimestampMs(a)));
      render();
      afterRender?.();
    }).catch(err => console.warn("EXPLORA_HISTORY_LOAD", collectionName, err));

    // Luego mantiene en vivo el camino canónico driverUid para todos los movimientos nuevos.
    return onSnapshot(ownedQuery(collectionName, uid), snap => {
      const canon = snap.docs.map(d => ({ id:d.id, ...d.data() }));
      setCanonicalRows(collectionName, uid, canon);
      const merged = mergeOwnedRows(collectionName, uid, canon);
      assign(merged.map(row => normalizer(row.id, row)).sort((a,b)=>recordTimestampMs(b)-recordTimestampMs(a)));
      render();
      afterRender?.();
      $("syncStatus").textContent = "En tiempo real";
      $("syncStatus").className = "sync ok";
    }, err => {
      console.error(`Firestore ${collectionName} snapshot error:`, err);
      onError?.(err);
    });
  };

  $("syncStatus").textContent = "Sincronizando período…";
  $("syncStatus").className = "sync";

  unsubscribePayments = setup({
    collectionName:ROOT_COLLECTIONS.payments,
    normalizer:normalizePaymentRecord,
    assign:rows => { payments = rows; },
    onError:() => { $("syncStatus").textContent = "Error de datos"; $("syncStatus").className = "sync bad"; }
  });
  unsubscribeExpenses = setup({
    collectionName:ROOT_COLLECTIONS.expenses,
    normalizer:normalizeExpenseRecord,
    assign:rows => { expenses = rows; },
    onError:() => { $("syncStatus").textContent = "Error de gastos"; $("syncStatus").className = "sync bad"; }
  });
  unsubscribeUber = setup({
    collectionName:ROOT_COLLECTIONS.uber,
    normalizer:normalizeUberRecord,
    assign:rows => { uberClosures = rows.filter(item => item.noData !== true); },
    afterRender:() => { if (!$("uberModal")?.classList.contains("hidden")) renderUberWeekSelector(); },
    onError:() => { $("syncStatus").textContent = "Error de Uber"; $("syncStatus").className = "sync bad"; }
  });
  unsubscribeDebts = setup({
    collectionName:ROOT_COLLECTIONS.debts,
    normalizer:normalizeDebtRecord,
    assign:rows => { debts = rows.filter(item => item.amount > 0); },
    onError:() => { $("syncStatus").textContent = "Error de deudas"; $("syncStatus").className = "sync bad"; }
  });
  unsubscribeDebtPayments = setup({
    collectionName:ROOT_COLLECTIONS.debtPayments,
    normalizer:normalizeDebtPaymentRecord,
    assign:rows => { debtPayments = rows; },
    onError:() => { console.warn("No se pudieron sincronizar los pagos de deuda históricos."); }
  });
  unsubscribeAdvances = setup({
    collectionName:ROOT_COLLECTIONS.advances,
    normalizer:normalizeAdvanceRecord,
    assign:rows => {
      advances = rows.filter(item => item.type === "cash_advance" || item.loanType === "cash_advance");
      advancesLoaded = true;
    },
    onError:() => { advances = []; advancesLoaded = true; render(); $("syncStatus").textContent = "Error de adelantos"; $("syncStatus").className = "sync bad"; }
  });
}

function isAdminProfile() {
  return EXPLORA_ADMIN_UIDS.has(auth.currentUser?.uid || "") || currentProfile?.role === "admin";
}

function applyRoleUI() {
  const admin = isAdminProfile();
  resetTeamRealtimeDisclosure();
  $("driverDashboard")?.classList.toggle("hidden", admin);
  $("adminDashboard")?.classList.toggle("hidden", !admin);
  // En Admin, el único botón de salida queda dentro del panel para evitar duplicados.
  $("logoutBtn")?.classList.toggle("hidden", admin);

  // Main unificado v71: algunos controles históricos ya no existen en el HTML.
  // Todos los accesos visuales de este cambio deben tolerar que el elemento haya
  // sido retirado para no interrumpir el arranque ni dejar el splash en Cargando.
  const closeDayButton = $("closeDayBtn");
  if (closeDayButton) closeDayButton.textContent = admin ? "Gestionar cierres" : "Pedir cierre";
  $("addDebtBtn")?.classList.toggle("hidden", !admin);
  $("advanceBox")?.classList.toggle("hidden", admin);
}


function adminDriverLabel(driver = {}) {
  return String(driver.displayName || driver.nombreCompleto || driver.nombre || driver.username || driver.usuario || "Chofer").trim() || "Chofer";
}

function adminDriverIsActive(driver = {}) {
  const state = String(driver.status || driver.estado || "").trim().toLowerCase();
  return driver.active !== false
    && driver.activo !== false
    && driver.deleted !== true
    && driver.isDeleted !== true
    && driver.eliminado !== true
    && !/inactiv|disabled|eliminad|deleted/.test(state);
}

function teamRealtimeDriverLabel(row = {}) {
  return String(row.driverName || row.displayName || row.nombre || row.username || "").trim();
}

function teamRealtimeHasValidDriver(row = {}) {
  return Boolean(teamRealtimeDriverLabel(row));
}

function setTeamRealtimeExpanded(expanded = false) {
  const card = document.querySelector(".team-realtime-card");
  const button = $("teamRealtimeToggle");
  if (!card || !button) return;
  card.classList.toggle("is-collapsed", !expanded);
  button.textContent = expanded ? "Cerrar choferes" : "Abrir choferes";
  button.setAttribute("aria-expanded", expanded ? "true" : "false");
}

function resetTeamRealtimeDisclosure() {
  setTeamRealtimeExpanded(false);
}

function teamRealtimeSignedBalance(row = {}) {
  const explicit = Number(row.settlementBalance);
  if (Number.isFinite(explicit)) return Math.abs(explicit) > 0.5 ? explicit : 0;
  const amount = Math.max(0, Number(row.amount || 0));
  const direction = String(row.direction || "").toLowerCase();
  if (direction === "driver_to_explora") return amount;
  if (direction === "explora_to_driver") return -amount;
  return 0;
}

function teamRealtimeIsCurrentDriver(row = {}) {
  const uid = String(auth.currentUser?.uid || "");
  if (!uid) return false;
  return [row.driverUid, row.profileDocumentId, row.driverId]
    .map(value => String(value || ""))
    .includes(uid);
}

function renderTeamRealtimeList() {
  const box = $("teamRealtimeList");
  if (!box) return;

  const rows = teamRealtimeBalances
    .filter(row => row.active !== false)
    .filter(teamRealtimeHasValidDriver)
    .sort((a, b) => teamRealtimeDriverLabel(a).localeCompare(teamRealtimeDriverLabel(b), "es", { sensitivity:"base" }));

  if (!rows.length) {
    box.innerHTML = teamRealtimeLoadError
      ? `<div class="team-realtime-empty error">${escapeHtml(teamRealtimeLoadError)}</div>`
      : `<div class="team-realtime-empty">Preparando saldos en tiempo real…</div>`;
    return;
  }

  box.innerHTML = rows.map(row => {
    const balance = teamRealtimeSignedBalance(row);
    const amount = Math.abs(balance);
    const stateClass = balance > 0.5 ? "driver-owes" : balance < -0.5 ? "explora-owes" : "balanced";
    const label = balance > 0.5
      ? "Chofer debe liquidar a Explora"
      : balance < -0.5
        ? "Explora debe liquidar al chofer"
        : "Cuentas equilibradas";
    const currentClass = teamRealtimeIsCurrentDriver(row) ? "is-current-driver" : "";
    return `<article class="team-driver-row ${stateClass} ${currentClass}">
      <strong class="team-driver-name">${escapeHtml(teamRealtimeDriverLabel(row))}</strong>
      <div class="team-driver-balance">
        <span>${label}</span>
        <b>${money(amount)}</b>
      </div>
    </article>`;
  }).join("");
}

function unsubscribeTeamRealtimeDashboard() {
  if (unsubscribeTeamRealtimeBalances) {
    try { unsubscribeTeamRealtimeBalances(); } catch (_) {}
  }
  unsubscribeTeamRealtimeBalances = null;
}

function subscribeTeamRealtimeDashboard() {
  unsubscribeTeamRealtimeDashboard();
  teamRealtimeLoadError = "";
  renderTeamRealtimeList();

  unsubscribeTeamRealtimeBalances = onSnapshot(
    collection(db, TEAM_REALTIME_BALANCES_COLLECTION),
    snapshot => {
      teamRealtimeBalances = snapshot.docs.map(document => ({ id:document.id, ...document.data() }));
      teamRealtimeLoadError = "";
      renderTeamRealtimeList();
      renderAdminDriverList();
    },
    error => {
      console.error("No se pudieron sincronizar los saldos del equipo:", error);
      teamRealtimeLoadError = "No se pudieron cargar los saldos en tiempo real.";
      renderTeamRealtimeList();
    }
  );

  ensureTeamRealtimeBalancesCallable({})
    .catch(error => {
      console.warn("No se pudo inicializar Tiempo real:", error);
      if (!teamRealtimeBalances.length) {
        teamRealtimeLoadError = "No se pudieron preparar los saldos en tiempo real.";
        renderTeamRealtimeList();
      }
    });
}

function unsubscribeOwnProfileDashboard() {
  if (unsubscribeOwnProfileStatus) {
    try { unsubscribeOwnProfileStatus(); } catch (_) {}
  }
  unsubscribeOwnProfileStatus = null;
  disabledProfileSignoutInProgress = false;
}

function subscribeOwnProfileDashboard(user) {
  unsubscribeOwnProfileDashboard();
  if (!user?.uid || EXPLORA_ADMIN_UIDS.has(user.uid)) return;
  unsubscribeOwnProfileStatus = onSnapshot(doc(db, "choferes", user.uid), async snapshot => {
    if (!snapshot.exists() || adminDriverIsActive(snapshot.data() || {}) || disabledProfileSignoutInProgress) return;
    disabledProfileSignoutInProgress = true;
    try {
      await signOut(auth);
      $("loginStatus").textContent = "Este usuario fue inhabilitado por el administrador.";
      $("loginStatus").className = "status error";
    } catch (error) {
      console.error("No se pudo cerrar la sesión inhabilitada:", error);
      disabledProfileSignoutInProgress = false;
    }
  }, error => {
    console.warn("No se pudo vigilar el estado del chofer:", error);
  });
}

function adminDriverIsAdministrator(driver = {}) {
  const role = String(driver.role || driver.rol || "").trim().toLowerCase();
  return EXPLORA_ADMIN_UIDS.has(String(driver.id || driver.uid || driver.authUid || ""))
    || ["admin", "administrador", "owner", "superadmin"].includes(role);
}

function adminDriverIdentitySet(driver = {}) {
  const values = [
    driver.id, driver.uid, driver.authUid, driver.firebaseUid, driver.userId,
    driver.driverUid, driver.driverId, driver.choferUid, driver.choferId,
    driver.profileId, driver.profileDocumentId, driver.usuario, driver.username,
    driver.usuarioNormalizado, driver.email, driver.authEmail, driver.contactEmail,
    driver.correo
  ];
  return new Set(values.map(value => String(value || "").trim().toLowerCase()).filter(Boolean));
}

function adminRecordIdentityValues(item = {}) {
  const values = [
    item.driverUid, item.choferUid, item.uid, item.ownerUid, item.driverId, item.choferId,
    item.driver_id, item.chofer_id, item.userUid, item.userId, item.ownerId,
    item.conductorUid, item.conductorId, item.assignedDriverUid,
    item.enteredOnBehalfOf, item.simulationDriverUid, item.operatorUid
  ];
  return values.map(value => String(value || "").trim().toLowerCase()).filter(Boolean);
}

function adminRecordBelongsToDriver(item = {}, driver = {}) {
  const aliases = adminDriverIdentitySet(driver);
  const ownershipValues = adminRecordIdentityValues(item);
  if (ownershipValues.length) return ownershipValues.some(value => aliases.has(value));

  // Solo para históricos sin UID: usar el nombre como último recurso.
  const driverNames = new Set([
    driver.displayName, driver.nombreCompleto, driver.nombre
  ].map(value => String(value || "").trim().toLowerCase()).filter(Boolean));
  const recordNames = [
    item.operatorName, item.driverName, item.choferNombre, item.nombreChofer
  ].map(value => String(value || "").trim().toLowerCase()).filter(Boolean);
  return recordNames.some(value => driverNames.has(value));
}

function adminBillingBaselineForDriver(driver = {}) {
  return adminAllClosures
    .filter(item => adminRecordBelongsToDriver(item, driver))
    .filter(closureUsesCutoff)
    .filter(item => closureKind(item) === "facturacion")
    .map(closureCutoffMs)
    .filter(Boolean)
    .sort((a, b) => b - a)[0] || 0;
}

function adminBillingBalanceForDriver(driver = {}) {
  const baseline = adminBillingBaselineForDriver(driver);
  const adminDebtTotal = adminDebts
    .filter(item => adminRecordBelongsToDriver(item, driver))
    .filter(item => !movementIsDeleted(item) && debtImpactsSettlement(item))
    .reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const driverPayments = adminPayments
    .filter(item => adminRecordBelongsToDriver(item, driver))
    .filter(item => !movementIsDeleted(item))
    .filter(item => recordTimestampMs(item) > baseline);

  const driverUber = adminUberClosures
    .filter(item => adminRecordBelongsToDriver(item, driver))
    .filter(item => !movementIsDeleted(item))
    .filter(item => recordTimestampMs(item) > baseline);

  const driverExpenses = adminExpenses
    .filter(item => adminRecordBelongsToDriver(item, driver))
    .filter(item => !movementIsDeleted(item))
    .filter(item => recordTimestampMs(item) > baseline);

  // Mismo anclaje que ve el chofer: si existe una compensación histórica con
  // `settlementAfter`, esa fotografía es el saldo autoritativo que Telegram informó.
  // Después de ella solo se agregan movimientos realmente posteriores.
  const legacyAnchor = latestReimbursementSettlementAnchor(driverPayments, baseline);
  if (legacyAnchor) {
    const postAnchor = settlementMovementDeltaSince(
      legacyAnchor.timestamp,
      driverPayments,
      driverUber,
      driverExpenses
    );
    const anchoredBalance = legacyAnchor.balance + postAnchor.delta + adminDebtTotal;
    return Math.abs(anchoredBalance) > 0.5 ? anchoredBalance : 0;
  }

  const cashRevenue = driverPayments
    .filter(item => item.method === "cash" && !isSettlementAdjustment(item) && !isReimbursementCompensation(item))
    .reduce((sum, item) => sum + Number(item.amount || 0), 0);

  const cashboxEligibleCash = driverPayments
    .filter(item => item.method === "cash" && !isSettlementAdjustment(item) && !isReimbursementCompensation(item))
    .filter(item => !cashboxIsExcluded(item))
    .reduce((sum, item) => sum + Number(item.amount || 0), 0);

  const digitalRevenue = driverPayments
    .filter(item => item.method === "digital" && !isSettlementAdjustment(item) && !isReimbursementCompensation(item))
    .reduce((sum, item) => sum + Number(item.amount || 0), 0);

  const driverPaid = driverPayments
    .filter(item => isSettlementAdjustment(item) && item.adjustmentDirection === "driver_to_explora")
    .reduce((sum, item) => sum + Math.max(0, Number(item.amount || 0) - Number(item.advanceRepaymentAmount || 0)), 0);

  const exploraPaid = driverPayments
    .filter(item => isSettlementAdjustment(item) && item.adjustmentDirection === "explora_to_driver")
    .reduce((sum, item) => sum + Number(item.amount || 0), 0);

  const uberRevenue = driverUber
    .filter(item => !/reject|rechaz/.test(String(item.reviewStatus || item.status || "").toLowerCase()))
    .reduce((sum, item) => sum + Number(item.amount || 0), 0);

  const automaticExpenseImpact = automaticExpenseBillingImpactTotal(driverExpenses, baseline);
  const cashBox = (cashboxEligibleCash + uberRevenue) * 0.05;
  const balance = (cashRevenue * 0.50) + (uberRevenue * 0.50) + cashBox + adminDebtTotal
    - (digitalRevenue * 0.50) - automaticExpenseImpact - driverPaid + exploraPaid;
  return Math.abs(balance) > 0.5 ? balance : 0;
}

function adminOpenDebtItemsForDriver(driver = {}) {
  return adminDebts
    .filter(item => adminRecordBelongsToDriver(item, driver))
    .filter(item => !movementIsDeleted(item))
    .filter(item => debtImpactsSettlement(item))
    .filter(item => Number(item.amount || 0) > 0.5)
    .sort((a, b) => recordTimestampMs(a) - recordTimestampMs(b));
}

function adminOpenDebtTotalForDriver(driver = {}) {
  return adminOpenDebtItemsForDriver(driver).reduce((sum, item) => sum + Number(item.amount || 0), 0);
}

function adminDriverById(driverId = "") {
  return adminDrivers.find(driver => String(driver.id) === String(driverId)) || null;
}

function renderAdminDriverOptions() {
  const drivers = adminDrivers
    .filter(driver => !adminDriverIsAdministrator(driver))
    .sort((a, b) => adminDriverLabel(a).localeCompare(adminDriverLabel(b), "es", { sensitivity: "base" }));

  const historicalOptions = drivers.map(driver => {
    const inactive = !adminDriverIsActive(driver);
    return `<option value="${escapeHtml(driver.id)}">${escapeHtml(adminDriverLabel(driver))}${inactive ? " · inactivo" : ""}</option>`;
  }).join("");

  const activeOptions = drivers.filter(adminDriverIsActive).map(driver =>
    `<option value="${escapeHtml(driver.id)}">${escapeHtml(adminDriverLabel(driver))}</option>`
  ).join("");

  [
    ["editDriverSelect", activeOptions],
    ["deleteDriverSelect", activeOptions],
    ["debtDriver", activeOptions],
    ["adjustmentDriver", activeOptions],
    ["historyDriver", historicalOptions],
    ["movementDriver", historicalOptions]
  ].forEach(([id, options]) => {
    const select = $(id);
    if (!select) return;
    const previous = select.value;
    select.innerHTML = options || `<option value="">No hay choferes disponibles</option>`;
    if (previous && Array.from(select.options).some(option => option.value === previous)) select.value = previous;
  });

}

function renderAdminDriverList() {
  const box = $("adminDriverList");
  if (!box || !isAdminProfile()) return;

  const active = adminDrivers
    .filter(driver => !adminDriverIsAdministrator(driver) && adminDriverIsActive(driver))
    .sort((a, b) => adminDriverLabel(a).localeCompare(adminDriverLabel(b), "es", { sensitivity: "base" }));

  if (!active.length) {
    box.innerHTML = `<div class="admin-driver-empty">No hay choferes activos.</div>`;
    renderAdminDriverOptions();
    return;
  }

  box.innerHTML = active.map(driver => {
    // Admin ya escucha todos los movimientos y calcula de inmediato, sin esperar
    // los segundos que puede tardar el disparador que actualiza la vista pública.
    const balance = adminBillingBalanceForDriver(driver);
    const amount = Math.abs(balance);
    const stateClass = balance > 0.5 ? "driver-owes" : balance < -0.5 ? "explora-owes" : "balanced";
    const label = balance > 0.5
      ? "Chofer debe liquidar a Explora"
      : balance < -0.5
        ? "Explora debe liquidar al chofer"
        : "Cuentas equilibradas";
    return `<article class="admin-driver-row ${stateClass}">
      <strong class="admin-driver-name">${escapeHtml(adminDriverLabel(driver))}</strong>
      <div class="admin-driver-balance">
        <span>${label}</span>
        <b>${money(amount)}</b>
      </div>
    </article>`;
  }).join("");

  renderAdminDriverOptions();
}

function renderAdminHistory() {
  const box = $("adminHistoryList");
  if (!box) return;
  const driver = adminDriverById($("historyDriver")?.value || "");
  if (!driver) {
    box.innerHTML = `<div class="admin-empty">Seleccioná un chofer.</div>`;
    return;
  }

  const rows = [];

  adminPayments
    .filter(item => adminRecordBelongsToDriver(item, driver))
    .filter(item => isSettlementAdjustment(item))
    .forEach(item => rows.push({
      kind: "Ajuste",
      title: item.adjustmentDirection === "driver_to_explora" ? "Chofer pagó a Explora" : "Explora pagó al chofer",
      amount: Number(item.amount || 0),
      detail: item.detail || item.notes || "",
      proofUrl: item.proofUrl || "",
      createdAt: recordTimestampMs(item),
      className: "adjustment"
    }));

  adminDebts
    .filter(item => adminRecordBelongsToDriver(item, driver))
    .forEach(item => rows.push({
      kind: "Deuda",
      title: movementIsDeleted(item) || Number(item.amount || 0) <= 0.5 ? "Deuda cerrada / anulada" : "Deuda agregada",
      amount: Number(item.amount || 0),
      originalAmount: Number(item.totalAmount || item.amount || 0),
      detail: item.detail || item.reason || "",
      proofUrl: item.proofUrl || "",
      createdAt: recordTimestampMs(item),
      className: "debt",
      debtId: item.id,
      canAnnul: !movementIsDeleted(item) && Number(item.amount || 0) > 0.5 && String(item.type || item.debtType || "") === "admin_debt"
    }));

  adminDebtPayments
    .filter(item => adminRecordBelongsToDriver(item, driver))
    .forEach(item => rows.push({
      kind: "Pago de deuda",
      title: "Pago registrado",
      amount: Number(item.amount || 0),
      detail: item.detail || item.notes || "",
      proofUrl: item.proofUrl || item.receiptUrl || "",
      createdAt: recordTimestampMs(item),
      className: "debt-payment"
    }));

  adminAllClosures
    .filter(item => adminRecordBelongsToDriver(item, driver))
    .filter(item => closureKind(item) === "facturacion")
    .forEach(item => rows.push({
      kind: "Cierre",
      title: item.direction === "driver_pays_explora" ? "Cierre · paga chofer" : item.direction === "explora_pays_driver" ? "Cierre · paga Explora" : "Cierre de facturación",
      amount: Number(item.settlementAmount || item.requestedAmount || 0),
      detail: String(item.status || item.estado || ""),
      proofUrl: item.proofUrl || "",
      createdAt: recordTimestampMs(item),
      className: "closure"
    }));

  rows.sort((a, b) => b.createdAt - a.createdAt);
  const visible = rows.slice(0, 40);

  if (!visible.length) {
    box.innerHTML = `<div class="admin-empty">Todavía no hay movimientos para ${escapeHtml(adminDriverLabel(driver))}.</div>`;
    return;
  }

  box.innerHTML = visible.map(item => {
    const date = item.createdAt
      ? new Intl.DateTimeFormat("es-AR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(item.createdAt))
      : "Sin fecha";
    return `<article class="admin-history-item ${item.className}">
      <div class="admin-history-top"><span>${escapeHtml(item.kind)}</span><b>${money(item.amount || item.originalAmount || 0)}</b></div>
      <strong>${escapeHtml(item.title)}</strong>
      ${item.detail ? `<p>${escapeHtml(item.detail)}</p>` : ""}
      <div class="admin-history-foot">
        <small>${escapeHtml(date)}</small>
        <div>
          ${item.proofUrl ? `<a href="${item.proofUrl}" target="_blank" rel="noopener">Ver comprobante</a>` : ""}
          ${item.canAnnul ? `<button type="button" data-annul-debt="${escapeHtml(item.debtId)}">Anular deuda</button>` : ""}
        </div>
      </div>
    </article>`;
  }).join("");

  box.querySelectorAll("[data-annul-debt]").forEach(button => {
    button.addEventListener("click", () => annulAdminDebt(button.dataset.annulDebt));
  });
}

function unsubscribeAdminDashboard() {
  adminUnsubscribers.forEach(unsubscribe => {
    try { unsubscribe?.(); } catch (_) {}
  });
  adminUnsubscribers = [];
}

function subscribeAdminDashboard() {
  if (!isAdminProfile()) return;
  unsubscribeAdminDashboard();

  const listen = (collectionName, normalize, assign) => {
    const stop = onSnapshot(collection(db, collectionName), snap => {
      const rows = snap.docs.map(d => normalize ? normalize(d.id, d.data()) : ({ id: d.id, ...d.data() }));
      assign(rows);
      renderAdminDriverList();
      maybeShowAdminPendingAction();
      if (!$("adminHistoryModal")?.classList.contains("hidden")) renderAdminHistory();
      if (!$("adminMovementsModal")?.classList.contains("hidden")) renderAdminFinancialMovements();
    }, err => {
      console.error(`Admin snapshot ${collectionName}:`, err);
      const box = $("adminDriverList");
      if (box) box.innerHTML = `<div class="admin-driver-empty error">No se pudieron cargar los datos del administrador.</div>`;
    });
    adminUnsubscribers.push(stop);
  };

  listen("choferes", null, rows => { adminDrivers = rows; });
  listen(ROOT_COLLECTIONS.payments, normalizePaymentRecord, rows => { adminPayments = rows; });
  listen(ROOT_COLLECTIONS.expenses, normalizeExpenseRecord, rows => { adminExpenses = rows; });
  listen(ROOT_COLLECTIONS.uber, normalizeUberRecord, rows => { adminUberClosures = rows; });
  listen(ROOT_COLLECTIONS.closures, normalizeClosureRecord, rows => {
    adminAllClosures = rows.sort((a, b) => recordTimestampMs(b) - recordTimestampMs(a));
    closures = [...adminAllClosures];
    renderAdminClosures();
  });
  listen(ROOT_COLLECTIONS.debts, normalizeDebtRecord, rows => { adminDebts = rows; });
  listen(ROOT_COLLECTIONS.debtPayments, normalizeDebtPaymentRecord, rows => { adminDebtPayments = rows; });
  listen(ROOT_COLLECTIONS.advances, normalizeAdvanceRecord, rows => { adminAdvances = rows; });
}


function adminFinancialMovementRows() {
  const driver = adminDriverById($("movementDriver")?.value || "");
  if (!driver) return [];
  const filter = $("movementTypeFilter")?.value || "all";
  const rows = [];

  if (filter === "all" || filter === "cobro") {
    adminPayments
      .filter(item => adminRecordBelongsToDriver(item, driver))
      .filter(item => !movementIsDeleted(item))
      .filter(item => !isSettlementAdjustment(item) && !isReimbursementCompensation(item))
      .filter(item => item.method === "cash" || item.method === "digital")
      .forEach(item => rows.push({
        id:item.id,
        type:"cobro",
        label:item.method === "cash" ? "Cobro en efectivo" : "Cobro digital",
        amount:Number(item.amount || 0),
        detail:item.detail || item.notes || item.service || "",
        createdAt:recordTimestampMs(item),
        method:item.method,
        proofUrl:item.proofUrl || item.receiptUrl || ""
      }));
  }

  if (filter === "all" || filter === "gasto") {
    adminExpenses
      .filter(item => adminRecordBelongsToDriver(item, driver))
      .filter(item => !movementIsDeleted(item))
      .forEach(item => rows.push({
        id:item.id,
        type:"gasto",
        label:"Gasto",
        amount:Number(item.amount || 0),
        detail:item.detail || item.notes || item.expenseType || "",
        createdAt:recordTimestampMs(item),
        method:"expense",
        proofUrl:item.proofUrl || item.receiptUrl || ""
      }));
  }

  return rows.sort((a,b)=>b.createdAt-a.createdAt).slice(0, 80);
}

function renderAdminFinancialMovements() {
  const box = $("adminMovementList");
  if (!box) return;
  const driver = adminDriverById($("movementDriver")?.value || "");
  if (!driver) {
    box.innerHTML = `<div class="admin-empty">Seleccioná un chofer.</div>`;
    return;
  }
  const rows = adminFinancialMovementRows();
  if (!rows.length) {
    box.innerHTML = `<div class="admin-empty">No hay cobros o gastos para ${escapeHtml(adminDriverLabel(driver))}.</div>`;
    return;
  }
  box.innerHTML = rows.map(item => {
    const when = item.createdAt ? new Date(item.createdAt).toLocaleString("es-AR", { dateStyle:"short", timeStyle:"short" }) : "";
    return `<article class="admin-movement-item">
      <div class="admin-history-top"><span>${escapeHtml(item.label)}</span><b>${money(item.amount)}</b></div>
      <strong>${escapeHtml(item.detail || "Sin detalle")}</strong>
      <div class="admin-history-foot">
        <div><small>${escapeHtml(when)}</small>${item.proofUrl ? `<a target="_blank" rel="noopener" href="${item.proofUrl}">Comprobante</a>` : ""}</div>
        <div class="admin-movement-actions">
          <button type="button" data-edit-financial="${escapeHtml(item.id)}" data-financial-type="${item.type}" data-financial-amount="${item.amount}">Modificar</button>
          <button type="button" class="danger" data-delete-financial="${escapeHtml(item.id)}" data-financial-type="${item.type}">Eliminar</button>
        </div>
      </div>
    </article>`;
  }).join("");

  box.querySelectorAll("[data-edit-financial]").forEach(button => {
    button.addEventListener("click", () => openAdminFinancialEdit({
      id:button.dataset.editFinancial,
      type:button.dataset.financialType,
      amount:Number(button.dataset.financialAmount || 0)
    }));
  });
  box.querySelectorAll("[data-delete-financial]").forEach(button => {
    button.addEventListener("click", () => deleteAdminFinancialMovement(button.dataset.financialType, button.dataset.deleteFinancial));
  });
}

function openAdminFinancialEdit(item = {}) {
  const driver = adminDriverById($("movementDriver")?.value || "");
  if (!driver || !item.id) return;
  $("financialEditDocumentId").value = item.id;
  $("financialEditType").value = item.type;
  $("financialEditDriverId").value = driver.id;
  setMoneyInput("financialEditAmount", item.amount || 0);
  $("financialEditReason").value = "";
  $("financialEditStatus").textContent = "";
  $("financialEditStatus").className = "status";
  $("financialEditModal").classList.remove("hidden");
}

async function deleteAdminFinancialMovement(type, documentId) {
  const driver = adminDriverById($("movementDriver")?.value || "");
  if (!driver || !documentId || !["cobro","gasto"].includes(type)) return;
  const reason = window.prompt(`Motivo para eliminar este ${type}:`);
  if (!String(reason || "").trim()) return;
  const confirmed = window.confirm(`¿Eliminar este ${type}? El saldo se recalculará automáticamente.`);
  if (!confirmed) return;
  const status = $("adminMovementStatus");
  status.textContent = "Eliminando movimiento…";
  status.className = "status";
  try {
    await adminDeleteFinancialMovementCallable({
      type,
      documentId,
      driverUid:driver.id,
      reason:String(reason).trim()
    });
    status.textContent = "Movimiento eliminado. Los saldos y cierres relacionados fueron recalculados.";
    status.className = "status success";
    setTimeout(renderAdminFinancialMovements, 350);
  } catch (err) {
    console.error(err);
    status.textContent = err?.message?.replace(/^FirebaseError:\s*/i, "") || "No se pudo eliminar el movimiento.";
    status.className = "status error";
  }
}

function syncDriverEditForm() {
  const select = $("editDriverSelect");
  const name = $("editDriverName");
  if (!select || !name) return;
  const driver = adminDriverById(select.value);
  if (!driver) {
    name.value = "";
    return;
  }
  name.value = adminDriverLabel(driver);
}

function setDriverManagerMode(mode = "create") {
  const normalizedMode = mode === "edit" ? "edit" : mode === "delete" ? "delete" : "create";
  const createMode = normalizedMode === "create";
  const editMode = normalizedMode === "edit";
  const deleteMode = normalizedMode === "delete";
  $("driverManagerMode").value = normalizedMode;
  $("driverCreateFields").classList.toggle("hidden", !createMode);
  $("driverEditFields").classList.toggle("hidden", !editMode);
  $("driverDeleteFields").classList.toggle("hidden", !deleteMode);
  $("driverManagerCreateTab").classList.toggle("selected", createMode);
  $("driverManagerEditTab").classList.toggle("selected", editMode);
  $("driverManagerDisableTab").classList.toggle("selected", deleteMode);
  $("saveDriverManagerBtn").textContent = createMode ? "Crear chofer" : editMode ? "Guardar cambios" : "Borrar chofer";
  $("saveDriverManagerBtn").classList.toggle("danger", deleteMode);

  ["newDriverName", "newDriverUsername", "newDriverPassword"].forEach(id => {
    const input = $(id);
    if (input) input.required = createMode;
  });
  $("editDriverSelect").required = editMode;
  $("editDriverName").required = editMode;
  $("deleteDriverSelect").required = deleteMode;
  if (editMode) syncDriverEditForm();
}

async function writeAdminAudit(action, data = {}) {
  const admin = auth.currentUser;
  if (!admin || !isAdminProfile()) return;
  try {
    await addDoc(collection(db, "admin_audit"), {
      action,
      adminUid: admin.uid,
      adminName: currentProfile?.displayName || currentProfile?.username || "Administrador",
      ...data,
      createdAtMs: Date.now(),
      createdAt: serverTimestamp()
    });
  } catch (err) {
    console.warn("No se pudo guardar auditoría admin:", err);
  }
}

function closureRemaining(item) {
  const original = Number(item.settlementAmount || item.requestedAmount || 0);
  const paid = Number(item.paidAmountTotal || 0);
  return Math.max(0, Number(item.remainingAmount ?? (original - paid)) || 0);
}

function renderAdminClosures() {
  if (!isAdminProfile()) return;
  const box = $("adminClosureList");
  const pendingExplora = closures.filter(item => {
    const status = String(item.status || "").toLowerCase();
    return item.direction === "explora_pays_driver" && closureRemaining(item) > 0 && !/completed|reject|rechaz|cancel/.test(status);
  });
  const pendingDriverReview = closures.filter(item =>
    item.direction === "driver_pays_explora" && /awaiting_admin_review|pending_admin_review/.test(String(item.status || "").toLowerCase())
  );
  const driverPayments = closures.filter(item => {
    const status = String(item.status || "").toLowerCase();
    return item.direction === "driver_pays_explora" && Number(item.paidAmountTotal || 0) > 0.5 && !/reject|rechaz|awaiting|pending/.test(status);
  }).slice(0, 6);

  const reviewHtml = pendingDriverReview.map(item => `
    <article class="admin-closure-card pending">
      <div class="admin-closure-top">
        <div><small>Pago a Explora por confirmar</small><strong>${escapeHtml(item.operatorName || "Chofer")}</strong></div>
        <b>${money(item.requestedPaymentAmount || item.settlementAmount || 0)}</b>
      </div>
      <p>El chofer adjuntó un comprobante. Confirmá o rechazá el movimiento.</p>
      <button type="button" class="admin-proof-button" data-admin-review-closure="${escapeHtml(item.id)}">Revisar ahora</button>
    </article>`).join("");

  const payHtml = pendingExplora.map(item => `
    <article class="admin-closure-card pending">
      <div class="admin-closure-top">
        <div><small>Cobrar a Explora</small><strong>${escapeHtml(item.operatorName || "Chofer")}</strong></div>
        <b>${money(closureRemaining(item))}</b>
      </div>
      <p>Transferir a ${escapeHtml(item.recipientAlias || "alias no informado")} · CUIT ${escapeHtml(formatCuit(item.recipientCuit || ""))}.</p>
      <button type="button" class="admin-proof-button" data-admin-closure="${escapeHtml(item.id)}">Pagar y subir comprobante</button>
    </article>`).join("");

  const pendingHtml = reviewHtml || payHtml
    ? reviewHtml + payHtml
    : `<div class="admin-empty">No hay cierres pendientes.</div>`;

  const receivedHtml = driverPayments.length ? `
    <div class="admin-history-title">Pagos confirmados de choferes</div>
    ${driverPayments.map(item => `
      <article class="admin-closure-card received">
        <div class="admin-closure-top">
          <div><small>Ajuste del chofer</small><strong>${escapeHtml(item.operatorName || "Chofer")}</strong></div>
          <b>${money(item.paidAmountTotal || 0)}</b>
        </div>
        ${item.proofUrl ? `<a class="proof admin-proof-link" target="_blank" rel="noopener" href="${item.proofUrl}">Ver comprobante</a>` : ""}
      </article>`).join("")}` : "";

  box.innerHTML = pendingHtml + receivedHtml;
  box.querySelectorAll("[data-admin-closure]").forEach(button => {
    button.addEventListener("click", () => openAdminPayment(button.dataset.adminClosure));
  });
  box.querySelectorAll("[data-admin-review-closure]").forEach(button => {
    button.addEventListener("click", () => {
      const candidate = adminPendingCandidates().find(row => row.key === `closure:${button.dataset.adminReviewClosure}`);
      if (!candidate) return;
      adminDismissedPendingActionIds.delete(candidate.key);
      renderAdminPendingAction(candidate);
    });
  });
}

function adminPendingCandidates() {
  if (!isAdminProfile()) return [];
  const rows = [];
  adminAllClosures.forEach(item => {
    const status = String(item.status || item.reviewStatus || "").toLowerCase();
    if (item.direction === "driver_pays_explora" && /awaiting_admin_review|pending_admin_review/.test(status)) {
      rows.push({ key:`closure:${item.id}`, kind:"closure_driver_payment", id:item.id, createdAt:recordTimestampMs(item), item });
      return;
    }
    if (item.direction === "explora_pays_driver" && closureRemaining(item) > 0.5 && /awaiting_admin_payment|awaiting_admin_proof|pending_admin_payment/.test(status)) {
      rows.push({ key:`closure:${item.id}`, kind:"closure_explora_payment", id:item.id, createdAt:recordTimestampMs(item), item });
    }
  });
  adminAdvances.forEach(item => {
    const status = String(item.approvalStatus || item.status || "").toLowerCase();
    if (/pending/.test(status)) {
      rows.push({ key:`advance:${item.id}`, kind:"advance", id:item.id, createdAt:recordTimestampMs(item), item });
    }
  });
  return rows.sort((a,b) => (a.createdAt || 0) - (b.createdAt || 0));
}

function renderAdminPendingAction(candidate) {
  const modal = $("adminPendingActionModal");
  if (!modal || !candidate) return;
  adminPendingAction = candidate;
  const item = candidate.item || {};
  const title = $("adminPendingActionTitle");
  const body = $("adminPendingActionBody");
  const approve = $("adminPendingApproveBtn");
  const reject = $("adminPendingRejectBtn");
  const status = $("adminPendingActionStatus");
  status.textContent = "";
  status.className = "status";
  approve.disabled = false;
  reject.disabled = false;

  if (candidate.kind === "advance") {
    title.textContent = "Pedido de adelanto pendiente";
    const principal = Number(item.principalAmount || item.originalAmount || item.amount || 0);
    const totalDebt = Number(item.totalDebt || item.requestedTotalDebt || 0);
    body.innerHTML = `<div class="admin-pending-type">Adelanto / préstamo</div>
      <strong class="admin-pending-driver">${escapeHtml(item.driverName || item.operatorName || "Chofer")}</strong>
      <div class="admin-pending-amount">${money(principal)}</div>
      <div class="admin-pending-details">
        <div><span>Interés</span><b>${Number(item.interestPercent || 40)}%</b></div>
        <div><span>Total a devolver</span><b>${money(totalDebt)}</b></div>
        <div><span>Diferencia al pedir</span><b>${money(item.differenceAtRequest || 0)}</b></div>
      </div>`;
    approve.textContent = "Aprobar adelanto";
    reject.textContent = "Rechazar";
  } else if (candidate.kind === "closure_driver_payment") {
    title.textContent = "Cierre pendiente de confirmación";
    const requested = Number(item.requestedPaymentAmount || item.settlementAmount || 0);
    body.innerHTML = `<div class="admin-pending-type">El chofer pagó a Explora</div>
      <strong class="admin-pending-driver">${escapeHtml(item.operatorName || item.driverName || "Chofer")}</strong>
      <div class="admin-pending-amount">${money(requested)}</div>
      <div class="admin-bank-card"><span>Destino informado al chofer</span><strong>${escapeHtml(item.transferAlias || EXPLORA_TRANSFER_ALIAS)}</strong><small>CUIT ${escapeHtml(item.transferCuit || EXPLORA_CUIT)}</small></div>
      ${item.proofUrl ? `<a class="admin-pending-proof" target="_blank" rel="noopener" href="${item.proofUrl}">Ver comprobante del chofer</a>` : ""}`;
    approve.textContent = "Confirmar pago";
    reject.textContent = "Rechazar comprobante";
  } else {
    title.textContent = "Pedido de cierre pendiente";
    body.innerHTML = `<div class="admin-pending-type">Explora debe pagar al chofer</div>
      <strong class="admin-pending-driver">${escapeHtml(item.operatorName || item.driverName || "Chofer")}</strong>
      <div class="admin-pending-amount">${money(closureRemaining(item))}</div>
      <div class="admin-bank-card"><span>Transferir a</span><strong>${escapeHtml(item.recipientAlias || "Alias no informado")}</strong><small>CUIT ${escapeHtml(formatCuit(item.recipientCuit || ""))}</small></div>`;
    approve.textContent = "Pagar ahora";
    reject.textContent = "Rechazar pedido";
  }
  modal.classList.remove("hidden");
}

function maybeShowAdminPendingAction() {
  if (!isAdminProfile()) return;
  const modal = $("adminPendingActionModal");
  if (!modal || !modal.classList.contains("hidden")) return;
  const anotherModalOpen = Array.from(document.querySelectorAll(".modal:not(.hidden)")).some(node => node.id !== "adminPendingActionModal");
  if (anotherModalOpen) return;
  const candidate = adminPendingCandidates().find(item => !adminDismissedPendingActionIds.has(item.key));
  if (candidate) renderAdminPendingAction(candidate);
}

function dismissAdminPendingAction({ showNext = false } = {}) {
  if (adminPendingAction?.key) adminDismissedPendingActionIds.add(adminPendingAction.key);
  adminPendingAction = null;
  $("adminPendingActionModal")?.classList.add("hidden");
  if (showNext) setTimeout(maybeShowAdminPendingAction, 80);
}

async function decideAdvanceFromAdmin(item, approved) {
  const admin = auth.currentUser;
  if (!admin || !isAdminProfile()) return;
  const refAdvance = doc(db, ROOT_COLLECTIONS.advances, item.id);
  const totalDebt = Number(item.totalDebt || item.requestedTotalDebt || 0);
  await runTransaction(db, async transaction => {
    const snap = await transaction.get(refAdvance);
    if (!snap.exists()) throw new Error("La solicitud ya no existe.");
    const current = snap.data() || {};
    const state = String(current.approvalStatus || current.status || "").toLowerCase();
    if (!/pending/.test(state)) throw new Error("Esta solicitud ya fue resuelta.");
    transaction.update(refAdvance, approved ? {
      status:"active",
      approvalStatus:"approved",
      remainingAmount:Number(current.totalDebt || current.requestedTotalDebt || totalDebt),
      approvedByUid:admin.uid,
      approvedByName:currentProfile?.displayName || currentProfile?.username || "Administrador",
      approvedAt:serverTimestamp(),
      approvedAtMs:Date.now(),
      updatedAt:serverTimestamp(),
      updatedAtMs:Date.now()
    } : {
      status:"rejected",
      approvalStatus:"rejected",
      remainingAmount:0,
      rejectedByUid:admin.uid,
      rejectedByName:currentProfile?.displayName || currentProfile?.username || "Administrador",
      rejectedAt:serverTimestamp(),
      rejectedAtMs:Date.now(),
      updatedAt:serverTimestamp(),
      updatedAtMs:Date.now()
    });
  });
}

async function approveDriverClosurePayment(item) {
  const admin = auth.currentUser;
  if (!admin || !isAdminProfile()) return;
  const closureRef = doc(db, ROOT_COLLECTIONS.closures, item.id);
  const driverUid = item.operatorUid || item.driverUid || item.choferUid || item.uid || "";
  const candidateAdvanceRefs = adminAdvances
    .filter(advance => (advance.operatorUid || advance.driverUid || advance.choferUid || advance.uid || "") === driverUid)
    .filter(advance => advanceRemaining(advance) > 0.5)
    .map(advance => doc(db, ROOT_COLLECTIONS.advances, advance.id));
  const paymentRef = doc(collection(db, ROOT_COLLECTIONS.payments));

  await runTransaction(db, async transaction => {
    const closureSnap = await transaction.get(closureRef);
    if (!closureSnap.exists()) throw new Error("El cierre ya no existe.");
    const current = closureSnap.data() || {};
    if (!/awaiting_admin_review|pending_admin_review/.test(String(current.status || "").toLowerCase())) {
      throw new Error("Este cierre ya fue resuelto.");
    }
    const settlementAmount = Number(current.settlementAmount || current.requestedAmount || 0);
    const amount = Math.min(settlementAmount, Number(current.requestedPaymentAmount || settlementAmount || 0));
    const freshAdvances = [];
    for (const advanceRef of candidateAdvanceRefs) {
      const snap = await transaction.get(advanceRef);
      if (snap.exists()) freshAdvances.push({ id:snap.id, ...snap.data() });
    }
    const repaymentPlan = planAdvanceRepayment(amount, freshAdvances);
    const newRemaining = Math.max(0, settlementAmount - amount);
    const detail = [
      newRemaining <= 0.5 ? "Pago confirmado por Admin" : "Pago parcial confirmado por Admin",
      repaymentPlan.totalApplied > 0.5 ? `Aplicado al adelanto: ${money(repaymentPlan.totalApplied)}` : ""
    ].filter(Boolean).join(" · ");

    transaction.set(paymentRef, {
      method:"digital", paymentMethod:"transfer", metodoPago:"transfer", financialCategory:"transfer",
      type:"admin_billing_settlement_payment", operationType:"admin_billing_settlement_payment", movementType:"driver_payment",
      sourceModule:"facturacion", affectsBillingSettlement:true, adjustmentDirection:"driver_to_explora",
      amount, monto:amount, previousBillingBalance:settlementAmount, newBillingBalance:newRemaining,
      advanceRepaymentAmount:repaymentPlan.totalApplied,
      advanceAllocations:repaymentPlan.allocations.map(allocation => ({ advanceId:allocation.id, amount:allocation.applied })),
      service:"Ajuste del chofer", notes:detail, detail,
      proofUrl:current.proofUrl || "", proofPath:current.proofPath || "", receiptUrl:current.receiptUrl || current.proofUrl || "", receiptPath:current.receiptPath || current.proofPath || "",
      closureId:item.id, dayKey:current.dayKey || localDayKey(), weeklyPeriodId:current.weeklyPeriodId || currentWeeklyPeriodId(),
      driverUid, choferUid:driverUid, uid:driverUid, ownerUid:driverUid, driverId:driverUid,
      driverName:current.driverName || current.operatorName || "Chofer", operatorUid:driverUid, operatorName:current.operatorName || current.driverName || "",
      approvedByUid:admin.uid, approvedByName:currentProfile?.displayName || currentProfile?.username || "Administrador",
      businessId:BUSINESS_ID, createdAtMs:Date.now(), createdAt:serverTimestamp()
    });
    transaction.update(closureRef, {
      paidAmountTotal:amount,
      remainingAmount:newRemaining,
      amountDueFromDriver:newRemaining,
      amountFromDriver:newRemaining,
      reviewStatus:"approved",
      status:newRemaining <= 0.5 ? "completed" : "partial",
      actionedByAdminUid:admin.uid,
      actionedByAdminName:currentProfile?.displayName || currentProfile?.username || "Administrador",
      approvedAt:serverTimestamp(),
      approvedAtMs:Date.now(),
      updatedAt:serverTimestamp(),
      updatedAtMs:Date.now(),
      completedAt:newRemaining <= 0.5 ? serverTimestamp() : null
    });
    repaymentPlan.allocations.forEach(allocation => {
      transaction.update(doc(db, ROOT_COLLECTIONS.advances, allocation.id), {
        remainingAmount:allocation.remainingAmount,
        repaidAmount:allocation.repaidAmount,
        status:allocation.status,
        updatedAt:serverTimestamp(),
        updatedAtMs:Date.now()
      });
    });
  });
}

async function rejectClosureFromAdmin(item) {
  const admin = auth.currentUser;
  if (!admin || !isAdminProfile()) return;
  const closureRef = doc(db, ROOT_COLLECTIONS.closures, item.id);
  const isExploraPayment = item.direction === "explora_pays_driver";
  await runTransaction(db, async transaction => {
    const snap = await transaction.get(closureRef);
    if (!snap.exists()) throw new Error("El cierre ya no existe.");
    const current = snap.data() || {};
    const status = String(current.status || "").toLowerCase();
    if (/completed|reject|rechaz|cancel/.test(status)) throw new Error("Este cierre ya fue resuelto.");
    transaction.update(closureRef, {
      status:"rejected",
      reviewStatus:"rejected",
      rejectionReason:isExploraPayment ? "Pedido de cobro rechazado por Admin" : "Comprobante rechazado por Admin",
      ...(isExploraPayment ? { remainingAmount:0, amountDueToDriver:0, amountToDriver:0 } : {}),
      rejectedByUid:admin.uid,
      rejectedByName:currentProfile?.displayName || currentProfile?.username || "Administrador",
      rejectedAt:serverTimestamp(),
      rejectedAtMs:Date.now(),
      updatedAt:serverTimestamp(),
      updatedAtMs:Date.now()
    });
  });
}

$("adminPendingDismissBtn")?.addEventListener("click", () => dismissAdminPendingAction({ showNext:true }));

$("adminPendingApproveBtn")?.addEventListener("click", async () => {
  const candidate = adminPendingAction;
  if (!candidate) return;
  const approve = $("adminPendingApproveBtn");
  const reject = $("adminPendingRejectBtn");
  const status = $("adminPendingActionStatus");
  if (candidate.kind === "closure_explora_payment") {
    $("adminPendingActionModal").classList.add("hidden");
    adminPendingAction = null;
    $("closeModal").classList.remove("hidden");
    $("closeModalTitle").textContent = "Resolver cierre pendiente";
    $("closeDriverView").classList.add("hidden");
    $("closeAdminView").classList.remove("hidden");
    $("adminClosureList").classList.add("hidden");
    openAdminPayment(candidate.id);
    return;
  }
  approve.disabled = true;
  reject.disabled = true;
  status.textContent = "Procesando…";
  status.className = "status";
  try {
    if (candidate.kind === "advance") await decideAdvanceFromAdmin(candidate.item, true);
    else await approveDriverClosurePayment(candidate.item);
    adminDismissedPendingActionIds.add(candidate.key);
    status.textContent = candidate.kind === "advance" ? "Adelanto aprobado." : "Pago confirmado.";
    status.className = "status success";
    setTimeout(() => { adminPendingAction = null; $("adminPendingActionModal").classList.add("hidden"); maybeShowAdminPendingAction(); }, 700);
  } catch (err) {
    console.error(err);
    status.textContent = err?.message || "No se pudo completar la acción.";
    status.className = "status error";
    approve.disabled = false;
    reject.disabled = false;
  }
});

$("adminPendingRejectBtn")?.addEventListener("click", async () => {
  const candidate = adminPendingAction;
  if (!candidate) return;
  const approve = $("adminPendingApproveBtn");
  const reject = $("adminPendingRejectBtn");
  const status = $("adminPendingActionStatus");
  approve.disabled = true;
  reject.disabled = true;
  status.textContent = "Procesando rechazo…";
  status.className = "status";
  try {
    if (candidate.kind === "advance") await decideAdvanceFromAdmin(candidate.item, false);
    else await rejectClosureFromAdmin(candidate.item);
    adminDismissedPendingActionIds.add(candidate.key);
    status.textContent = candidate.kind === "advance" ? "Adelanto rechazado." : "Cierre rechazado.";
    status.className = "status success";
    setTimeout(() => { adminPendingAction = null; $("adminPendingActionModal").classList.add("hidden"); maybeShowAdminPendingAction(); }, 700);
  } catch (err) {
    console.error(err);
    status.textContent = err?.message || "No se pudo rechazar el pedido.";
    status.className = "status error";
    approve.disabled = false;
    reject.disabled = false;
  }
});

function subscribeClosures(user) {
  if (unsubscribeClosures) unsubscribeClosures();
  const baseRef = collection(db, ROOT_COLLECTIONS.closures);

  if (isAdminProfile()) {
    unsubscribeClosures = onSnapshot(baseRef, snap => {
      closures = snap.docs.map(d => normalizeClosureRecord(d.id, d.data())).sort((a,b)=>recordTimestampMs(b)-recordTimestampMs(a));
      render();
      renderAdminClosures();
    }, err => {
      console.error("Firestore cierres_semanales snapshot error:", err);
      $("adminClosureList").innerHTML = `<div class="admin-empty error">No se pudieron cargar los cierres.</div>`;
    });
    return;
  }

  const uid = user.uid;
  loadOwnedHistory(ROOT_COLLECTIONS.closures, uid).then(rows => {
    const merged = mergeOwnedRows(ROOT_COLLECTIONS.closures, uid, canonicalRows(ROOT_COLLECTIONS.closures, uid));
    closures = merged.map(row => normalizeClosureRecord(row.id, row)).sort((a,b)=>recordTimestampMs(b)-recordTimestampMs(a));
    render();
  }).catch(err => console.warn("EXPLORA_HISTORY_LOAD cierres", err));

  unsubscribeClosures = onSnapshot(ownedQuery(ROOT_COLLECTIONS.closures, uid), snap => {
    const canon = snap.docs.map(d => ({ id:d.id, ...d.data() }));
    setCanonicalRows(ROOT_COLLECTIONS.closures, uid, canon);
    const merged = mergeOwnedRows(ROOT_COLLECTIONS.closures, uid, canon);
    closures = merged.map(row => normalizeClosureRecord(row.id, row)).sort((a,b)=>recordTimestampMs(b)-recordTimestampMs(a));
    render();
  }, err => console.error("Firestore cierres_semanales snapshot error:", err));
}

$("loginPasswordToggle")?.addEventListener("click", () => {
  const input = $("pass");
  const button = $("loginPasswordToggle");
  if (!input || !button) return;
  const showing = input.type === "text";
  input.type = showing ? "password" : "text";
  button.textContent = showing ? "Ver" : "Ocultar";
});

$("loginForm")?.addEventListener("submit", async e => {
  e.preventDefault();
  $("loginStatus").textContent = "";
  $("loginStatus").className = "status";
  $("loginBtn").disabled = true;
  $("loginBtn").textContent = "Ingresando…";
  try {
    const usernameOrEmail = $("user").value.trim();
    const password = $("pass").value;
    if (!usernameOrEmail || !password) {
      throw Object.assign(new Error("Faltan credenciales"), { code: "auth/invalid-credential" });
    }
    startSplash();
    await waitForAuthReady();
    await signInFromLogin(usernameOrEmail, password);
  } catch (err) {
    console.error(err);
    await finishSplash("loginScreen");
    $("loginStatus").textContent = loginErrorMessage(err);
    $("loginStatus").className = "status error";
  } finally {
    $("loginBtn").disabled = false;
    $("loginBtn").textContent = "Ingresar";
  }
});

$("logoutBtn")?.addEventListener("click", async () => {
  startSplash();
  try {
    await signOut(auth);
  } catch (err) {
    console.error(err);
    await finishSplash("app");
  }
});


$("adminLogoutBtn")?.addEventListener("click", async () => {
  startSplash();
  try {
    await signOut(auth);
  } catch (err) {
    console.error(err);
    await finishSplash("app");
  }
});


$("adminDriversBtn")?.addEventListener("click", () => {
  if (!isAdminProfile()) return;
  $("driverManagerForm").reset();
  $("driverManagerStatus").textContent = "";
  $("driverManagerStatus").className = "status";
  renderAdminDriverOptions();
  setDriverManagerMode("create");
  $("driverManagerModal").classList.remove("hidden");
});

document.querySelectorAll("[data-driver-manager-mode]").forEach(button => {
  button.addEventListener("click", () => setDriverManagerMode(button.dataset.driverManagerMode));
});

$("editDriverSelect")?.addEventListener("change", syncDriverEditForm);

$("driverManagerForm")?.addEventListener("submit", async event => {
  event.preventDefault();
  if (!isAdminProfile()) return;

  const mode = $("driverManagerMode").value || "create";
  const status = $("driverManagerStatus");
  const button = $("saveDriverManagerBtn");
  status.textContent = "";
  status.className = "status";
  button.disabled = true;

  try {
    if (mode === "create") {
      const nombre = $("newDriverName").value.trim();
      const username = $("newDriverUsername").value.trim().toLowerCase();
      const password = $("newDriverPassword").value;
      if (!nombre || !username || password.length < 6) throw new Error("Completá nombre, ID de acceso y una clave de al menos 6 caracteres.");

      button.textContent = "Creando…";
      await adminCreateDriverCallable({ nombre, username, password, role: "chofer" });
      status.textContent = `Chofer ${nombre} creado correctamente.`;
    } else if (mode === "edit") {
      const driverId = $("editDriverSelect").value;
      const nombre = $("editDriverName").value.trim();
      const password = $("editDriverPassword").value;
      if (!driverId || !nombre) throw new Error("Seleccioná un chofer e indicá su nombre.");
      if (password && password.length < 6) throw new Error("La nueva clave debe tener al menos 6 caracteres.");

      button.textContent = "Guardando…";
      await adminUpdateDriverCallable({ driverId, nombre, active:true, password });
      status.textContent = `Datos de ${nombre} actualizados.`;
    } else {
      const driverId = $("deleteDriverSelect").value;
      const driver = adminDriverById(driverId);
      if (!driverId || !driver) throw new Error("Seleccioná un chofer para borrar.");
      const nombre = adminDriverLabel(driver);
      const confirmed = window.confirm(`¿Borrar definitivamente a ${nombre}? Se eliminará su acceso y desaparecerá de los menús. Los movimientos históricos se conservarán.`);
      if (!confirmed) {
        status.textContent = "Borrado cancelado.";
        status.className = "status";
        return;
      }

      button.textContent = "Borrando…";
      await adminUpdateDriverCallable({ driverId, nombre, deleteDriver:true });
      status.textContent = `${nombre} fue borrado correctamente.`;
    }

    status.className = "status success";
    setTimeout(() => $("driverManagerModal").classList.add("hidden"), 1000);
  } catch (err) {
    console.error(err);
    status.textContent = err?.message?.replace(/^FirebaseError:\s*/i, "") || "No se pudo guardar el chofer.";
    status.className = "status error";
  } finally {
    button.disabled = false;
    button.textContent = mode === "create" ? "Crear chofer" : mode === "edit" ? "Guardar cambios" : "Borrar chofer";
  }
});

$("adminAddDebtBtn")?.addEventListener("click", () => {
  if (!isAdminProfile()) return;
  renderAdminDriverOptions();
  $("debtForm").reset();
  $("debtStatus").textContent = "";
  $("debtStatus").className = "status";
  $("debtModal").classList.remove("hidden");
});

$("adminAdjustmentBtn")?.addEventListener("click", () => {
  if (!isAdminProfile()) return;
  renderAdminDriverOptions();
  $("adminAdjustmentForm").reset();
  $("adminAdjustmentStatus").textContent = "";
  $("adminAdjustmentStatus").className = "status";
  $("adminAdjustmentModal").classList.remove("hidden");
});


$("adminMovementsBtn")?.addEventListener("click", () => {
  if (!isAdminProfile()) return;
  renderAdminDriverOptions();
  $("adminMovementStatus").textContent = "";
  $("adminMovementStatus").className = "status";
  $("adminMovementsModal").classList.remove("hidden");
  renderAdminFinancialMovements();
});

$("movementDriver")?.addEventListener("change", renderAdminFinancialMovements);
$("movementTypeFilter")?.addEventListener("change", renderAdminFinancialMovements);

$("financialEditForm")?.addEventListener("submit", async event => {
  event.preventDefault();
  if (!isAdminProfile()) return;
  const type = $("financialEditType").value;
  const documentId = $("financialEditDocumentId").value;
  const driverUid = $("financialEditDriverId").value;
  const newAmount = parseMoneyInput($("financialEditAmount").value);
  const reason = $("financialEditReason").value.trim();
  const status = $("financialEditStatus");
  const button = $("saveFinancialEditBtn");
  if (!documentId || !driverUid || !["cobro","gasto"].includes(type)) return;
  if (!newAmount || newAmount <= 0) {
    status.textContent = "Ingresá un importe válido.";
    status.className = "status error";
    return;
  }
  if (!reason) {
    status.textContent = "Indicá el motivo de la modificación.";
    status.className = "status error";
    return;
  }
  button.disabled = true;
  button.textContent = "Guardando…";
  status.textContent = "";
  try {
    const callable = type === "gasto" ? adminModifyExpenseAmountCallable : adminModifyBillingAmountCallable;
    await callable({ documentId, driverUid, newAmount, reason });
    status.textContent = "Importe modificado. El saldo fue recalculado automáticamente.";
    status.className = "status success";
    setTimeout(() => {
      $("financialEditModal").classList.add("hidden");
      renderAdminFinancialMovements();
    }, 850);
  } catch (err) {
    console.error(err);
    status.textContent = err?.message?.replace(/^FirebaseError:\s*/i, "") || "No se pudo modificar el movimiento.";
    status.className = "status error";
  } finally {
    button.disabled = false;
    button.textContent = "Guardar modificación";
  }
});

$("adminHistoryBtn")?.addEventListener("click", () => {
  if (!isAdminProfile()) return;
  renderAdminDriverOptions();
  $("adminHistoryStatus").textContent = "";
  $("adminHistoryStatus").className = "status";
  $("adminHistoryModal").classList.remove("hidden");
  renderAdminHistory();
});

$("historyDriver")?.addEventListener("change", renderAdminHistory);

$("adminManageClosuresBtn")?.addEventListener("click", () => {
  if (!isAdminProfile()) return;
  $("closeDayBtn")?.click();
});

onAuthStateChanged(auth, async user => {
  if (!user) {
    if (unsubscribePayments) unsubscribePayments();
    if (unsubscribeExpenses) unsubscribeExpenses();
    if (unsubscribeUber) unsubscribeUber();
    if (unsubscribeClosures) unsubscribeClosures();
    if (unsubscribeDebts) unsubscribeDebts();
    if (unsubscribeDebtPayments) unsubscribeDebtPayments();
    if (unsubscribeAdvances) unsubscribeAdvances();
    unsubscribeTeamRealtimeDashboard();
    unsubscribeOwnProfileDashboard();
    unsubscribeAdminDashboard();
    payments = [];
    expenses = [];
    uberClosures = [];
    closures = [];
    debts = [];
    debtPayments = [];
    advances = [];
    advancesLoaded = false;
    teamRealtimeBalances = [];
    teamRealtimeLoadError = "";
    adminDrivers = [];
    adminPayments = [];
    adminExpenses = [];
    adminUberClosures = [];
    adminAllClosures = [];
    adminDebts = [];
    adminDebtPayments = [];
    adminAdvances = [];
    adminPendingAction = null;
    adminDismissedPendingActionIds.clear();
    currentProfile = null;
    visibleReceiptCount = RECENT_RECEIPTS_LIMIT;
    await finishSplash("loginScreen");
    return;
  }

  // La pantalla se decide por rol: Admin nunca reutiliza la vista financiera del chofer.
  visibleReceiptCount = RECENT_RECEIPTS_LIMIT;
  currentProfile = fallbackProfile(user);
  $("operatorName").textContent = `Hola ${currentProfile.displayName || currentProfile.username || user.email?.split("@")[0] || "Chofer"}`;
  applyRoleUI();
  subscribeTeamRealtimeDashboard();
  subscribeOwnProfileDashboard(user);
  if (isAdminProfile()) {
    subscribeAdminDashboard();
  } else {
    subscribeToday(user);
    subscribeClosures(user);
  }
  await finishSplash("app");

  try {
    currentProfile = await loadProfile(user);
    if (currentProfile.active === false) {
      await signOut(auth);
      $("loginStatus").textContent = "Este usuario está desactivado.";
      $("loginStatus").className = "status error";
      return;
    }
    $("operatorName").textContent = `Hola ${currentProfile.displayName || currentProfile.username || user.email.split("@")[0]}`;
    applyRoleUI();

    if (isAdminProfile()) {
      if (unsubscribePayments) unsubscribePayments();
      if (unsubscribeExpenses) unsubscribeExpenses();
      if (unsubscribeUber) unsubscribeUber();
      if (unsubscribeDebts) unsubscribeDebts();
      if (unsubscribeDebtPayments) unsubscribeDebtPayments();
      if (unsubscribeAdvances) unsubscribeAdvances();
      if (unsubscribeClosures) unsubscribeClosures();
      subscribeAdminDashboard();
    } else {
      unsubscribeAdminDashboard();
      subscribeToday(user);
      subscribeClosures(user);
    }
  } catch (err) {
    console.warn("Se inició sesión usando el perfil básico:", err);
    $("syncStatus").textContent = "Sesión activa · revisando datos";
    $("syncStatus").className = "sync warn";
  }
});

document.querySelectorAll("[data-mode]").forEach(btn => {
  btn.addEventListener("click", () => {
    const mode = btn.dataset.mode;
    $("chargeForm").reset();
    delete $("chargeForm").dataset.previewConfirmed;
    $("chargeMode").value = mode;
    $("chargeModal").dataset.tone = mode;
    $("chargeTitle").textContent = mode === "cash" ? "Cobro en efectivo" : "Cobro digital";
    $("proofField").classList.toggle("hidden", mode !== "digital");
    $("chargeStatus").textContent = "";
    $("chargeStatus").className = "status";
    $("saveChargeBtn").disabled = false;
    $("saveChargeBtn").textContent = "Registrar cobro";
    $("chargeModal").classList.remove("hidden");
  });
});

document.querySelectorAll("[data-close]").forEach(btn => {
  btn.addEventListener("click", () => {
    $(btn.dataset.close).classList.add("hidden");
    window.setTimeout(maybeShowDriverDebtConfirmation, 0);
  });
});

// Muestra el estado de éxito dentro del mismo modal y luego lo cierra solo.
// También devuelve la pantalla principal al inicio para que el chofer vea
// inmediatamente los totales actualizados.
function closeModalAndGoTop(modalId, delayMs = 1000) {
  const modal = $(modalId);
  window.setTimeout(() => {
    modal?.classList.add("hidden");
    try {
      window.scrollTo({ top: 0, left: 0, behavior: "smooth" });
    } catch (_) {
      window.scrollTo(0, 0);
    }
    window.setTimeout(maybeShowDriverDebtConfirmation, 0);
  }, delayMs);
}

function settlementState(balance, tense = "now") {
  const value = Math.abs(Number(balance || 0)) <= 0.5 ? 0 : Number(balance || 0);
  if (value > 0) {
    return {
      label: tense === "before" ? "Chofer debe actualmente a Explora" : "Chofer debe a Explora",
      amount: value,
      payer: "driver"
    };
  }
  if (value < 0) {
    return {
      label: tense === "before" ? "Explora debe actualmente al chofer" : "Explora debe al chofer",
      amount: Math.abs(value),
      payer: "explora"
    };
  }
  return { label: "Cuentas equilibradas", amount: 0, payer: "balanced" };
}

function previewDefinition(kind, amount) {
  const value = Math.max(0, Number(amount || 0));
  const definitions = {
    cash: {
      title: "Confirmar cobro en efectivo",
      subtitle: "El cobro suma 50% para Explora y 5% de caja chica.",
      amountLabel: "Cobro en efectivo",
      impactLabel: "50% + caja chica 5%",
      delta: value * 0.55,
      notice: "Al confirmar se crearán dos comprobantes: el cobro y su caja chica 5%.",
      confirmLabel: "Confirmar cobro"
    },
    digital: {
      title: "Confirmar cobro digital",
      subtitle: "El 50% del cobro compensa la diferencia a favor del chofer.",
      amountLabel: "Cobro digital",
      impactLabel: "50% del cobro",
      delta: value * -0.50,
      notice: "Al confirmar se guardará el comprobante digital y se enviará el aviso.",
      confirmLabel: "Confirmar cobro"
    },
    expense: {
      title: "Confirmar gasto",
      subtitle: "Explora reconoce automáticamente el 50% del gasto.",
      amountLabel: "Gasto total",
      impactLabel: "Explora reconoce 50%",
      delta: value * -0.50,
      notice: "Al confirmar el gasto impactará en el saldo y se enviará a Telegram.",
      confirmLabel: "Confirmar gasto"
    },
    uber: {
      title: "Confirmar comprobante de Uber",
      subtitle: "Uber suma 50% para Explora y 5% de caja chica.",
      amountLabel: "Total de Uber",
      impactLabel: "50% + caja chica 5%",
      delta: value * 0.55,
      notice: "Al confirmar se guardará la semana de Uber y se enviará el aviso.",
      confirmLabel: "Confirmar Uber"
    }
  };
  return definitions[kind] || definitions.expense;
}

function normalizedSettlementBalance(value) {
  const balance = Number(value || 0);
  return Math.abs(balance) > 0.5 ? balance : 0;
}

function operationImpactMessage(delta, afterBalance) {
  const change = Math.abs(Number(delta || 0));
  if (Math.abs(afterBalance) <= 0.5) return `La operación cambia la diferencia ${money(change)} y deja las cuentas equilibradas.`;
  return Number(delta || 0) > 0
    ? `La operación suma ${money(change)} al lado que debe liquidar el chofer.`
    : `La operación suma ${money(change)} al lado que debe liquidar Explora.`;
}

function renderOperationPreview() {
  if (!pendingOperationPreview) return;
  const definition = previewDefinition(pendingOperationPreview.kind, pendingOperationPreview.amount);
  const beforeState = settlementState(pendingOperationPreview.beforeBalance, "before");
  const afterState = settlementState(pendingOperationPreview.afterBalance, "now");

  $("operationPreviewModal").dataset.tone = pendingOperationPreview.kind;
  $("operationPreviewTitle").textContent = definition.title;
  $("operationPreviewSubtitle").textContent = definition.subtitle;
  $("operationPreviewAmountLabel").textContent = definition.amountLabel;
  $("operationPreviewAmount").textContent = money(pendingOperationPreview.amount);
  $("operationPreviewImpactLabel").textContent = definition.impactLabel;
  $("operationPreviewImpact").textContent = signedMoney(definition.delta);
  $("operationPreviewBeforeLabel").textContent = beforeState.label;
  $("operationPreviewBeforeAmount").textContent = money(beforeState.amount);
  $("operationPreviewAfterLabel").textContent = afterState.label;
  $("operationPreviewAfterAmount").textContent = money(afterState.amount);
  $("operationPreviewImpactText").textContent = operationImpactMessage(definition.delta, pendingOperationPreview.afterBalance);
  $("operationPreviewNotice").textContent = `${definition.notice} Nada se guarda antes de confirmar.`;
  $("operationPreviewConfirm").textContent = definition.confirmLabel;
  $("operationPreviewConfirm").disabled = false;
}

function openOperationPreview({ kind, amount, formId }) {
  const definition = previewDefinition(kind, amount);
  const beforeBalance = settlementModel().balance;
  pendingOperationPreview = {
    kind,
    amount:Number(amount || 0),
    formId,
    beforeBalance,
    afterBalance:normalizedSettlementBalance(beforeBalance + definition.delta)
  };
  $("operationPreviewStatus").textContent = "";
  $("operationPreviewStatus").className = "status";
  renderOperationPreview();
  $("operationPreviewModal").classList.remove("hidden");
}

function closeOperationPreview() {
  $("operationPreviewModal")?.classList.add("hidden");
  pendingOperationPreview = null;
}

$("operationPreviewBack")?.addEventListener("click", closeOperationPreview);

$("operationPreviewConfirm")?.addEventListener("click", () => {
  if (!pendingOperationPreview) return;

  // Si llegó otra operación mientras el segundo aviso estaba abierto, se
  // actualiza la calculadora y se exige una nueva confirmación sobre ese valor.
  const currentBalance = settlementModel().balance;
  if (Math.abs(currentBalance - pendingOperationPreview.beforeBalance) > 0.5) {
    const definition = previewDefinition(pendingOperationPreview.kind, pendingOperationPreview.amount);
    pendingOperationPreview.beforeBalance = currentBalance;
    pendingOperationPreview.afterBalance = normalizedSettlementBalance(currentBalance + definition.delta);
    $("operationPreviewStatus").textContent = "El saldo cambió. Revisá los valores actualizados y confirmá nuevamente.";
    $("operationPreviewStatus").className = "status error";
    renderOperationPreview();
    return;
  }

  const form = $(pendingOperationPreview.formId);
  if (!form) return;
  form.dataset.previewConfirmed = "true";
  $("operationPreviewConfirm").disabled = true;
  $("operationPreviewModal").classList.add("hidden");
  pendingOperationPreview = null;
  form.requestSubmit();
});

$("compensateDebtBtn")?.addEventListener("click", openDebtCompensationModal);

$("confirmDebtCompensation")?.addEventListener("click", async () => {
  const user = auth.currentUser;
  if (!user) return;

  // Se vuelve a calcular al confirmar para no utilizar un saldo desactualizado.
  const model = settlementModel();
  const amount = model.compensationAvailable;
  if (amount <= 0.5) {
    $("debtCompensationStatus").textContent = "Ya no hay saldo disponible para compensar.";
    $("debtCompensationStatus").className = "status error";
    return;
  }

  const remainingBalance = Math.max(0, model.balance - amount);
  const remainingReimbursement = Math.max(0, model.expenseReimbursement - amount);
  const button = $("confirmDebtCompensation");
  button.disabled = true;
  button.textContent = "Compensando…";
  $("debtCompensationStatus").textContent = "";

  try {
    // El identificador determinístico evita que dos dispositivos registren
    // dos veces la misma compensación antes de recibir la actualización.
    const compensationId = [
      "balance_comp",
      localDayKey(),
      Math.round(model.balance),
      Math.round(model.expenseHalf),
      Math.round(model.reimbursementApplied)
    ].join("_");
    const compensationRef = doc(db, ROOT_COLLECTIONS.payments, compensationId);
    await setDoc(compensationRef, {
      method: "digital",
      paymentMethod: "internal_compensation",
      type: "reimbursement_compensation",
      internalSettlementAdjustment: true,
      excludeFromBillingSettlement: true,
      suppressTelegram: true,
      amount,
      monto: amount,
      service: "Reintegro aplicado",
      detail: `Se utilizaron ${money(amount)} del reintegro de gastos para reducir la diferencia Chofer–Explora. Saldo restante: ${money(remainingBalance)}.`,
      compensationSource: "expense_reimbursement",
      reimbursementBefore: model.expenseReimbursement,
      reimbursementAfter: remainingReimbursement,
      settlementBefore: model.balance,
      settlementAfter: remainingBalance,
      internalReceipt: true,
      proofUrl: "",
      proofPath: "",
      dayKey: localDayKey(),
      operatorUid: user.uid,
      operatorName: currentDriverName(),
      driverUid: user.uid,
      choferUid: user.uid,
      uid: user.uid,
      driverName: currentDriverName(),
      businessId: BUSINESS_ID,
      weeklyPeriodId: currentWeeklyPeriodId(),
      createdAtMs: Date.now(),
      createdAt: serverTimestamp()
    });

    $("debtCompensationStatus").textContent = `Se aplicaron ${money(amount)} para reducir la diferencia Chofer–Explora.`;
    $("debtCompensationStatus").className = "status success";
    setTimeout(() => $("debtCompensationModal").classList.add("hidden"), 1200);
  } catch (err) {
    console.error(err);
    if (err?.code === "permission-denied") {
      $("debtCompensationStatus").textContent = "Esta compensación ya fue registrada. Actualizando los saldos…";
      $("debtCompensationStatus").className = "status success";
      setTimeout(() => $("debtCompensationModal").classList.add("hidden"), 1200);
    } else {
      $("debtCompensationStatus").textContent = "No se pudo compensar la diferencia. Intentá nuevamente.";
      $("debtCompensationStatus").className = "status error";
      button.disabled = false;
      button.textContent = "OK, compensar";
    }
  }
});

$("requestAdvanceBtn")?.addEventListener("click", openAdvanceModal);
$("advanceAmount")?.addEventListener("input", renderAdvanceQuote);

$("advanceForm")?.addEventListener("submit", async event => {
  event.preventDefault();
  const user = auth.currentUser;
  if (!user || isAdminProfile()) return;

  const principal = parseMoneyInput($("advanceAmount").value);
  const quote = advanceQuote(principal);
  if (!principal || principal <= 0) {
    $("advanceStatus").textContent = "Ingresá el monto que querés recibir.";
    $("advanceStatus").className = "status error";
    return;
  }
  if (principal > ADVANCE_MAX_AMOUNT) {
    $("advanceStatus").textContent = `El adelanto máximo es de ${money(ADVANCE_MAX_AMOUNT)}.`;
    $("advanceStatus").className = "status error";
    return;
  }
  const pendingAdvance = advances.some(item => /pending/.test(String(item.approvalStatus || item.status || "").toLowerCase()));
  if (pendingAdvance) {
    $("advanceStatus").textContent = "Ya tenés una solicitud de adelanto pendiente de respuesta de Admin.";
    $("advanceStatus").className = "status error";
    return;
  }

  // La elegibilidad se valida solamente al confirmar, tal como se informa
  // en el formulario. El chofer puede completar y revisar antes la cotización.
  const model = settlementModel();
  const difference = Math.abs(model.balance);
  if (difference >= ADVANCE_DIFFERENCE_LIMIT) {
    $("advanceStatus").textContent = model.balance > 0
      ? `Actualmente le debés ${money(difference)} a Explora. Reducí esa diferencia por debajo de ${money(ADVANCE_DIFFERENCE_LIMIT)} y volvé a solicitar el adelanto.`
      : `La diferencia actual entre Chofer y Explora es de ${money(difference)}. Debe ser menor a ${money(ADVANCE_DIFFERENCE_LIMIT)} para solicitar un adelanto.`;
    $("advanceStatus").className = "status error";
    return;
  }

  const button = $("confirmAdvanceBtn");
  button.disabled = true;
  button.textContent = "Solicitando…";
  $("advanceStatus").textContent = "";

  try {
    const advancesRef = collection(db, ROOT_COLLECTIONS.advances);
    await addDoc(advancesRef, {
      type: "cash_advance",
      loanType: "cash_advance",
      driverUid: user.uid,
      choferUid: user.uid,
      uid: user.uid,
      driverId: user.uid,
      driverName: currentDriverName(),
      amount: quote.principal,
      originalAmount: quote.principal,
      principalAmount: quote.principal,
      interestPercent: 40,
      interestAmount: quote.interest,
      totalDebt: quote.total,
      requestedTotalDebt: quote.total,
      remainingAmount: 0,
      repaidAmount: 0,
      status: "pending_admin_approval",
      approvalStatus: "pending",
      differenceAtRequest: difference,
      requestedDayKey: localDayKey(),
      weeklyPeriodId: currentWeeklyPeriodId(),
      operatorUid: user.uid,
      operatorName: currentDriverName(),
      businessId: BUSINESS_ID,
      createdAtMs: Date.now(),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });

    $("advanceStatus").textContent = `Solicitud enviada. Admin debe aprobar el adelanto de ${money(quote.principal)} antes de que se active.`;
    $("advanceStatus").className = "status success";
    setTimeout(() => $("advanceModal").classList.add("hidden"), 1700);
  } catch (err) {
    console.error(err);
    $("advanceStatus").textContent = "No se pudo registrar el adelanto. Intentá nuevamente.";
    $("advanceStatus").className = "status error";
    button.disabled = false;
    button.textContent = "Confirmar adelanto";
  }
});

$("chargeForm")?.addEventListener("submit", async e => {
  e.preventDefault();
  const user = auth.currentUser;
  if (!user) return;
  const mode = $("chargeMode").value;
  const service = mode === "cash" ? "Cobro en efectivo" : "Cobro digital";
  const amount = parseMoneyInput($("chargeAmount").value);
  const file = selectedPhotoFile("digital");

  if (!amount || amount <= 0) {
    $("chargeStatus").textContent = "Ingresá un importe válido.";
    $("chargeStatus").className = "status error";
    return;
  }

  if (mode === "digital" && !file) {
    $("chargeStatus").textContent = "Adjuntá el comprobante del cobro digital.";
    $("chargeStatus").className = "status error";
    return;
  }
  if (mode === "digital" && !advancesLoaded) {
    $("chargeStatus").textContent = "Esperá un momento mientras se actualiza el saldo de adelantos.";
    $("chargeStatus").className = "status error";
    return;
  }
  if ($("chargeForm").dataset.previewConfirmed !== "true") {
    openOperationPreview({ kind:mode, amount, formId:"chargeForm" });
    return;
  }
  delete $("chargeForm").dataset.previewConfirmed;
  if (!acquireSubmissionLock("charge")) {
    $("chargeStatus").textContent = "Este cobro ya se está procesando.";
    $("chargeStatus").className = "status";
    return;
  }

  $("saveChargeBtn").disabled = true;
  $("saveChargeBtn").textContent = "Verificando…";
  $("chargeStatus").textContent = "";

  let fingerprint = "";
  let operation = null;
  let paymentRef = null;
  let completedSuccessfully = false;
  try {
    const enteredDetail = $("detail").value.trim();
    const settlementBeforeCharge = settlementModel().balance;
    const chargeDelta = mode === "cash" ? amount * 0.55 : amount * -0.50;
    const settlementAfterCharge = normalizedSettlementBalance(settlementBeforeCharge + chargeDelta);
    fingerprint = await buildSubmissionFingerprint("charge", {
      mode,
      amount,
      detail:enteredDetail
    });
    operation = reservePendingOperation("payment", user.uid, fingerprint);
    paymentRef = doc(db, ROOT_COLLECTIONS.payments, operation.operationId);
    $("saveChargeBtn").textContent = "Guardando…";

    let proofUrl = "";
    let proofPath = "";
    if (mode === "digital" && file) {
      const cleanName = file.name.replace(/[^a-zA-Z0-9._-]/g,"_");
      proofPath = `billing_receipts/${user.uid}/${localDayKey()}/${operation.operationId}_${cleanName}`;
      const storageRef = ref(storage, proofPath);
      await retryFirebaseOperation(() => uploadBytes(storageRef, file), 4);
      proofUrl = await retryFirebaseOperation(() => getDownloadURL(storageRef), 4);
    }

    const candidateAdvanceRefs = mode === "digital"
      ? advances
          .filter(item => advanceRemaining(item) > 0.5)
          .map(item => doc(db, ROOT_COLLECTIONS.advances, item.id))
      : [];

    // La transacción vuelve a leer los adelantos antes de descontarlos. Así,
    // dos cobros simultáneos no pueden pisarse ni perder una devolución.
    const transactionResult = await runTransactionWithRetry(async transaction => {
      const existingPayment = await transaction.get(paymentRef);
      if (assertSameCommittedOperation(existingPayment, operation.operationId, fingerprint)) {
        return { alreadyRegistered:true };
      }

      const freshAdvances = [];
      for (const advanceRef of candidateAdvanceRefs) {
        const snap = await transaction.get(advanceRef);
        if (snap.exists()) freshAdvances.push({ id: snap.id, ...snap.data() });
      }

      const repaymentPlan = mode === "digital"
        ? planAdvanceRepayment(Math.floor(amount * 0.50), freshAdvances)
        : { allocations: [], totalApplied: 0 };
      const paymentDetail = [
        enteredDetail,
        repaymentPlan.totalApplied > 0.5 ? `Aplicado al adelanto: ${money(repaymentPlan.totalApplied)}` : ""
      ].filter(Boolean).join(" · ");

      transaction.set(paymentRef, {
        method: mode,
        paymentMethod: mode === "cash" ? "cash" : "digital",
        metodoPago: mode === "cash" ? "cash" : "digital",
        financialCategory: mode === "cash" ? "cash" : "digital",
        type: mode === "cash" ? "billing" : "payment",
        amount,
        monto: amount,
        valor: amount,
        finalPrice: amount,
        service,
        serviceDescription: service,
        detail: paymentDetail,
        notes: paymentDetail,
        advanceRepaymentAmount: repaymentPlan.totalApplied,
        advanceAllocations: repaymentPlan.allocations.map(item => ({
          advanceId: item.id,
          amount: item.applied
        })),
        proofUrl,
        proofPath,
        receiptUrl: proofUrl,
        receiptPath: proofPath,
        receiptRequired: mode === "digital",
        cashboxRate: mode === "cash" ? 0.05 : 0,
        cashboxAmount: mode === "cash" ? amount * 0.05 : 0,
        telegramSettlementBeforeBalance: settlementBeforeCharge,
        telegramSettlementAfterBalance: settlementAfterCharge,
        telegramSettlementPayer: settlementAfterCharge > 0.5 ? "driver" : settlementAfterCharge < -0.5 ? "explora" : "balanced",
        dayKey: localDayKey(),
        weeklyPeriodId: currentWeeklyPeriodId(),
        operatorUid: user.uid,
        operatorName: currentDriverName(),
        driverUid: user.uid,
        choferUid: user.uid,
        uid: user.uid,
        ownerUid: user.uid,
        driverId: user.uid,
        driverName: currentDriverName(),
        status: "completed",
        source: "barberia-main-migrated",
        idempotencyKey: operation.operationId,
        clientOperationId: operation.operationId,
        submissionFingerprint: fingerprint,
        idempotencyVersion: 1,
        createdAtMs: operation.createdAtMs,
        businessId: BUSINESS_ID,
        createdAt: serverTimestamp()
      });
      repaymentPlan.allocations.forEach(item => {
        const advanceRef = doc(db, ROOT_COLLECTIONS.advances, item.id);
        transaction.update(advanceRef, {
          remainingAmount: item.remainingAmount,
          repaidAmount: item.repaidAmount,
          status: item.status,
          updatedAt: serverTimestamp()
        });
      });
      return { alreadyRegistered:false };
    });

    clearPendingOperation("payment", user.uid, fingerprint, operation.operationId);
    $("chargeStatus").textContent = transactionResult?.alreadyRegistered
      ? "Éxito. El cobro ya estaba registrado y se mantuvo una sola vez."
      : mode === "cash"
        ? "Éxito. Cobro en efectivo registrado correctamente."
        : "Éxito. Cobro digital registrado correctamente.";
    $("chargeStatus").className = "status success";
    completedSuccessfully = true;
    $("saveChargeBtn").textContent = "Éxito ✓";
    $("chargeForm").reset();
    closeModalAndGoTop("chargeModal", 1200);
  } catch (err) {
    console.error(err);
    const committed = paymentRef && operation && fingerprint
      ? await confirmCommittedOperation(paymentRef, operation.operationId, fingerprint)
      : false;
    if (committed) {
      clearPendingOperation("payment", user.uid, fingerprint, operation.operationId);
      $("chargeStatus").textContent = "Éxito. Cobro confirmado y registrado una sola vez.";
      $("chargeStatus").className = "status success";
      completedSuccessfully = true;
      $("saveChargeBtn").textContent = "Éxito ✓";
      $("chargeForm").reset();
      closeModalAndGoTop("chargeModal", 1200);
    } else {
      $("chargeStatus").textContent = "No pudimos confirmar el cobro. Podés volver a tocar Registrar: se reintentará la misma operación sin duplicarla.";
      $("chargeStatus").className = "status error";
    }
  } finally {
    releaseSubmissionLock("charge");
    if (!completedSuccessfully) {
      $("saveChargeBtn").disabled = false;
      $("saveChargeBtn").textContent = "Registrar cobro";
    }
  }
});

$("addExpenseBtn")?.addEventListener("click", () => {
  $("expenseForm").reset();
  delete $("expenseForm").dataset.previewConfirmed;
  $("expenseStatus").textContent = "";
  $("expenseStatus").className = "status";
  $("saveExpenseBtn").disabled = false;
  $("saveExpenseBtn").textContent = "Registrar gasto";
  $("expenseModal").classList.remove("hidden");
});

$("addDebtBtn")?.addEventListener("click", () => {
  if (!isAdminProfile()) return;
  renderAdminDriverOptions();
  $("debtForm").reset();
  $("debtStatus").textContent = "";
  $("debtStatus").className = "status";
  $("debtModal").classList.remove("hidden");
});

$("debtForm")?.addEventListener("submit", async event => {
  event.preventDefault();
  const admin = auth.currentUser;
  if (!admin || !isAdminProfile()) return;

  const driver = adminDriverById($("debtDriver").value);
  const amount = parseMoneyInput($("debtAmount").value);
  const detail = $("debtDetail").value.trim();
  const file = $("debtProof").files?.[0];

  if (!driver || !adminDriverIsActive(driver)) {
    $("debtStatus").textContent = "Seleccioná un chofer activo.";
    $("debtStatus").className = "status error";
    return;
  }
  if (!amount || amount <= 0) {
    $("debtStatus").textContent = "Ingresá un importe válido.";
    $("debtStatus").className = "status error";
    return;
  }
  if (!detail) {
    $("debtStatus").textContent = "Indicá el motivo de la deuda.";
    $("debtStatus").className = "status error";
    return;
  }
  if (!file) {
    $("debtStatus").textContent = "Adjuntá el comprobante de la deuda.";
    $("debtStatus").className = "status error";
    return;
  }

  $("saveDebtBtn").disabled = true;
  $("saveDebtBtn").textContent = "Guardando…";
  $("debtStatus").textContent = "";

  try {
    const settlementBeforeDebt = adminBillingBalanceForDriver(driver);
    const debtBalanceBefore = adminDebts
      .filter(item => adminRecordBelongsToDriver(item, driver))
      .filter(item => !movementIsDeleted(item) && debtImpactsSettlement(item))
      .reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const settlementAfterDebt = settlementBeforeDebt + amount;
    const cleanName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const proofPath = `deudas/${driver.id}/${localDayKey()}_${Date.now()}_${cleanName}`;
    const storageRef = ref(storage, proofPath);
    await uploadBytes(storageRef, file);
    const proofUrl = await getDownloadURL(storageRef);

    const debtRef = await addDoc(collection(db, ROOT_COLLECTIONS.debts), {
      type: "admin_debt",
      debtType: "admin_debt",
      amount,
      monto: amount,
      totalAmount: amount,
      originalAmount: amount,
      remainingAmount: amount,
      saldoPendiente: amount,
      paidAmount: 0,
      amountPaid: 0,
      detail,
      reason: detail,
      notes: detail,
      proofUrl,
      proofPath,
      proofMimeType: file.type || "",
      proofFileName: file.name || cleanName,
      receiptUrl: proofUrl,
      receiptPath: proofPath,
      receiptMimeType: file.type || "",
      receiptFileName: file.name || cleanName,
      dayKey: localDayKey(),
      driverUid: driver.id,
      choferUid: driver.id,
      uid: driver.id,
      ownerUid: driver.id,
      driverId: driver.id,
      operatorUid: driver.id,
      driverName: adminDriverLabel(driver),
      operatorName: adminDriverLabel(driver),
      sourceModule: "pendientes",
      status: "active",
      debtStatus: "active",
      acknowledgedByDriver: false,
      driverConfirmationRequired: true,
      driverConfirmationVersion: 1,
      createdByRole: "admin",
      registeredByAdmin: true,
      registrationOrigin: "admin_debt_menu",
      driverDebtBalanceBefore: debtBalanceBefore,
      driverDebtBalanceAfter: debtBalanceBefore + amount,
      telegramSettlementBeforeBalance: settlementBeforeDebt,
      telegramSettlementAfterBalance: settlementAfterDebt,
      telegramSettlementPayer: settlementAfterDebt > 0.5 ? "driver" : settlementAfterDebt < -0.5 ? "explora" : "balanced",
      businessId: BUSINESS_ID,
      createdByUid: admin.uid,
      createdByName: currentProfile?.displayName || currentProfile?.username || "Administrador",
      createdAtMs: Date.now(),
      createdAt: serverTimestamp()
    });

    await writeAdminAudit("admin_add_driver_debt", {
      targetUid: driver.id,
      targetName: adminDriverLabel(driver),
      debtId: debtRef.id,
      amount,
      detail,
      proofUrl
    });

    $("debtStatus").textContent = `Deuda de ${money(amount)} agregada a ${adminDriverLabel(driver)}.`;
    $("debtStatus").className = "status success";
    setTimeout(() => $("debtModal").classList.add("hidden"), 900);
  } catch (err) {
    console.error(err);
    $("debtStatus").textContent = "No se pudo registrar la deuda.";
    $("debtStatus").className = "status error";
  } finally {
    $("saveDebtBtn").disabled = false;
    $("saveDebtBtn").textContent = "Registrar deuda";
  }
});



$("adminAdjustmentForm")?.addEventListener("submit", async event => {
  event.preventDefault();
  const admin = auth.currentUser;
  if (!admin || !isAdminProfile()) return;

  const driver = adminDriverById($("adjustmentDriver").value);
  const movementType = $("adjustmentType").value;
  const amount = parseMoneyInput($("adjustmentAmount").value);
  const detail = $("adjustmentDetail").value.trim();
  const file = $("adjustmentProof").files?.[0];
  const status = $("adminAdjustmentStatus");
  const button = $("saveAdminAdjustmentBtn");

  if (!driver) {
    status.textContent = "Seleccioná un chofer.";
    status.className = "status error";
    return;
  }
  if (!amount || amount <= 0) {
    status.textContent = "Ingresá un importe válido.";
    status.className = "status error";
    return;
  }
  if (!detail) {
    status.textContent = "Indicá el motivo del movimiento.";
    status.className = "status error";
    return;
  }
  if (!file) {
    status.textContent = "Adjuntá el comprobante.";
    status.className = "status error";
    return;
  }

  if (movementType === "debt_payment") {
    const debtTotal = adminOpenDebtTotalForDriver(driver);
    if (debtTotal <= 0.5) {
      status.textContent = `${adminDriverLabel(driver)} no tiene deuda pendiente.`;
      status.className = "status error";
      return;
    }
    if (amount > debtTotal + 0.5) {
      status.textContent = `El pago no puede superar la deuda pendiente de ${money(debtTotal)}.`;
      status.className = "status error";
      return;
    }
  }

  button.disabled = true;
  button.textContent = "Guardando…";
  status.textContent = "";

  try {
    const cleanName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const folder = movementType === "debt_payment" ? "deudas" : "billing_receipts";
    const proofPath = movementType === "debt_payment"
      ? `${folder}/${driver.id}/pagos/${localDayKey()}_${Date.now()}_${cleanName}`
      : `${folder}/${driver.id}/admin_${localDayKey()}_${Date.now()}_${cleanName}`;
    const storageRef = ref(storage, proofPath);
    await uploadBytes(storageRef, file);
    const proofUrl = await getDownloadURL(storageRef);

    if (movementType === "debt_payment") {
      const localDebts = adminOpenDebtItemsForDriver(driver);
      const debtRefs = localDebts.map(item => doc(db, ROOT_COLLECTIONS.debts, item.id));
      const paymentRef = doc(collection(db, ROOT_COLLECTIONS.debtPayments));

      await runTransaction(db, async transaction => {
        const snapshots = [];
        for (const debtRef of debtRefs) snapshots.push(await transaction.get(debtRef));

        let remainingPayment = amount;
        const allocations = [];

        for (const snap of snapshots) {
          if (!snap.exists() || remainingPayment <= 0.5) continue;
          const data = snap.data() || {};
          const statusText = String(data.status || data.debtStatus || "").toLowerCase();
          if (/paid|pagad|closed|cerrad|cancel|anulad|deleted|eliminad/.test(statusText)) continue;

          const currentRemaining = Math.max(0, Number(data.remainingAmount ?? data.saldoPendiente ?? data.amount ?? data.totalAmount ?? 0) || 0);
          if (currentRemaining <= 0.5) continue;
          const applied = Math.min(currentRemaining, remainingPayment);
          const nextRemaining = Math.max(0, currentRemaining - applied);
          const previousPaid = Math.max(0, Number(data.paidAmount ?? data.amountPaid ?? 0) || 0);
          const nextPaid = previousPaid + applied;

          transaction.update(snap.ref, {
            remainingAmount: nextRemaining,
            saldoPendiente: nextRemaining,
            paidAmount: nextPaid,
            amountPaid: nextPaid,
            status: nextRemaining <= 0.5 ? "paid" : "active",
            debtStatus: nextRemaining <= 0.5 ? "paid" : "active",
            lastPaymentAt: serverTimestamp(),
            lastPaymentAtMs: Date.now(),
            lastPaymentMethod: "admin_registered_payment",
            updatedAt: serverTimestamp(),
            updatedAtMs: Date.now()
          });

          allocations.push({ debtId: snap.id, amount: applied });
          remainingPayment -= applied;
        }

        transaction.set(paymentRef, {
          type: "admin_debt_payment",
          operationType: "debt_payment",
          paymentMethod: "admin_registered_payment",
          amount,
          monto: amount,
          detail,
          notes: detail,
          allocations,
          proofUrl,
          proofPath,
          receiptUrl: proofUrl,
          receiptPath: proofPath,
          driverUid: driver.id,
          choferUid: driver.id,
          uid: driver.id,
          ownerUid: driver.id,
          driverId: driver.id,
          operatorUid: driver.id,
          driverName: adminDriverLabel(driver),
          operatorName: adminDriverLabel(driver),
          sourceModule: "pendientes",
          createdByUid: admin.uid,
          createdByRole: "admin",
          createdByName: currentProfile?.displayName || currentProfile?.username || "Administrador",
          businessId: BUSINESS_ID,
          dayKey: localDayKey(),
          createdAtMs: Date.now(),
          createdAt: serverTimestamp()
        });
      });

      await writeAdminAudit("admin_register_driver_debt_payment", {
        targetUid: driver.id,
        targetName: adminDriverLabel(driver),
        amount,
        detail,
        proofUrl
      });

      status.textContent = `Pago de deuda de ${money(amount)} registrado para ${adminDriverLabel(driver)}.`;
    } else {
      const direction = movementType === "explora_to_driver" ? "explora_to_driver" : "driver_to_explora";
      const method = direction === "explora_to_driver" ? "cash" : "digital";
      const service = direction === "explora_to_driver" ? "Ajuste de Explora" : "Ajuste del chofer";
      const paymentRef = await addDoc(collection(db, ROOT_COLLECTIONS.payments), {
        method,
        paymentMethod: "admin_manual_adjustment",
        metodoPago: "admin_manual_adjustment",
        financialCategory: "admin_manual_adjustment",
        type: "settlement_adjustment",
        operationType: "settlement_adjustment",
        sourceModule: "facturacion",
        affectsBillingSettlement: true,
        adjustmentDirection: direction,
        internalSettlementAdjustment: true,
        excludeFromBillingSettlement: true,
        suppressTelegram: true,
        amount,
        monto: amount,
        service,
        detail,
        notes: detail,
        proofUrl,
        proofPath,
        receiptUrl: proofUrl,
        receiptPath: proofPath,
        dayKey: localDayKey(),
        weeklyPeriodId: currentWeeklyPeriodId(),
        driverUid: driver.id,
        choferUid: driver.id,
        uid: driver.id,
        ownerUid: driver.id,
        driverId: driver.id,
        operatorUid: driver.id,
        driverName: adminDriverLabel(driver),
        operatorName: adminDriverLabel(driver),
        createdByUid: admin.uid,
        createdByRole: "admin",
        createdByName: currentProfile?.displayName || currentProfile?.username || "Administrador",
        businessId: BUSINESS_ID,
        createdAtMs: Date.now(),
        createdAt: serverTimestamp()
      });

      await writeAdminAudit("admin_register_billing_adjustment", {
        targetUid: driver.id,
        targetName: adminDriverLabel(driver),
        paymentId: paymentRef.id,
        direction,
        amount,
        detail,
        proofUrl
      });

      status.textContent = `${service} por ${money(amount)} registrado para ${adminDriverLabel(driver)}.`;
    }

    status.className = "status success";
    $("adminAdjustmentForm").reset();
    renderAdminDriverOptions();
    setTimeout(() => $("adminAdjustmentModal").classList.add("hidden"), 1100);
  } catch (err) {
    console.error(err);
    status.textContent = "No se pudo registrar el movimiento.";
    status.className = "status error";
  } finally {
    button.disabled = false;
    button.textContent = "Registrar movimiento";
  }
});

async function annulAdminDebt(debtId = "") {
  const admin = auth.currentUser;
  if (!admin || !isAdminProfile() || !debtId) return;

  const debt = adminDebts.find(item => item.id === debtId);
  if (!debt || Number(debt.amount || 0) <= 0.5) return;

  const reason = window.prompt("Motivo de la anulación de la deuda:");
  if (!String(reason || "").trim()) return;

  const status = $("adminHistoryStatus");
  status.textContent = "Anulando deuda…";
  status.className = "status";

  try {
    const debtRef = doc(db, ROOT_COLLECTIONS.debts, debtId);
    await setDoc(debtRef, {
      remainingAmount: 0,
      saldoPendiente: 0,
      status: "anulado",
      debtStatus: "anulado",
      annulledReason: String(reason).trim(),
      annulledByUid: admin.uid,
      annulledByName: currentProfile?.displayName || currentProfile?.username || "Administrador",
      annulledAtMs: Date.now(),
      annulledAt: serverTimestamp(),
      updatedAtMs: Date.now(),
      updatedAt: serverTimestamp()
    }, { merge: true });

    await writeAdminAudit("admin_annul_driver_debt", {
      targetUid: debt.operatorUid || debt.driverUid || debt.uid || "",
      debtId,
      originalAmount: Number(debt.totalAmount || debt.amount || 0),
      reason: String(reason).trim()
    });

    status.textContent = "Deuda anulada. El movimiento quedó registrado en el historial.";
    status.className = "status success";
  } catch (err) {
    console.error(err);
    status.textContent = "No se pudo anular la deuda.";
    status.className = "status error";
  }
}

$("expenseForm")?.addEventListener("submit", async e => {
  e.preventDefault();
  const user = auth.currentUser;
  if (!user) return;

  const amount = parseMoneyInput($("expenseAmount").value);
  const detail = $("expenseDetail").value.trim();
  const file = selectedPhotoFile("expense");

  if (!amount || amount <= 0) {
    $("expenseStatus").textContent = "Ingresá un importe válido.";
    $("expenseStatus").className = "status error";
    return;
  }
  if (!detail) {
    $("expenseStatus").textContent = "Indicá el motivo del gasto.";
    $("expenseStatus").className = "status error";
    return;
  }
  if (!file) {
    $("expenseStatus").textContent = "Adjuntá el comprobante del gasto.";
    $("expenseStatus").className = "status error";
    return;
  }
  if ($("expenseForm").dataset.previewConfirmed !== "true") {
    openOperationPreview({ kind:"expense", amount, formId:"expenseForm" });
    return;
  }
  delete $("expenseForm").dataset.previewConfirmed;
  if (!acquireSubmissionLock("expense")) {
    $("expenseStatus").textContent = "Este gasto ya se está procesando.";
    $("expenseStatus").className = "status";
    return;
  }

  $("saveExpenseBtn").disabled = true;
  $("saveExpenseBtn").textContent = "Verificando…";
  $("expenseStatus").textContent = "";

  let fingerprint = "";
  let operation = null;
  let expenseRef = null;
  let completedSuccessfully = false;
  let expenseBeforeBalance = 0;
  let expenseAfterBalance = 0;
  try {
    fingerprint = await buildSubmissionFingerprint("expense", {
      amount,
      detail,
      expenseType:"otros"
    });
    operation = reservePendingOperation("expense", user.uid, fingerprint);
    expenseRef = doc(db, ROOT_COLLECTIONS.expenses, operation.operationId);
    $("saveExpenseBtn").textContent = "Guardando…";

    const cleanName = file.name.replace(/[^a-zA-Z0-9._-]/g,"_");
    const proofPath = `gastos/${user.uid}/${operation.operationId}/comprobante_${cleanName}`;
    const storageRef = ref(storage, proofPath);
    await retryFirebaseOperation(() => uploadBytes(storageRef, file), 4);
    const proofUrl = await retryFirebaseOperation(() => getDownloadURL(storageRef), 4);

    // El 50% del gasto impacta AUTOMÁTICAMENTE en "Quién paga a quién".
    // Se congela el saldo justo antes del alta para mostrar el cambio exacto en el modal
    // y para que Telegram informe el mismo resultado que ve el chofer.
    const settlementBeforeExpense = settlementModel();
    const recognizedExpense = amount * 0.50;
    expenseBeforeBalance = settlementBeforeExpense.balance;
    const rawAfterBalance = expenseBeforeBalance - recognizedExpense;
    expenseAfterBalance = Math.abs(rawAfterBalance) > 0.5 ? rawAfterBalance : 0;

    // IMPORTANTE: no hacemos transaction.get(expenseRef) antes de crear el gasto.
    // La regla de Firestore de /gastos permite leer solo documentos que ya pertenecen
    // al chofer. Un documento nuevo todavía no existe, por lo que ese get devolvía
    // permission-denied y abortaba la transacción antes del create.
    // El ID de operación ya es estable/idempotente: setDoc sobre el mismo ID permite
    // reintentar sin duplicar y sin relajar las reglas de seguridad.
    const expensePayload = {
      amount,
      monto: amount,
      detail,
      notes: detail,
      expenseType: "otros",
      tipo: "otros",
      category: "otros",
      proofUrl,
      proofPath,
      receiptUrl: proofUrl,
      receiptPath: proofPath,
      dayKey: localDayKey(),
      weeklyPeriodId: currentWeeklyPeriodId(),
      operatorUid: user.uid,
      operatorName: currentDriverName(),
      driverUid: user.uid,
      choferUid: user.uid,
      uid: user.uid,
      ownerUid: user.uid,
      driverId: user.uid,
      choferId: user.uid,
      driverName: currentDriverName(),
      choferNombre: currentDriverName(),
      payerRole: "driver",
      sharedRate: 0.5,
      porcentajeCompartido: 50,
      // Marcadores explícitos para que este gasto sea el que sí aplica 50% automático.
      autoApplyToBilling: true,
      gastoAuto50: true,
      billingImpactMode: "auto_50",
      billingImpactAmount: recognizedExpense,
      // Telegram recibe el gasto nuevo, el 50% reconocido y el saldo final de facturación.
      telegramExpenseLoadedAmount: amount,
      telegramExpenseRecognizedAmount: recognizedExpense,
      telegramSettlementBeforeBalance: expenseBeforeBalance,
      telegramSettlementAfterBalance: expenseAfterBalance,
      telegramSettlementPayer: expenseAfterBalance > 0.5 ? "driver" : expenseAfterBalance < -0.5 ? "explora" : "balanced",
      status: "active",
      idempotencyKey: operation.operationId,
      clientOperationId: operation.operationId,
      submissionFingerprint: fingerprint,
      idempotencyVersion: 1,
      createdAtMs: operation.createdAtMs,
      businessId: BUSINESS_ID,
      createdAt: serverTimestamp()
    };
    await retryFirebaseOperation(() => setDoc(expenseRef, expensePayload), 4);
    const transactionResult = { alreadyRegistered:false };

    clearPendingOperation("expense", user.uid, fingerprint, operation.operationId);
    $("expenseStatus").textContent = transactionResult?.alreadyRegistered
      ? "Éxito. El gasto ya estaba registrado y se mantuvo una sola vez."
      : "Éxito. Gasto registrado correctamente.";
    $("expenseStatus").className = "status success";
    completedSuccessfully = true;
    $("saveExpenseBtn").textContent = "Éxito ✓";
    $("expenseForm").reset();
    closeModalAndGoTop("expenseModal", 1200);
  } catch (err) {
    console.error(err);
    const committed = expenseRef && operation && fingerprint
      ? await confirmCommittedOperation(expenseRef, operation.operationId, fingerprint)
      : false;
    if (committed) {
      clearPendingOperation("expense", user.uid, fingerprint, operation.operationId);
      $("expenseStatus").textContent = "Éxito. Gasto confirmado y registrado una sola vez.";
      $("expenseStatus").className = "status success";
      completedSuccessfully = true;
      $("saveExpenseBtn").textContent = "Éxito ✓";
      $("expenseForm").reset();
      try {
        const committedSnapshot = await getDoc(expenseRef);
        const committedData = committedSnapshot.exists() ? committedSnapshot.data() : {};
        expenseBeforeBalance = Number(committedData.telegramSettlementBeforeBalance ?? expenseBeforeBalance ?? 0);
        expenseAfterBalance = Number(committedData.telegramSettlementAfterBalance ?? (expenseBeforeBalance - amount * 0.50));
      } catch (_) {}
      closeModalAndGoTop("expenseModal", 1200);
    } else {
      $("expenseStatus").textContent = "No pudimos confirmar el gasto. Podés volver a tocar Registrar: se reintentará la misma operación sin duplicarla.";
      $("expenseStatus").className = "status error";
    }
  } finally {
    releaseSubmissionLock("expense");
    if (!completedSuccessfully) {
      $("saveExpenseBtn").disabled = false;
      $("saveExpenseBtn").textContent = "Registrar gasto";
    }
  }
});

$("addUberBtn")?.addEventListener("click", () => {
  $("uberForm").reset();
  delete $("uberForm").dataset.previewConfirmed;
  $("uberStatus").textContent = "";
  $("uberStatus").className = "status";
  renderUberWeekSelector();
  $("uberModal").classList.remove("hidden");
});

$("uberWeekSelect")?.addEventListener("change", updateUberWeekSummary);

$("uberForm")?.addEventListener("submit", async e => {
  e.preventDefault();
  const user = auth.currentUser;
  if (!user) return;

  const amount = parseMoneyInput($("uberAmount").value);
  const week = selectedPendingUberWeek();
  const file = selectedPhotoFile("uber");

  if (!week) {
    $("uberStatus").textContent = "Elegí una semana cerrada pendiente.";
    $("uberStatus").className = "status error";
    renderUberWeekSelector();
    return;
  }
  if (!amount || amount <= 0) {
    $("uberStatus").textContent = "Ingresá el total semanal de Uber.";
    $("uberStatus").className = "status error";
    return;
  }
  if (!file) {
    $("uberStatus").textContent = `Adjuntá el comprobante de la semana ${week.label}.`;
    $("uberStatus").className = "status error";
    return;
  }
  if ($("uberForm").dataset.previewConfirmed !== "true") {
    openOperationPreview({ kind:"uber", amount, formId:"uberForm" });
    return;
  }
  delete $("uberForm").dataset.previewConfirmed;

  $("saveUberBtn").disabled = true;
  $("saveUberBtn").textContent = "Guardando…";
  $("uberStatus").textContent = "";

  try {
    // Se usa una identificación determinística para impedir que la misma
    // semana se cargue dos veces, incluso desde dos dispositivos distintos.
    const uberDocumentId = `uber_${user.uid}_${week.weekKey.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
    const uberDocRef = doc(db, ROOT_COLLECTIONS.uber, uberDocumentId);
    const existing = await getDoc(uberDocRef);
    if (existing.exists() || isUberWeekLoaded(week)) {
      $("uberStatus").textContent = `La semana ${week.label} ya tiene comprobante.`;
      $("uberStatus").className = "status error";
      renderUberWeekSelector();
      return;
    }

    const settlementBeforeUber = settlementModel().balance;
    const settlementAfterUber = normalizedSettlementBalance(settlementBeforeUber + (amount * 0.55));

    const cleanName = file.name.replace(/[^a-zA-Z0-9._-]/g,"_");
    const proofPath = `uber_weekly/${user.uid}/${week.weekKey}/${Date.now()}_${cleanName}`;
    const storageRef = ref(storage, proofPath);
    await uploadBytes(storageRef, file, {
      contentType: file.type || "image/jpeg",
      customMetadata: {
        module: "uber_weekly",
        driverUid: user.uid,
        weekId: week.weekKey,
        uploadedByUid: user.uid
      }
    });
    const proofUrl = await getDownloadURL(storageRef);

    await setDoc(uberDocRef, {
      closureId: uberDocumentId,
      weekId: week.weekKey,
      weekKey: week.weekKey,
      weekLabel: week.label,
      weekStartDate: week.weekStartDate,
      weekCloseDate: week.weekCloseDate,
      weekStartMs: parseLocalDateKey(week.weekStartDate)?.getTime() || Date.now(),
      weekEndMs: parseLocalDateKey(week.weekCloseDate)?.getTime() || Date.now(),
      grossAmount: amount,
      totalAmount: amount,
      amount,
      driverShare: amount * 0.50,
      driverNetAmount: amount * 0.50,
      exploraShare: amount * 0.50,
      debtAmount: amount * 0.50,
      cashboxRate: 0.05,
      cashboxAmount: amount * 0.05,
      uberCashboxAmount: amount * 0.05,
      proofUrl,
      proofPath,
      receiptUrl: proofUrl,
      receiptPath: proofPath,
      notificationPhotoUrl: proofUrl,
      telegramPhotoUrl: proofUrl,
      firebasePhotoUrl: proofUrl,
      telegramSettlementBeforeBalance: settlementBeforeUber,
      telegramSettlementAfterBalance: settlementAfterUber,
      telegramSettlementPayer: settlementAfterUber > 0.5 ? "driver" : settlementAfterUber < -0.5 ? "explora" : "balanced",
      dayKey: localDayKey(),
      driverUid: user.uid,
      choferUid: user.uid,
      uid: user.uid,
      driverId: user.uid,
      createdByUid: user.uid,
      createdByRole: "driver",
      driverName: currentDriverName(),
      operatorUid: user.uid,
      operatorName: currentDriverName(),
      reviewStatus: "pending",
      status: "pending_review",
      locked: true,
      businessId: BUSINESS_ID,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });

    // Reflejo inmediato: permite continuar con la siguiente semana atrasada
    // sin esperar la confirmación visual del listener de Firestore.
    const savedAt = new Date();
    uberClosures = [{
      id: week.weekKey,
      amount,
      weekStartDate: week.weekStartDate,
      weekCloseDate: week.weekCloseDate,
      weekKey: week.weekKey,
      weekLabel: week.label,
      proofUrl,
      proofPath,
      dayKey: localDayKey(),
      operatorUid: user.uid,
      operatorName: currentProfile?.displayName || currentProfile?.username || "",
      businessId: BUSINESS_ID,
      createdAt: { toMillis: () => savedAt.getTime(), toDate: () => savedAt }
    }, ...uberClosures.filter(item => item.id !== week.weekKey)];
    render();

    $("uberAmount").value = "";
    clearPhotoPicker("uber");
    renderUberWeekSelector();
    const remaining = pendingUberWeeks().length;
    $("uberStatus").textContent = remaining
      ? `Comprobante de ${week.label} guardado. Quedan ${remaining} ${remaining === 1 ? "semana pendiente" : "semanas pendientes"}.`
      : `Comprobante de ${week.label} guardado. Ya no quedan semanas pendientes.`;
    $("uberStatus").className = "status success";
    if (!remaining) closeModalAndGoTop("uberModal", 1300);
  } catch (err) {
    console.error(err);
    $("uberStatus").textContent = err?.code === "permission-denied"
      ? "Esa semana ya fue registrada o no tenés permiso para volver a cargarla."
      : "No se pudo registrar el comprobante de Uber.";
    $("uberStatus").className = "status error";
  } finally {
    $("saveUberBtn").disabled = pendingUberWeeks().length === 0;
    $("saveUberBtn").textContent = "Registrar Uber";
  }
});

function resetDriverClose() {
  selectedCloseDirection = "";
  $("driverCloseForm").reset();
  $("driverCloseForm").classList.add("hidden");
  $("driverCloseAmountField").classList.add("hidden");
  $("driverCloseProofField").classList.add("hidden");
  $("exploraTransferData")?.classList.add("hidden");
  $("driverCollectBankFields")?.classList.add("hidden");
  $("adminProofNotice").classList.add("hidden");
  $("driverCloseProof").required = false;
  $("closeStatus").textContent = "";
  $("closeStatus").className = "status";
  document.querySelectorAll(".close-choice").forEach(button => button.classList.remove("selected"));
}

function prepareDriverClose() {
  resetDriverClose();
  const model = settlementModel();
  const payButton = $("choosePayExplora");
  const collectButton = $("chooseCollectExplora");

  if (model.from === "balanced") {
    $("closeBalanceMessage").innerHTML = `<strong>Las cuentas ya están equilibradas.</strong><span>No hay ningún importe pendiente.</span>`;
    payButton.disabled = true;
    collectButton.disabled = true;
    return;
  }

  if (model.from === "cash") {
    $("closeBalanceMessage").innerHTML = `<strong>Debe pagar a Explora ${money(model.amount)}.</strong><span>Ese es el total necesario para que ambos queden equilibrados.</span>`;
    payButton.disabled = false;
    collectButton.disabled = true;
    payButton.classList.add("required-action");
    collectButton.classList.remove("required-action");
  } else {
    $("closeBalanceMessage").innerHTML = `<strong>Debe cobrar a Explora ${money(model.amount)}.</strong><span>Ese es el total necesario para que ambos queden equilibrados.</span>`;
    payButton.disabled = true;
    collectButton.disabled = false;
    collectButton.classList.add("required-action");
    payButton.classList.remove("required-action");
  }
}

function selectDriverClose(direction) {
  const model = settlementModel();
  const expected = model.from === "cash" ? "driver_to_explora" : model.from === "digital" ? "explora_to_driver" : "";
  if (!expected || direction !== expected) return;

  selectedCloseDirection = direction;
  $("driverCloseForm").reset();
  $("driverCloseForm").classList.remove("hidden");
  $("closeStatus").textContent = "";
  $("closeStatus").className = "status";
  document.querySelectorAll(".close-choice").forEach(button => button.classList.remove("selected"));

  if (direction === "driver_to_explora") {
    $("choosePayExplora").classList.add("selected");
    $("driverCloseSelected").innerHTML = `<small>Pagar a Explora</small><strong>${money(model.amount)} pendientes</strong><span>Transferí a los datos de Explora y adjuntá el comprobante. Admin debe confirmar el pago.</span>`;
    setMoneyInput("driverCloseAmount", model.amount);
    $("driverCloseLimit").textContent = `Máximo disponible: ${money(model.amount)}.`;
    $("driverCloseAmountField").classList.remove("hidden");
    $("driverCloseProofField").classList.remove("hidden");
    $("driverCloseProof").required = true;
    $("exploraTransferData").classList.remove("hidden");
    $("driverCollectBankFields").classList.add("hidden");
    $("driverCollectAlias").required = false;
    $("driverCollectCuit").required = false;
    $("adminProofNotice").classList.add("hidden");
    $("confirmClose").textContent = "Enviar pago para aprobación";
  } else {
    $("chooseCollectExplora").classList.add("selected");
    $("driverCloseSelected").innerHTML = `<small>Cobrar a Explora</small><strong>${money(model.amount)} pendientes</strong><span>Indicá el alias y CUIT donde querés recibir el dinero.</span>`;
    $("driverCloseAmountField").classList.add("hidden");
    $("driverCloseProofField").classList.add("hidden");
    $("driverCloseProof").required = false;
    $("exploraTransferData").classList.add("hidden");
    $("driverCollectBankFields").classList.remove("hidden");
    $("driverCollectAlias").required = true;
    $("driverCollectCuit").required = true;
    $("adminProofNotice").classList.remove("hidden");
    $("confirmClose").textContent = "Solicitar cobro";
  }
}

function openAdminPayment(closureId) {
  const item = closures.find(closure => closure.id === closureId);
  if (!item) return;
  const remaining = closureRemaining(item);
  if (remaining <= 0) return;

  selectedAdminClosureId = closureId;
  $("adminClosureId").value = closureId;
  $("adminPaymentForm").reset();
  setMoneyInput("adminPaymentAmount", remaining);
  $("adminPaymentLimit").textContent = `Saldo máximo: ${money(remaining)}.`;
  $("adminPaymentSummary").innerHTML = `<small>Explora paga a</small><strong>${escapeHtml(item.operatorName || "Chofer")} · ${money(remaining)}</strong><span>Alias: ${escapeHtml(item.recipientAlias || "No informado")} · CUIT: ${escapeHtml(formatCuit(item.recipientCuit || ""))}</span>`;
  $("adminPaymentStatus").textContent = "";
  $("adminPaymentStatus").className = "status";
  $("adminClosureList").classList.add("hidden");
  $("adminPaymentForm").classList.remove("hidden");
}

$("closeDayBtn")?.addEventListener("click", () => {
  render();
  $("closeModal").classList.remove("hidden");
  if (isAdminProfile()) {
    $("closeModalTitle").textContent = "Gestionar cierres";
    $("closeDriverView").classList.add("hidden");
    $("closeAdminView").classList.remove("hidden");
    $("adminPaymentForm").classList.add("hidden");
    $("adminClosureList").classList.remove("hidden");
    selectedAdminClosureId = "";
    renderAdminClosures();
  } else {
    $("closeModalTitle").textContent = "Pedir cierre";
    $("closeAdminView").classList.add("hidden");
    $("closeDriverView").classList.remove("hidden");
    prepareDriverClose();
  }
});

$("choosePayExplora")?.addEventListener("click", () => selectDriverClose("driver_to_explora"));
$("chooseCollectExplora")?.addEventListener("click", () => selectDriverClose("explora_to_driver"));
$("driverUseFullAmount")?.addEventListener("click", () => {
  const model = settlementModel();
  setMoneyInput("driverCloseAmount", model.amount);
});

$("driverCloseForm")?.addEventListener("submit", async event => {
  event.preventDefault();
  const user = auth.currentUser;
  if (!user || !selectedCloseDirection || isAdminProfile()) return;

  const model = settlementModel();
  const expected = model.from === "cash" ? "driver_to_explora" : model.from === "digital" ? "explora_to_driver" : "";
  if (expected !== selectedCloseDirection) {
    $("closeStatus").textContent = "El saldo cambió. Volvé a abrir el cierre para recalcularlo.";
    $("closeStatus").className = "status error";
    return;
  }

  const isDriverPayment = selectedCloseDirection === "driver_to_explora";
  const amount = isDriverPayment ? parseMoneyInput($("driverCloseAmount").value) : model.amount;
  const file = $("driverCloseProof").files?.[0];
  const recipientAlias = !isDriverPayment ? String($("driverCollectAlias")?.value || "").trim() : "";
  const recipientCuitDigits = !isDriverPayment ? String($("driverCollectCuit")?.value || "").replace(/\D/g, "") : "";
  if (!amount || amount <= 0 || amount > model.amount + 0.5) {
    $("closeStatus").textContent = `Ingresá un importe entre $1 y ${money(model.amount)}.`;
    $("closeStatus").className = "status error";
    return;
  }
  if (isDriverPayment && !file) {
    $("closeStatus").textContent = "Adjuntá el comprobante del pago a Explora.";
    $("closeStatus").className = "status error";
    return;
  }
  if (!isDriverPayment && recipientAlias.length < 3) {
    $("closeStatus").textContent = "Ingresá el alias donde querés recibir el dinero.";
    $("closeStatus").className = "status error";
    return;
  }
  if (!isDriverPayment && recipientCuitDigits.length !== 11) {
    $("closeStatus").textContent = "Ingresá un CUIT válido de 11 dígitos.";
    $("closeStatus").className = "status error";
    return;
  }
  const alreadyPendingAnyClosure = closures.some(item =>
    item.operatorUid === user.uid && /awaiting_admin|pending_admin/.test(String(item.status || "").toLowerCase())
  );
  if (alreadyPendingAnyClosure) {
    $("closeStatus").textContent = "Ya tenés un cierre pendiente de resolución por Admin.";
    $("closeStatus").className = "status error";
    return;
  }
  if (!isDriverPayment) {
    const alreadyPending = closures.some(item =>
      item.operatorUid === user.uid && item.direction === "explora_pays_driver" && closureRemaining(item) > 0 && item.status !== "completed"
    );
    if (alreadyPending) {
      $("closeStatus").textContent = "Ya tenés un cobro pendiente de Explora.";
      $("closeStatus").className = "status error";
      return;
    }
  }

  $("confirmClose").disabled = true;
  $("confirmClose").textContent = isDriverPayment ? "Guardando pago…" : "Enviando pedido…";
  try {
    const closureRef = doc(collection(db, ROOT_COLLECTIONS.closures));
    let proofUrl = "";
    let proofPath = "";
    const remainingAmount = Math.max(0, model.amount - amount);

    if (isDriverPayment) {
      const cleanName = file.name.replace(/[^a-zA-Z0-9._-]/g,"_");
      proofPath = `cierres_semanales/${currentWeeklyPeriodId()}/${user.uid}/${closureRef.id}_${Date.now()}_${cleanName}`;
      const storageRef = ref(storage, proofPath);
      await uploadBytes(storageRef, file);
      proofUrl = await getDownloadURL(storageRef);
      const closureNowMs = Date.now();
      await setDoc(closureRef, {
        direction: "driver_pays_explora",
        paymentDirection: "driver_to_explora",
        requestedAmount: model.amount,
        settlementAmount: model.amount,
        requestedPaymentAmount: amount,
        paidAmountTotal: 0,
        remainingAmount: model.amount,
        amountDueFromDriver: model.amount,
        amountFromDriver: model.amount,
        amountDueToDriver: 0,
        amountToDriver: 0,
        gross: model.grand, grossAmount: model.grand, expenseTotal: model.expense, cashboxTotal: model.cashBox,
        proofUrl, proofPath, receiptUrl: proofUrl, receiptPath: proofPath,
        proofUploadedByUid: user.uid, proofUploadedByRole: "driver",
        transferAlias: EXPLORA_TRANSFER_ALIAS,
        transferCuit: EXPLORA_CUIT,
        status: "awaiting_admin_review",
        reviewStatus: "pending",
        dayKey: localDayKey(), weeklyPeriodId: currentWeeklyPeriodId(),
        closureKind: "facturacion", closureType: "facturacion", moduleKey: "facturacion", payTab: "facturacion", billingClosure: true,
        closureMode: "settlement_only", autoClosesCashbox: false, cashboxClosedWithBilling: false, affectsTabs: ["chofer", "explora"],
        cashTotal: model.cash, uberTotal: model.uber, debtTotal: model.adminDebt + model.advanceDebt, advanceDebtTotal: model.advanceDebt,
        cashBox5: model.cashBox, digitalTotal: model.digital, expensesTotal: model.expense, total: model.grand,
        driverUid: user.uid, choferUid: user.uid, uid: user.uid, driverName: currentDriverName(),
        operatorUid: user.uid, operatorName: currentProfile?.displayName || currentProfile?.username || "",
        requestedByUid: user.uid, requestedByRole: "driver", createdByUid: user.uid, createdByRole: "driver", businessId: BUSINESS_ID,
        cutoffAtMs: closureNowMs, requestedAtMs: closureNowMs, createdAtMs: closureNowMs, requestedAt: serverTimestamp(), createdAt: serverTimestamp()
      });
      $("closeStatus").textContent = "Pago enviado a Admin. Quedará aplicado cuando sea aprobado.";
    } else {
      const closureNowMs = Date.now();
      await setDoc(closureRef, {
        direction: "explora_pays_driver",
        paymentDirection: "explora_to_driver",
        requestedAmount: model.amount,
        settlementAmount: model.amount,
        paidAmountTotal: 0,
        remainingAmount: model.amount,
        amountDueFromDriver: 0,
        amountFromDriver: 0,
        amountDueToDriver: model.amount,
        amountToDriver: model.amount,
        gross: model.grand,
        grossAmount: model.grand,
        expenseTotal: model.expense,
        cashboxTotal: model.cashBox,
        status: "awaiting_admin_payment",
        reviewStatus: "pending",
        recipientAlias,
        recipientCuit: recipientCuitDigits,
        dayKey: localDayKey(),
        weeklyPeriodId: currentWeeklyPeriodId(),
        closureKind: "facturacion",
        closureType: "facturacion",
        moduleKey: "facturacion",
        payTab: "facturacion",
        billingClosure: true,
        closureMode: "settlement_only",
        autoClosesCashbox: false,
        cashboxClosedWithBilling: false,
        affectsTabs: ["chofer", "explora"],
        cashTotal: model.cash,
        uberTotal: model.uber,
        debtTotal: model.adminDebt + model.advanceDebt,
        advanceDebtTotal: model.advanceDebt,
        cashBox5: model.cashBox,
        digitalTotal: model.digital,
        expensesTotal: model.expense,
        total: model.grand,
        driverUid: user.uid,
        choferUid: user.uid,
        uid: user.uid,
        driverName: currentDriverName(),
        operatorUid: user.uid,
        operatorName: currentProfile?.displayName || currentProfile?.username || "",
        requestedByUid: user.uid,
        requestedByRole: "driver",
        createdByUid: user.uid,
        createdByRole: "driver",
        businessId: BUSINESS_ID,
        cutoffAtMs: closureNowMs,
        requestedAtMs: closureNowMs,
        createdAtMs: closureNowMs,
        requestedAt: serverTimestamp(),
        createdAt: serverTimestamp()
      });
      $("closeStatus").textContent = "Cobro solicitado. Falta el pago y comprobante del administrador.";
    }
    $("closeStatus").className = "status success";
    setTimeout(() => $("closeModal").classList.add("hidden"), 1500);
  } catch (err) {
    console.error(err);
    $("closeStatus").textContent = "No se pudo registrar el cierre.";
    $("closeStatus").className = "status error";
  } finally {
    $("confirmClose").disabled = false;
    $("confirmClose").textContent = isDriverPayment ? "Enviar pago para aprobación" : "Solicitar cobro";
  }
});

$("adminUseFullAmount")?.addEventListener("click", () => {
  const item = closures.find(closure => closure.id === selectedAdminClosureId);
  if (item) setMoneyInput("adminPaymentAmount", closureRemaining(item));
});

$("cancelAdminPayment")?.addEventListener("click", () => {
  selectedAdminClosureId = "";
  $("adminPaymentForm").classList.add("hidden");
  $("adminClosureList").classList.remove("hidden");
  renderAdminClosures();
});

$("adminPaymentForm")?.addEventListener("submit", async event => {
  event.preventDefault();
  const admin = auth.currentUser;
  if (!admin || !isAdminProfile() || !selectedAdminClosureId) return;
  const item = closures.find(closure => closure.id === selectedAdminClosureId);
  if (!item) return;

  const remaining = closureRemaining(item);
  const amount = parseMoneyInput($("adminPaymentAmount").value);
  const file = $("adminCloseProof").files?.[0];
  if (!amount || amount <= 0 || amount > remaining + 0.5) {
    $("adminPaymentStatus").textContent = `Ingresá un importe entre $1 y ${money(remaining)}.`;
    $("adminPaymentStatus").className = "status error";
    return;
  }
  if (!file) {
    $("adminPaymentStatus").textContent = "Adjuntá el comprobante del pago de Explora.";
    $("adminPaymentStatus").className = "status error";
    return;
  }

  $("confirmAdminPayment").disabled = true;
  $("confirmAdminPayment").textContent = "Guardando pago…";
  try {
    const cleanName = file.name.replace(/[^a-zA-Z0-9._-]/g,"_");
    const proofPath = `cierres_semanales/${currentWeeklyPeriodId()}/${item.operatorUid}/admin_${item.id}_${Date.now()}_${cleanName}`;
    const storageRef = ref(storage, proofPath);
    await uploadBytes(storageRef, file);
    const proofUrl = await getDownloadURL(storageRef);

    const paymentRef = doc(collection(db, ROOT_COLLECTIONS.payments));
    const closureRef = doc(db, ROOT_COLLECTIONS.closures, item.id);
    const newPaidTotal = Number(item.paidAmountTotal || 0) + amount;
    const newRemaining = Math.max(0, remaining - amount);
    const batch = writeBatch(db);
    batch.set(paymentRef, {
      // Ajuste interno: la UI lo muestra del lado efectivo del chofer, pero no debe
      // sumarse otra vez a la facturación histórica ni disparar un Telegram de cobro.
      method: "cash",
      paymentMethod: "internal_admin_payment",
      metodoPago: "internal_admin_payment",
      financialCategory: "internal_admin_payment",
      type: "settlement_adjustment",
      operationType: "settlement_adjustment",
      adjustmentDirection: "explora_to_driver",
      internalSettlementAdjustment: true,
      excludeFromBillingSettlement: true,
      suppressTelegram: true,
      amount,
      monto: amount,
      service: "Ajuste de Explora",
      notes: newRemaining <= 0.5 ? "Pago total de Explora" : "Pago parcial de Explora",
      detail: newRemaining <= 0.5 ? "Pago total de Explora" : "Pago parcial de Explora",
      proofUrl,
      proofPath,
      receiptUrl: proofUrl,
      receiptPath: proofPath,
      closureId: item.id,
      dayKey: localDayKey(),
      weeklyPeriodId: currentWeeklyPeriodId(),
      driverUid: item.operatorUid,
      choferUid: item.operatorUid,
      uid: item.operatorUid,
      ownerUid: item.operatorUid,
      driverId: item.operatorUid,
      driverName: item.operatorName || "Chofer",
      operatorUid: item.operatorUid,
      operatorName: item.operatorName || "",
      createdByUid: admin.uid,
      createdByRole: "admin",
      createdByName: currentProfile?.displayName || currentProfile?.username || "Administrador",
      businessId: BUSINESS_ID,
      createdAtMs: Date.now(),
      createdAt: serverTimestamp()
    });
    batch.update(closureRef, {
      paidAmountTotal: newPaidTotal,
      remainingAmount: newRemaining,
      amountDueToDriver: newRemaining,
      amountToDriver: newRemaining,
      amountDueFromDriver: 0,
      amountFromDriver: 0,
      lastProofUrl: proofUrl,
      lastProofPath: proofPath,
      proofUrl,
      proofPath,
      receiptUrl: proofUrl,
      receiptPath: proofPath,
      proofUploadedByUid: admin.uid,
      proofUploadedByRole: "admin",
      status: newRemaining <= 0.5 ? "completed" : "partially_paid",
      reviewStatus: newRemaining <= 0.5 ? "completed" : "approved_partial",
      actionedByAdminUid: admin.uid,
      actionedByAdminName: currentProfile?.displayName || currentProfile?.username || "Administrador",
      updatedAtMs: Date.now(),
      lastPaymentAt: serverTimestamp(),
      completedAt: newRemaining <= 0.5 ? serverTimestamp() : null
    });
    await batch.commit();

    $("adminPaymentStatus").textContent = newRemaining <= 0.5
      ? "Pago registrado. El cierre quedó equilibrado."
      : `Pago parcial registrado. Quedan ${money(newRemaining)} pendientes.`;
    $("adminPaymentStatus").className = "status success";
    setTimeout(() => {
      adminDismissedPendingActionIds.add(`closure:${item.id}`);
      adminPendingAction = null;
      selectedAdminClosureId = "";
      $("adminPaymentForm").classList.add("hidden");
      $("adminClosureList").classList.remove("hidden");
      renderAdminClosures();
    }, 1300);
  } catch (err) {
    console.error(err);
    $("adminPaymentStatus").textContent = "No se pudo registrar el pago de Explora.";
    $("adminPaymentStatus").className = "status error";
  } finally {
    $("confirmAdminPayment").disabled = false;
    $("confirmAdminPayment").textContent = "Registrar pago";
  }
});

// Si Admin cerró un pedido sin resolverlo y la PWA vuelve desde segundo plano,
// se vuelve a habilitar el aviso automático. Así el pedido no queda olvidado.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    adminDismissedPendingActionIds.clear();
    return;
  }
  if (isAdminProfile()) setTimeout(maybeShowAdminPendingAction, 120);
});
window.addEventListener("pageshow", () => {
  if (isAdminProfile()) setTimeout(maybeShowAdminPendingAction, 120);
});
