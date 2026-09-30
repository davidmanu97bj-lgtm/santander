/** Salió vs cobro por número remis (sin adjudicación). */
export const REMIS_NUMBERS = Object.freeze([28, 57, 104, 31, 43, 154, 15, 134]);
export const OPS_EXITS_COLLECTION = "ops_number_exits";

export function exitDocId(dayKey, remisNumber, eventId = crypto.randomUUID()) {
  return `${dayKey}_${Number(remisNumber)}_${eventId}`;
}

export function opsDayKey(ms = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires', year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(new Date(ms));
  const value = type => parts.find(p => p.type === type).value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

export function newExit(remisNumber, now = Date.now()) {
  const dayKey = opsDayKey(now);
  return { id: exitDocId(dayKey, remisNumber), dayKey, remisNumber: Number(remisNumber), markedAtMs: now };
}

export function opsDateTimeInput(ms) {
  const parts = new Intl.DateTimeFormat('en-CA', {timeZone:'America/Argentina/Buenos_Aires',
    year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(ms));
  const value = type => parts.find(p => p.type === type).value;
  return `${value('year')}-${value('month')}-${value('day')}T${value('hour')}:${value('minute')}:${value('second')}`;
}

export function parseOpsDateTime(value, now = Date.now()) {
  if (!value) return now;
  if (!/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) throw new Error('Indicá una fecha y hora de salida válida.');
  const normalized = value.length === 16 ? value + ':00' : value;
  // Iguazú uses UTC-3 throughout the supported period, independent of the browser's timezone.
  const stamp = Date.parse(normalized + '-03:00');
  if (!Number.isFinite(stamp) || opsDateTimeInput(stamp) !== normalized) throw new Error('Indicá una fecha y hora de salida válida.');
  if (stamp > now) throw new Error('La salida no puede tener una fecha u hora futura.');
  return stamp;
}

export function formatOpsDate(ms) {
  if (!(Number(ms) > 0)) return 'Sin fecha registrada';
  return new Intl.DateTimeFormat('es-AR', { timeZone:'America/Argentina/Buenos_Aires', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false }).format(new Date(Number(ms)));
}

export function paymentTime(row) {
  return Number(row.createdAtMs || row.createdAt?.toMillis?.() || 0);
}

export function isOpsPayment(row) {
  const status = String(row.status || row.estado || row.state || row.deletionStatus || '').toLowerCase();
  return Boolean(row.id) && Number(row.remisNumber) > 0 && paymentTime(row) > 0
    && !row.viajePrivado && !row.isPrivateTrip && !row.deleted && !row.isDeleted && !row.eliminado
    && !row.isSimulated && !row.createdBySimulation && !row.adjustmentDirection && !row.affectsBillingSettlement
    && !/deleted|eliminado|borrado|anulado|cancel|void|reject/.test(status)
    && (!row.type || ['billing', 'payment'].includes(row.type));
}

export function paymentFitsExit(payment, exit) {
  return isOpsPayment(payment) && exit.active !== false && Number(exit.markedAtMs) > 0
    && Number(payment.remisNumber) === Number(exit.remisNumber)
    && paymentTime(payment) >= Number(exit.markedAtMs);
}

export function formatClock(ms, timeZone = "America/Argentina/Buenos_Aires") {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return "—";
  return new Intl.DateTimeFormat("es-AR", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(value));
}

export function chargesByRemisToday(payments, dayKey) {
  const map = new Map();
  for (const row of payments || []) {
    if (String(row.dayKey || "") !== String(dayKey)) continue;
    if (row.viajePrivado === true || row.isPrivateTrip === true) continue;
    const n = Number(row.remisNumber);
    if (!Number.isFinite(n) || n <= 0) continue;
    const at = Number(row.createdAtMs || row.createdAt?.toMillis?.() || 0);
    const prev = map.get(n);
    if (!prev || at < prev.atMs) map.set(n, { atMs: at, paymentId: row.id || null });
  }
  return map;
}

export function buildOpsBoard({ numbers = REMIS_NUMBERS, exits = [], payments = [], dayKey }) {
  // Reserve historical links too: a payment must never be recycled at midnight.
  const used = new Set(exits.filter(e => e.paymentId).map(e => e.paymentId));
  const byId = new Map(payments.map(p => [p.id, p]));
  const available = [...byId.values()].filter(p => isOpsPayment(p) && !used.has(p.id))
    .sort((a,b) => paymentTime(a)-paymentTime(b) || a.id.localeCompare(b.id));
  const active = exits.filter(e => e.active !== false);
  const pending = active.filter(e => !e.paymentId);
  const automaticLinks = [];
  const rows = active.filter(e => !e.paymentId || e.dayKey === dayKey || (e.linkedAtMs && opsDayKey(e.linkedAtMs) === dayKey))
    .sort((a,b) => Number(a.markedAtMs)-Number(b.markedAtMs) || a.id.localeCompare(b.id))
    .map(exit => {
      const payment = byId.get(exit.paymentId);
      const candidates = exit.paymentId ? [] : available.filter(p => paymentFitsExit(p, exit));
      // Ambiguous histories require an explicit choice, not an arbitrary FIFO guess.
      if (candidates.length === 1 && pending.filter(e => paymentFitsExit(candidates[0], e)).length === 1) {
        automaticLinks.push({exitId:exit.id, paymentId:candidates[0].id});
      }
      return { ...exit, candidates, status:exit.paymentId ? 'matched' : 'missing_charge',
        markedLabel:formatOpsDate(exit.markedAtMs),
        chargeLabel:exit.paymentId ? (isOpsPayment(payment || {}) ? 'Vinculado' : 'Revisar cobro') : 'Pendiente',
        chargeAtLabel:exit.paymentId ? formatOpsDate(payment ? paymentTime(payment) : exit.paymentAtMs) : '—' };
    });
  return { rows, automaticLinks, summary: {
    exited:active.filter(e => e.dayKey === dayKey).length,
    withoutCharge:pending.length,
    free:numbers.filter(n => !pending.some(e => Number(e.remisNumber) === n)).length
  }};
}

export function readChargeRemisSelection(root = document) {
  const privateBtn = root.querySelector("[data-charge-private]");
  if (privateBtn?.getAttribute("aria-pressed") === "true") {
    return { remisNumber: null, viajePrivado: true };
  }
  const selected = root.querySelector("[data-charge-remis][aria-pressed='true']");
  const n = Number(selected?.dataset.chargeRemis);
  if (Number.isFinite(n) && n > 0) return { remisNumber: n, viajePrivado: false };
  return { remisNumber: null, viajePrivado: false };
}

export function renderChargeRemisStep(container, { numbers = REMIS_NUMBERS, selection = null } = {}) {
  if (!container) return;
  const selectedNumber = selection?.viajePrivado ? null : Number(selection?.remisNumber) || null;
  const privateOn = selection?.viajePrivado === true;
  container.innerHTML = `
    <div class="charge-panel charge-remis-panel">
      <h3>Número remis</h3>
      <p class="charge-remis-hint">Elegí el número del viaje. No usa adjudicación.</p>
      <div class="av-numbers charge-remis-numbers" role="group" aria-label="Selector de número remis">
        ${numbers.map(n => `<button type="button" data-charge-remis="${n}" aria-pressed="${selectedNumber === n ? "true" : "false"}">${n}</button>`).join("")}
      </div>
      <div class="charge-remis-or"><span>o</span></div>
      <button type="button" class="charge-private-btn" data-charge-private aria-pressed="${privateOn ? "true" : "false"}">ES UN VIAJE PRIVADO</button>
      <p class="charge-remis-hint">Viaje privado: Ops no cruza por número.</p>
    </div>`;
  container.querySelectorAll("[data-charge-remis]").forEach(btn => {
    btn.addEventListener("click", () => {
      container.querySelectorAll("[data-charge-remis]").forEach(b => b.setAttribute("aria-pressed", "false"));
      container.querySelector("[data-charge-private]")?.setAttribute("aria-pressed", "false");
      btn.setAttribute("aria-pressed", "true");
    });
  });
  container.querySelector("[data-charge-private]")?.addEventListener("click", () => {
    container.querySelectorAll("[data-charge-remis]").forEach(b => b.setAttribute("aria-pressed", "false"));
    container.querySelector("[data-charge-private]")?.setAttribute("aria-pressed", "true");
  });
}

export function mountOpsSalidasBoard(host, {
  numbers = REMIS_NUMBERS,
  getDayKey,
  getPayments,
  paymentsReady = () => true,
  listenExits,
  markExit,
  linkPayment,
  now = Date.now,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval
}) {
  if (!host) return { start() {}, stop() {}, refresh() {} };
  host.innerHTML = `
    <section class="ops-salidas-panel" aria-label="Panel Operaciones salidas">
      <header class="ops-salidas-head">
        <div>
          <h2>Salidas de hoy</h2>
          <p>Las pendientes siguen aquí hasta vincular su cobro, aunque cambie el día.</p>
        </div>
        <span class="ops-salidas-live">En vivo</span>
      </header>
      <div class="ops-salidas-marcar">
        <p class="ops-salidas-title">Nueva salida · indicá cuándo salió y elegí el número</p>
        <div class="ops-salidas-date">
          <label>Fecha y hora real de la salida (Argentina)
            <input type="datetime-local" step="1" data-ops-departed-at aria-describedby="opsSalidaDateHelp">
          </label>
          <button type="button" data-ops-now>Usar hora actual</button>
        </div>
        <p class="ops-salidas-date-help" id="opsSalidaDateHelp">Para una salida anterior, cargá su fecha y hora real. Si lo dejás vacío, se usa el momento actual. Cada toque en un número registra una salida distinta.</p>
        <div class="ops-salidas-chips" role="group" aria-label="Marcar salida por número"></div>
      </div>
      <div class="ops-salidas-summary" aria-live="polite"></div>
      <div class="ops-salidas-table-wrap">
        <table class="ops-salidas-table">
          <thead>
            <tr>
              <th>Número</th>
              <th>Fecha y hora de salida</th>
              <th>Cobro</th>
              <th>Cobro cargado</th>
              <th>Acción</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>
      <p class="ops-salidas-status" role="status"></p>
    </section>`;

  const chips = host.querySelector(".ops-salidas-chips");
  const summary = host.querySelector(".ops-salidas-summary");
  const tbody = host.querySelector("tbody");
  const statusEl = host.querySelector(".ops-salidas-status");
  const dateInput = host.querySelector('[data-ops-departed-at]');
  const nowButton = host.querySelector('[data-ops-now]');
  let exits = [];
  let stopListen = null;
  let busy = false;
  let running = false;
  let exitsReady = false;
  let timer = null;
  let generation = 0;
  let pendingDraft = null;
  const selections = new Map();
  const attempted = new Set();
  const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));

  async function link(pair) {
    const epoch = generation;
    busy = true;
    statusEl.textContent = 'Vinculando cobro…';
    paint();
    try {
      await linkPayment(pair);
      if (epoch === generation) statusEl.textContent = 'Cobro vinculado a una sola salida.';
    } catch (error) {
      if (epoch === generation) statusEl.textContent = error?.message || 'No se pudo vincular el cobro.';
    } finally {
      if (epoch === generation) { busy = false; if (running) paint(); }
    }
  }

  function paint() {
    const dayKey = getDayKey();
    const board = buildOpsBoard({ numbers, exits, payments: getPayments(), dayKey });
    dateInput.max = opsDateTimeInput(now());
    dateInput.disabled = busy || Boolean(pendingDraft);
    nowButton.disabled = dateInput.disabled;
    chips.innerHTML = numbers.map(n => {
      const out = board.rows.some(r => Number(r.remisNumber) === n && r.status === 'missing_charge');
      return `<button type="button" class="ops-salidas-chip${out ? " out" : ""}" data-ops-number="${n}" aria-label="Registrar nueva salida del ${n}" ${busy || !exitsReady ? 'disabled' : ''}>${n} +</button>`;
    }).join("");
    summary.innerHTML = `
      <span>Salidas hoy<b>${board.summary.exited}</b></span>
      <span>Pendientes de todos los días<b>${board.summary.withoutCharge}</b></span>
      <span>Números sin pendientes<b>${board.summary.free}</b></span>`;
    tbody.innerHTML = board.rows.map((row, index) => `
      <tr>
        <td><span class="ops-salidas-num">${Number(row.remisNumber)}</span></td>
        <td>${row.markedLabel}</td>
        <td><span class="ops-salidas-badge ${row.status === "matched" ? "yes" : row.status === "missing_charge" ? "no" : "libre"}">${row.chargeLabel}</span></td>
        <td>${row.chargeAtLabel}</td>
        <td>${row.status === 'matched' ? '<span class="ops-salidas-action ok">Vinculado</span>' : row.candidates.length ? `
          <select data-ops-select="${index}" aria-label="Cobro para salida ${Number(row.remisNumber)} del ${escape(row.markedLabel)}" ${busy || !paymentsReady() ? 'disabled' : ''}>
            <option value="">Elegir cobro…</option>
            ${row.candidates.map(p => `<option value="${escape(p.id)}" ${selections.get(row.id) === p.id ? 'selected' : ''}>${escape(formatOpsDate(paymentTime(p)))} · ${escape(p.operatorName || p.driverName || '')} · $${Number(p.amount || p.monto || 0).toLocaleString('es-AR')} · ${escape(p.id.slice(-6))}</option>`).join('')}
          </select><button type="button" data-ops-link="${index}" ${busy || !paymentsReady() ? 'disabled' : ''}>Vincular cobro</button>` : '<span class="ops-salidas-action">Esperando cobro</span>'}</td>
      </tr>`).join("") || '<tr><td colspan="5">No hay salidas de hoy ni pendientes anteriores.</td></tr>';
    // Do not guess among several possible departures/payments. Unique cases retain
    // the automatic workflow, but only after both complete server snapshots arrive.
    if (running && exitsReady && paymentsReady() && !busy && linkPayment) {
      const pair = board.automaticLinks.find(p => !attempted.has(`${p.exitId}/${p.paymentId}`));
      if (pair) {
        attempted.add(`${pair.exitId}/${pair.paymentId}`);
        void link(pair);
      }
    }
  }

  tbody.addEventListener('change', event => {
    const select = event.target.closest('[data-ops-select]');
    if (!select) return;
    const board = buildOpsBoard({numbers, exits, payments:getPayments(), dayKey:getDayKey()});
    const row = board.rows[Number(select.dataset.opsSelect)];
    if (row) selections.set(row.id, select.value);
  });
  tbody.addEventListener('click', event => {
    const button = event.target.closest('[data-ops-link]');
    if (!button || busy || !exitsReady || !paymentsReady()) return;
    const board = buildOpsBoard({numbers, exits, payments:getPayments(), dayKey:getDayKey()});
    const row = board.rows[Number(button.dataset.opsLink)];
    const paymentId = row && selections.get(row.id);
    if (!row?.candidates.some(p => p.id === paymentId)) { statusEl.textContent = 'Elegí el cobro que corresponde a esta salida.'; return; }
    attempted.add(`${row.id}/${paymentId}`);
    void link({exitId:row.id, paymentId});
  });

  chips.addEventListener("click", async event => {
    const btn = event.target.closest("[data-ops-number]");
    if (!btn || busy || !exitsReady) return;
    const remisNumber = Number(btn.dataset.opsNumber);
    if (pendingDraft && pendingDraft.remisNumber !== remisNumber) {
      statusEl.textContent = `Reintentá primero la salida del ${pendingDraft.remisNumber}.`;
      return;
    }
    const epoch = generation;
    try {
      pendingDraft ||= newExit(remisNumber, parseOpsDateTime(dateInput.value, now()));
    } catch (error) {
      statusEl.textContent = error.message;
      return;
    }
    busy = true;
    statusEl.textContent = "Registrando salida…";
    paint();
    try {
      await markExit(pendingDraft);
      if (epoch === generation) {
        pendingDraft = null;
        dateInput.value = '';
        statusEl.textContent = 'Salida registrada con su fecha y hora real.';
      }
    } catch (error) {
      console.error(error);
      if (epoch === generation) statusEl.textContent = error?.message || "No se pudo actualizar la salida.";
    } finally {
      if (epoch === generation) { busy = false; if (running) paint(); }
    }
  });

  nowButton.addEventListener('click', () => {
    if (!busy && !pendingDraft) { dateInput.value = ''; statusEl.textContent = 'La próxima salida usará el momento actual.'; }
  });

  return {
    start() {
      this.stop();
      running = true;
      const epoch = generation;
      stopListen = listenExits((rows, ready = true) => {
        if (!running || epoch !== generation) return;
        exits = rows || [];
        exitsReady = ready;
        paint();
      }, error => {
        if (!running || epoch !== generation) return;
        exitsReady = false;
        console.error(error);
        statusEl.textContent = "Sin conexión al panel de salidas.";
        paint();
      });
      timer = setIntervalFn(() => { if (running) paint(); }, 30000);
      paint();
    },
    stop() {
      generation += 1;
      running = false;
      busy = false;
      pendingDraft = null;
      dateInput.value = '';
      if (typeof stopListen === "function") stopListen();
      stopListen = null;
      if (timer !== null) clearIntervalFn(timer);
      timer = null;
      exits = [];
      exitsReady = false;
      selections.clear();
      attempted.clear();
    },
    refresh: paint
  };
}
