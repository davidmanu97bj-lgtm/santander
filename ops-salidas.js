/** Salió vs cobro por número remis (sin adjudicación). */
export const REMIS_NUMBERS = Object.freeze([28, 57, 104, 31, 43, 154, 15, 134]);
export const OPS_EXITS_COLLECTION = "ops_number_exits";

export function exitDocId(dayKey, remisNumber) {
  return `${dayKey}_${Number(remisNumber)}`;
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
  const exitByNumber = new Map();
  for (const exit of exits || []) {
    if (!exit || exit.active === false) continue;
    if (String(exit.dayKey || "") !== String(dayKey)) continue;
    const n = Number(exit.remisNumber);
    if (!Number.isFinite(n)) continue;
    exitByNumber.set(n, exit);
  }
  const charges = chargesByRemisToday(payments, dayKey);
  let exited = 0;
  let withoutCharge = 0;
  let free = 0;
  const rows = numbers.map(n => {
    const exit = exitByNumber.get(n);
    const charge = charges.get(n);
    if (!exit) {
      free += 1;
      return {
        remisNumber: n,
        status: "free",
        markedAtMs: null,
        markedLabel: "—",
        chargeLabel: "Libre",
        chargeAtLabel: "—",
        action: "Sin salida",
        actionKind: "muted"
      };
    }
    exited += 1;
    if (charge) {
      return {
        remisNumber: n,
        status: "matched",
        markedAtMs: Number(exit.markedAtMs) || null,
        markedLabel: formatClock(exit.markedAtMs),
        chargeLabel: "SÍ",
        chargeAtLabel: formatClock(charge.atMs),
        action: "OK",
        actionKind: "ok"
      };
    }
    withoutCharge += 1;
    return {
      remisNumber: n,
      status: "missing_charge",
      markedAtMs: Number(exit.markedAtMs) || null,
      markedLabel: formatClock(exit.markedAtMs),
      chargeLabel: "NO",
      chargeAtLabel: "—",
      action: "Avisar Telegram",
      actionKind: "warn"
    };
  });
  return { rows, summary: { exited, withoutCharge, free } };
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
  listenExits,
  markExit,
  unmarkExit
}) {
  if (!host) return { start() {}, stop() {}, refresh() {} };
  host.innerHTML = `
    <section class="ops-salidas-panel" aria-label="Panel Operaciones salidas">
      <header class="ops-salidas-head">
        <div>
          <h2>Salidas de hoy</h2>
          <p>Marcar salida · cruzar vs cobro por número</p>
        </div>
        <span class="ops-salidas-live">En vivo</span>
      </header>
      <div class="ops-salidas-marcar">
        <p class="ops-salidas-title">Marcar salida</p>
        <div class="ops-salidas-chips" role="group" aria-label="Marcar salida por número"></div>
      </div>
      <div class="ops-salidas-summary" aria-live="polite"></div>
      <div class="ops-salidas-table-wrap">
        <table class="ops-salidas-table">
          <thead>
            <tr>
              <th>Número</th>
              <th>Marcado a las</th>
              <th>Cobro</th>
              <th>Hora cobro</th>
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
  let exits = [];
  let stopListen = null;
  let busy = false;

  function paint() {
    const dayKey = getDayKey();
    const board = buildOpsBoard({ numbers, exits, payments: getPayments(), dayKey });
    chips.innerHTML = numbers.map(n => {
      const row = board.rows.find(r => r.remisNumber === n);
      const out = row && row.status !== "free";
      return `<button type="button" class="ops-salidas-chip${out ? " out" : ""}" data-ops-number="${n}" aria-pressed="${out ? "true" : "false"}">${n}</button>`;
    }).join("");
    summary.innerHTML = `
      <span>Salieron<b>${board.summary.exited}</b></span>
      <span>Sin cobro<b>${board.summary.withoutCharge}</b></span>
      <span>Libres<b>${board.summary.free}</b></span>`;
    tbody.innerHTML = board.rows.map(row => `
      <tr>
        <td><span class="ops-salidas-num${row.status === "free" ? " free" : ""}">${row.remisNumber}</span></td>
        <td>${row.markedLabel}</td>
        <td><span class="ops-salidas-badge ${row.status === "matched" ? "yes" : row.status === "missing_charge" ? "no" : "libre"}">${row.chargeLabel}</span></td>
        <td>${row.chargeAtLabel}</td>
        <td><span class="ops-salidas-action ${row.actionKind}">${row.action}</span></td>
      </tr>`).join("");
  }

  chips.addEventListener("click", async event => {
    const btn = event.target.closest("[data-ops-number]");
    if (!btn || busy) return;
    const remisNumber = Number(btn.dataset.opsNumber);
    const dayKey = getDayKey();
    const existing = exits.find(e => Number(e.remisNumber) === remisNumber && e.active !== false && String(e.dayKey) === String(dayKey));
    busy = true;
    statusEl.textContent = existing ? "Quitando marca…" : "Marcando salida…";
    try {
      if (existing) await unmarkExit({ dayKey, remisNumber });
      else await markExit({ dayKey, remisNumber });
      statusEl.textContent = "";
    } catch (error) {
      console.error(error);
      statusEl.textContent = error?.message || "No se pudo actualizar la salida.";
    } finally {
      busy = false;
    }
  });

  return {
    start() {
      this.stop();
      stopListen = listenExits(rows => {
        exits = rows || [];
        paint();
      }, error => {
        console.error(error);
        statusEl.textContent = "Sin conexión al panel de salidas.";
      });
      paint();
    },
    stop() {
      if (typeof stopListen === "function") stopListen();
      stopListen = null;
    },
    refresh: paint
  };
}
