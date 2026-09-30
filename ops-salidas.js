/** Salió vs cobro por número remis (sin adjudicación). */
export const REMIS_NUMBERS = Object.freeze([28, 57, 104, 31, 43, 154, 15, 134]);
export const OPS_EXITS_COLLECTION = "ops_number_exits";
export const OPS_DISPOSITIONS = Object.freeze({
  own:'Propio · requiere cobro', internal_cover:'Reemplazo entre choferes de Explora · requiere cobro',
  uber:'Uber / por app · excluido', external_cover:'Cobertura externa · excluido',
  review:'Origen o cobertura por confirmar'
});
export const opsExcluded = exit => ['uber','external_cover'].includes(exit.disposition);
export const normalizeOpsReference = value => String(value || '').normalize('NFC').trim().replace(/\s+/g,' ');

export async function referencedExit({remisNumber, markedAtMs, sourceRef, disposition='own', reviewNote=''}) {
  sourceRef=normalizeOpsReference(sourceRef);
  if (!sourceRef || sourceRef.length>240) throw new Error('Ingresá una referencia del mensaje de WhatsApp (hasta 240 caracteres).');
  if (!Object.hasOwn(OPS_DISPOSITIONS,disposition)) throw new Error('Elegí el tipo de salida.');
  reviewNote=String(reviewNote || '').trim();
  if (reviewNote.length>500 || (['external_cover','review'].includes(disposition) && !reviewNote)) throw new Error('Indicá el aviso de cobertura o el motivo de revisión (hasta 500 caracteres).');
  const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode('Aeropuerto 2026\n'+sourceRef));
  return {id:'wa_'+[...new Uint8Array(hash)].map(n=>n.toString(16).padStart(2,'0')).join(''),
    remisNumber:Number(remisNumber),markedAtMs,dayKey:opsDayKey(markedAtMs),sourceRef,disposition,reviewNote};
}

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
  const internal = [row.type,row.operationType,row.movementType,row.sourceModule,row.category].join(' ').toLowerCase().replace(/\s+/g,'_');
  return Boolean(row.id) && Number(row.remisNumber) > 0 && paymentTime(row) > 0
    && !row.viajePrivado && !row.isPrivateTrip && !row.deleted && !row.isDeleted && !row.eliminado
    && !row.isSimulated && !row.createdBySimulation && !row.adjustmentDirection && !row.affectsBillingSettlement
    && !/deleted|eliminado|borrado|anulado|cancel|void|reject/.test(status)
    && !/driver_payment|settlement|reimbursement|expense|debt|cash_advance|cierre|pago_a_explora/.test(internal)
    && (!row.type || ['billing', 'payment'].includes(row.type));
}

export function paymentFitsExit(payment, exit) {
  return isOpsPayment(payment) && exit.active !== false && !opsExcluded(exit) && exit.disposition !== 'review' && Number(exit.markedAtMs) > 0
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

export function buildOpsBoard({ numbers = REMIS_NUMBERS, exits = [], payments = [], dayKey, now = Date.now(), dataReady = true }) {
  // Reserve historical links too: a payment must never be recycled at midnight.
  const used = new Set(exits.filter(e => e.paymentId).map(e => e.paymentId));
  const byId = new Map(payments.map(p => [p.id, p]));
  const available = [...byId.values()].filter(p => isOpsPayment(p) && !used.has(p.id))
    .sort((a,b) => paymentTime(a)-paymentTime(b) || a.id.localeCompare(b.id));
  const active = exits.filter(e => e.active !== false);
  const pending = active.filter(e => !e.paymentId && !opsExcluded(e) && e.disposition !== 'review');
  const automaticLinks = [];
  const rows = active
    .sort((a,b) => Number(a.markedAtMs)-Number(b.markedAtMs) || a.id.localeCompare(b.id))
    .map(exit => {
      const payment = byId.get(exit.paymentId);
      const candidates = exit.paymentId ? [] : available.filter(p => paymentFitsExit(p, exit));
      // Ambiguous histories require an explicit choice, not an arbitrary FIFO guess.
      const unique = candidates.length === 1 && active.filter(e => !e.paymentId && !opsExcluded(e) && paymentFitsExit(candidates[0], {...e, disposition:'own'})).length === 1;
      if (dataReady && unique) {
        automaticLinks.push({exitId:exit.id, paymentId:candidates[0].id});
      }
      const ageMs=Math.max(0,now-Number(exit.markedAtMs || now));
      const minutes=Math.floor(ageMs/60000), days=Math.floor(minutes/1440);
      const ageLabel=`${days ? days+' d ' : ''}${Math.floor(minutes%1440/60)} h ${minutes%60} min`;
      const status=opsExcluded(exit)?'excluded':!dataReady || exit.disposition==='review' ? 'review'
        :exit.paymentId ? (paymentFitsExit(payment || {},exit)?'matched':'review') : candidates.length?'review':'missing_charge';
      const reason=opsExcluded(exit)?OPS_DISPOSITIONS[exit.disposition]:!dataReady?'Esperando datos completos del servidor'
        :exit.disposition==='review'?'Confirmar origen o cobertura':exit.paymentId && status==='review'?'Revisar cobro vinculado'
        :unique?'Coincidencia única por vincular':candidates.length?'Varios cruces posibles · no reclamar todavía'
        :status==='missing_charge'?'Sin cobro encontrado': 'Cobro vinculado';
      return { ...exit, candidates, status, reason, ageMs, ageLabel, canRemind:status==='missing_charge' && ageMs>=7200000,
        registeredLabel:formatOpsDate(exit.createdAt?.toMillis?.() || (typeof exit.createdAt==='number'?exit.createdAt:0)),
        markedLabel:formatOpsDate(exit.markedAtMs),
        chargeLabel:{matched:'Vinculado',review:'Por revisar',excluded:'Excluido',missing_charge:'Pendiente'}[status],
        chargeAtLabel:exit.paymentId ? formatOpsDate(payment ? paymentTime(payment) : exit.paymentAtMs) : '—' };
    });
  return { rows, automaticLinks, summary: {
    exited:active.filter(e => e.dayKey === dayKey).length,
    withoutCharge:rows.filter(r=>r.status==='missing_charge').length,
    review:rows.filter(r=>r.status==='review').length,
    excluded:rows.filter(r=>r.status==='excluded').length,
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
  numbers=REMIS_NUMBERS,getDayKey,getPayments,paymentsReady=()=>true,listenExits,markExit,linkPayment,reviewExit,
  now=Date.now,setIntervalFn=setInterval,clearIntervalFn=clearInterval
}) {
  if(!host)return {start(){},stop(){},refresh(){}};
  host.innerHTML=`<section class="ops-salidas-panel" aria-label="Panel Operaciones salidas">
    <header class="ops-salidas-head"><div><h2>Salidas de hoy</h2><p>Control del aeropuerto · conserva pendientes de todos los días.</p></div><span class="ops-salidas-live">En vivo</span></header>
    <div class="ops-salidas-marcar"><h3 class="ops-salidas-title">Registrar salida del aeropuerto</h3>
      <div class="ops-salidas-chips" role="group" aria-label="Elegir número remis"></div>
      <div class="ops-salidas-date"><label>Fecha y hora real del mensaje (Argentina)<input type="datetime-local" step="1" data-ops-departed-at required></label><button type="button" data-ops-now>Usar hora actual</button></div>
      <label class="ops-salidas-field">Referencia única del mensaje de WhatsApp<input data-ops-source maxlength="240" autocomplete="off" required aria-describedby="opsReferenceHelp"></label>
      <p class="ops-salidas-date-help" id="opsReferenceHelp">Usá siempre la misma referencia al reintentar, incluso después de recargar. Puede ser el identificador del mensaje o fecha completa + hora + autor + texto. Dos mensajes distintos necesitan referencias distintas, aunque repitan número y hora.</p>
      <label class="ops-salidas-field">Tipo de salida<select data-ops-disposition>${Object.entries(OPS_DISPOSITIONS).map(([v,label])=>`<option value="${v}">${label}</option>`).join('')}</select></label>
      <label class="ops-salidas-field">Aviso de cobertura o motivo de revisión<input data-ops-note maxlength="500" placeholder="Obligatorio para cobertura externa o caso por confirmar"></label>
      <button type="button" class="ops-primary" data-ops-register>Registrar salida</button>
      <p class="ops-salidas-date-help">Cargá primero todas las salidas de esta revisión; después compará los cobros. No marques taxis, viajes vacíos, X por ausencia ni subidas con pasajeros como salidas cobrables del aeropuerto.</p>
    </div>
    <div class="ops-salidas-summary" aria-live="polite"></div>
    <div class="ops-salidas-toolbar"><label>Mostrar<select data-ops-filter><option value="all">Todas las salidas</option><option value="missing_charge">Pendientes sin cobro encontrado</option><option value="review">Por revisar</option><option value="matched">Vinculadas</option><option value="excluded">Excluidas del reclamo</option></select></label><button type="button" data-ops-compare>Comparar cobros</button></div>
    <p class="ops-salidas-status" role="status"></p>
    <div class="ops-salidas-table-wrap"><table class="ops-salidas-table"><thead><tr><th>Número / mensaje</th><th>Salida real / registro</th><th>Antigüedad</th><th>Estado</th><th>Cobro cargado</th><th>Acción</th></tr></thead><tbody></tbody></table></div>
    <details class="ops-salidas-guide"><summary>Criterios para OPERACIONES</summary><p>R / remis o un número solo puede indicar salida; T / taxi no corresponde. Punto: presente. Raya: salió. X: ausencia, sin viaje que reclamar. «Baja vacío» conserva el turno; «sube con out» va hacia el aeropuerto.</p><p>Uber / «por app» y cobertura externa quedan excluidos por evento. Un reemplazo entre choferes de Explora sí requiere cobro. La cobertura vale para una sola salida. El cambio de lista no cancela pendientes.</p><p>«Pago a Explora», gastos, deudas y cierres no son cobros de viajes. Por revisar no significa falta de cobro confirmada. Si la hora, cobertura o correspondencia es incierta, dejá el caso por revisar. Este panel no envía avisos: sigue usando el control de WhatsApp y Telegram ya programado.</p></details>
  </section>`;
  const q=s=>host.querySelector(s), chips=q('.ops-salidas-chips'),tbody=q('tbody'),summary=q('.ops-salidas-summary'),statusEl=q('.ops-salidas-status');
  const dateInput=q('[data-ops-departed-at]'),sourceInput=q('[data-ops-source]'),kindInput=q('[data-ops-disposition]'),noteInput=q('[data-ops-note]');
  const nowButton=q('[data-ops-now]'),registerButton=q('[data-ops-register]'),compareButton=q('[data-ops-compare]'),filter=q('[data-ops-filter]');
  let exits=[],stopListen=null,busy=false,running=false,exitsReady=false,timer=null,generation=0,pendingDraft=null,selectedNumber=null,autoEnabled=false,visibleRows=[];
  const selections=new Map(),attempted=new Set();
  let editingReview=false;
  const escape=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const boardNow=()=>buildOpsBoard({numbers,exits,payments:getPayments(),dayKey:getDayKey(),now:now(),dataReady:exitsReady&&paymentsReady()});
  async function link(pair){
    const epoch=generation;busy=true;statusEl.textContent='Vinculando cobro…';paint();
    try{await linkPayment(pair);if(epoch===generation)statusEl.textContent='Cobro vinculado a una sola salida.';}
    catch(error){if(epoch===generation)statusEl.textContent=error?.message||'No se pudo vincular.';}
    finally{if(epoch===generation){busy=false;if(running)paint();}}
  }
  function paint(){
    const board=boardNow();dateInput.max=opsDateTimeInput(now());
    for(const field of [dateInput,sourceInput,kindInput,noteInput,nowButton])field.disabled=busy||Boolean(pendingDraft);
    registerButton.disabled=busy||!exitsReady;compareButton.disabled=busy||!exitsReady||!paymentsReady();
    chips.innerHTML=numbers.map(n=>`<button type="button" class="ops-salidas-chip${selectedNumber===n?' selected':''}" data-ops-number="${n}" aria-label="Elegir remis ${n}" aria-pressed="${selectedNumber===n}" ${busy||pendingDraft?'disabled':''}>${n}</button>`).join('');
    summary.innerHTML=`<span>Salidas hoy<b>${board.summary.exited}</b></span><span>Pendientes sin cobro<b>${board.summary.withoutCharge}</b></span><span>Por revisar<b>${board.summary.review}</b></span><span>Excluidas<b>${board.summary.excluded}</b></span>`;
    // Keep the row and its revision stable while an administrator is editing it.
    // A concurrent revision is rejected by the transaction instead of overwriting it.
    if(!editingReview||busy){
    visibleRows=board.rows.filter(r=>!filter.value||filter.value==='all'||filter.value===r.status);
    tbody.innerHTML=visibleRows.map((row,i)=>{
      const candidateControl=!row.paymentId&&row.candidates.length?`<select data-ops-select="${i}" aria-label="Cobro para salida ${row.remisNumber} del ${escape(row.markedLabel)}" ${busy||!paymentsReady()?'disabled':''}><option value="">Elegir cobro…</option>${row.candidates.map(p=>`<option value="${escape(p.id)}" ${selections.get(row.id)===p.id?'selected':''}>${escape(formatOpsDate(paymentTime(p)))} · ${escape(p.operatorName||p.driverName||'')} · $${Number(p.amount||p.monto||0).toLocaleString('es-AR')} · ${escape(p.id.slice(-6))}</option>`).join('')}</select><button type="button" data-ops-link="${i}" ${busy||!exitsReady||!paymentsReady()?'disabled':''}>Vincular cobro</button>`:'';
      const reviewControl=!row.paymentId&&reviewExit?`<details data-ops-review-editor><summary>Revisar clasificación</summary><label>Clasificación<select data-ops-review-kind="${i}">${Object.entries(OPS_DISPOSITIONS).map(([v,label])=>`<option value="${v}" ${(row.disposition||'own')===v?'selected':''}>${label}</option>`).join('')}</select></label><label>Motivo<input data-ops-review-note="${i}" maxlength="500" value="${escape(row.reviewNote)}"></label><button type="button" data-ops-review="${i}" ${busy||!exitsReady?'disabled':''}>Guardar revisión</button></details>`:'';
      return `<tr><td><span class="ops-salidas-num">${Number(row.remisNumber)}</span><small>${escape(row.sourceRef||'Registro anterior sin referencia')}</small></td><td>${row.markedLabel}<small>Cargada: ${row.registeredLabel}</small></td><td>${row.ageLabel}</td><td><span class="ops-salidas-badge ${row.status==='matched'?'yes':row.status==='review'?'review':row.status==='excluded'?'excluded':'no'}">${row.chargeLabel}</span><small>${escape(row.reason)}</small>${row.canRemind?'<small>2 h o más · verificar antes de reclamar</small>':''}${row.reviewNote?`<small>${escape(row.reviewNote)}</small>`:''}</td><td>${row.chargeAtLabel}</td><td>${candidateControl||escape(row.status==='matched'?'Vinculado':row.status==='excluded'?'No reclamar':row.status==='review'?'Revisión necesaria':'Esperando cobro')}${reviewControl}</td></tr>`;
    }).join('')||'<tr><td colspan="6">No hay salidas en esta vista.</td></tr>';
    }
    if(running&&autoEnabled&&exitsReady&&paymentsReady()&&!busy&&linkPayment){const pair=board.automaticLinks.find(p=>!attempted.has(`${p.exitId}/${p.paymentId}`));if(pair){attempted.add(`${pair.exitId}/${pair.paymentId}`);void link(pair);}}
  }
  chips.addEventListener('click',event=>{const btn=event.target.closest('[data-ops-number]');if(!btn||busy||pendingDraft)return;selectedNumber=Number(btn.dataset.opsNumber);autoEnabled=false;paint();});
  for(const input of [dateInput,sourceInput,kindInput,noteInput])input.addEventListener('input',()=>{autoEnabled=false;});
  nowButton.addEventListener('click',()=>{if(!busy&&!pendingDraft){dateInput.value=opsDateTimeInput(now());autoEnabled=false;}});
  registerButton.addEventListener('click',async()=>{
    if(busy||!exitsReady)return;
    if(!pendingDraft&&(!selectedNumber||!dateInput.value)){statusEl.textContent='Elegí un número e indicá la fecha y hora real del mensaje.';return;}
    const epoch=generation;busy=true;autoEnabled=false;paint();
    try{
      if(!pendingDraft){const draft=await referencedExit({remisNumber:selectedNumber,markedAtMs:parseOpsDateTime(dateInput.value,now()),sourceRef:sourceInput.value,disposition:kindInput.value||'own',reviewNote:noteInput.value});if(epoch!==generation)return;pendingDraft=draft;}
      statusEl.textContent='Registrando salida…';const result=await markExit(pendingDraft);
      if(epoch===generation){pendingDraft=null;selectedNumber=null;dateInput.value='';sourceInput.value='';noteInput.value='';kindInput.value='own';statusEl.textContent=result?.duplicate?'Este mensaje ya estaba registrado. Se conservó la salida original.':'Salida registrada. Completá la revisión y pulsá Comparar cobros.';}
    }catch(error){if(epoch===generation)statusEl.textContent=(error?.message||'No se pudo guardar.')+(pendingDraft?' Reintentá Registrar salida; no creará otra copia.':'');}
    finally{if(epoch===generation){busy=false;if(running)paint();}}
  });
  compareButton.addEventListener('click',()=>{if(busy||!exitsReady||!paymentsReady())return;autoEnabled=true;attempted.clear();statusEl.textContent='Comparando cobros. Los casos ambiguos quedan por revisar; no se envían avisos.';paint();});
  filter.addEventListener('change',()=>{editingReview=false;paint();});
  tbody.addEventListener('toggle',event=>{if(!event.target.matches?.('[data-ops-review-editor]'))return;editingReview=Boolean(tbody.querySelector?.('details[open]'));if(editingReview)autoEnabled=false;else if(!busy)paint();},true);
  tbody.addEventListener('change',event=>{const input=event.target.closest('[data-ops-select]');if(input){const row=visibleRows[Number(input.dataset.opsSelect)];if(row)selections.set(row.id,input.value);}});
  tbody.addEventListener('click',async event=>{
    if(busy||!exitsReady)return;
    const button=event.target.closest('[data-ops-link]');
    if(button){if(!paymentsReady())return;const row=visibleRows[Number(button.dataset.opsLink)],paymentId=row&&selections.get(row.id);if(!row?.candidates.some(p=>p.id===paymentId)){statusEl.textContent='Elegí el cobro correspondiente a esta salida.';return;}attempted.add(`${row.id}/${paymentId}`);void link({exitId:row.id,paymentId});return;}
    const review=event.target.closest('[data-ops-review]');if(!review||!reviewExit)return;
    const index=Number(review.dataset.opsReview),row=visibleRows[index];if(!row)return;
    const input={exitId:row.id,disposition:q(`[data-ops-review-kind="${index}"]`).value,reviewNote:q(`[data-ops-review-note="${index}"]`).value,expectedRevision:Number(row.reviewRevision||0)};
    const epoch=generation;busy=true;autoEnabled=false;editingReview=false;paint();
    try{await reviewExit(input);if(epoch===generation)statusEl.textContent='Clasificación guardada para esta salida solamente.';}
    catch(error){if(epoch===generation)statusEl.textContent=error?.message||'No se pudo guardar la revisión.';}
    finally{if(epoch===generation){busy=false;if(running)paint();}}
  });
  return {start(){this.stop();running=true;const epoch=generation;stopListen=listenExits((rows,ready=true)=>{if(!running||epoch!==generation)return;exits=rows||[];exitsReady=ready;paint();},error=>{if(!running||epoch!==generation)return;exitsReady=false;autoEnabled=false;statusEl.textContent='No se pudieron confirmar las salidas. No interpretar esto como falta de cobro.';paint();});timer=setIntervalFn(()=>{if(running)paint();},30000);paint();},
    stop(){generation++;running=false;busy=false;pendingDraft=null;selectedNumber=null;autoEnabled=false;editingReview=false;dateInput.value='';sourceInput.value='';noteInput.value='';kindInput.value='own';if(typeof stopListen==='function')stopListen();stopListen=null;if(timer!==null)clearIntervalFn(timer);timer=null;exits=[];exitsReady=false;selections.clear();attempted.clear();},refresh:paint};
}
