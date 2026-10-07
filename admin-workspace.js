import {escapeUi as esc,exploraIcon} from './explora-ui.js?v=20260919-admin-1';

const money=n=>new Intl.NumberFormat('es-AR',{style:'currency',currency:'ARS',maximumFractionDigits:2}).format(Number(n)||0);
const date=ms=>ms?new Intl.DateTimeFormat('es-AR',{timeZone:'America/Argentina/Buenos_Aires',day:'2-digit',month:'2-digit',year:'2-digit'}).format(new Date(ms)):'Sin fecha';
const monthOf=ms=>ms?new Intl.DateTimeFormat('en-CA',{timeZone:'America/Argentina/Buenos_Aires',year:'numeric',month:'2-digit'}).format(new Date(ms)):'';
const safeUrl=value=>/^https?:\/\//i.test(value||'')?esc(value):'';
const empty=message=>`<div class="admin-empty-state">${esc(message)}</div>`;
const normalize=value=>String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const actions=[
  ['movements','Movimientos','management'],['closures','Cierre / achique','wallet'],
  ['receipts','Comprobantes','upload'],['accountant','Contadora','expense'],
  ['invoices','Facturas ARCA','expense'],['digital','Carga digital','digital'],
  ['debt','100% chofer deuda','debt']
];
const scopedViews=new Set(['movements','closures','receipts','accountant']);

export function filterAdminRows(rows,{month,type='all',search='',driverUid=null}={}){
  const query=normalize(search);
  return rows.filter(r=>(driverUid===null||r.driverUid===driverUid)&&(!month||monthOf(r.time)===month)&&(type==='all'||r.kind===type)&&normalize(`${r.driver} ${r.detail}`).includes(query)).sort((a,b)=>b.time-a.time);
}

export function renderDriverCards(accounts,{ready=true}={}){
  if(!ready)return empty('Consultando los saldos del equipo…');
  const drivers=accounts.filter(d=>d.uid).slice().sort((a,b)=>String(a.name).localeCompare(String(b.name),'es',{sensitivity:'base'}));
  if(!drivers.length)return empty('No hay choferes activos. Podés agregarlos en Gestión de choferes.');
  return drivers.map(d=>{
    const balance=Number(d.balance)||0,state=balance>0.5?'driver-owes':balance<-.5?'explora-owes':'balanced';
    const label=balance>0.5?'Chofer debe':balance<-.5?'Explora debe':'Al día';
    return `<article class="admin-driver-card ${state}" data-admin-driver="${esc(d.uid)}" aria-label="Cuenta de ${esc(d.name)}">
      <div class="admin-driver-identity"><h2>${esc(d.name)}</h2><div class="admin-driver-card-balance"><span>${label}</span><strong>${money(Math.abs(balance))}</strong></div></div>
      <div class="admin-driver-actions" role="group" aria-label="Acciones de ${esc(d.name)}">${actions.map(([action,label,icon])=>`<button type="button" class="admin-driver-action action-${action}" data-admin-driver-action="${action}" data-driver-uid="${esc(d.uid)}" aria-label="${esc(label)} · ${esc(d.name)}"><span class="admin-driver-action-icon">${exploraIcon(icon)}</span><span>${label}</span></button>`).join('')}</div>
    </article>`;
  }).join('');
}

export function adminProofMarkup(row){
  const url=safeUrl(row.proof);
  if(url)return `<a href="${url}" target="_blank" rel="noopener">Ver comprobante ↗</a>`;
  if(row.receiptStatus==='waived_by_admin'&&row.receiptWaivedByUid){
    const at=Number(row.receiptWaivedAtMs),valid=at>0&&Number.isFinite(new Date(at).getTime());
    const when=valid?new Intl.DateTimeFormat('es-AR',{timeZone:'America/Argentina/Buenos_Aires',day:'2-digit',month:'2-digit',year:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(at)):'';
    return `<span class="admin-badge no-proof">Sin comprobante · administración</span>${when?`<small class="admin-waiver-date">Registrado ${esc(when)}</small>`:''}`;
  }
  return '<span class="admin-muted">Sin adjunto</span>';
}

export function mountAdminWorkspace({getState,loadDocuments,openDebt,openDigital,onDriverAction=()=>{}}){
  const $=id=>document.getElementById(id);
  let view='overview',selectedDriverUid=null,count=50,documentSequence=0,loadedDocumentKey='',documents=null,refreshTimer=null,renderedDriverMarkup='',renderedDriverDOM='';
  const titles={overview:['Tu equipo','Cada acción se aplica al chofer de su tarjeta.'],operations:['Operaciones','Salidas del aeropuerto, control de Uber y calendario.'],movements:['Movimientos','Cobros, gastos, deudas y pagos del chofer seleccionado.'],closures:['Cierre / achique','Cierres, pagos y ajustes del chofer seleccionado.'],receipts:['Comprobantes','Los respaldos de los movimientos y cierres del chofer seleccionado.'],accountant:['Contadora','Resumen mensual y factura del chofer seleccionado.']};
  const now=new Date();
  const months=Array.from({length:36},(_,i)=>{const d=new Date(now.getFullYear(),now.getMonth()-i,15);return {value:monthOf(d.getTime()),label:new Intl.DateTimeFormat('es-AR',{month:'long',year:'numeric'}).format(d)};});
  for(const id of ['adminActivityMonth','adminDocumentsMonth','adminReceiptsMonth'])$(id).innerHTML=months.map(m=>`<option value="${m.value}">${esc(m.label)}</option>`).join('');
  function selectedDriver(state=getState()){return state.accounts.find(d=>d.uid===selectedDriverUid);}
  const documentKey=()=>`${$('adminDocumentsMonth').value}|${selectedDriverUid||''}`;
  function setView(next,uid=null){
    const state=getState();if(!state.authorized||!titles[next])return false;
    if(scopedViews.has(next)&&(!uid||!state.accounts.some(d=>d.uid===uid)))return false;
    const changed=view!==next||selectedDriverUid!==uid;
    view=next;selectedDriverUid=scopedViews.has(next)?uid:null;count=50;
    if(changed){documentSequence++;clearTimeout(refreshTimer);$('adminActivitySearch').value='';$('adminActivityType').value='all';$('adminRefreshDocuments').disabled=false;$('adminDocumentsStatus').textContent='';}
    document.querySelectorAll('[data-admin-view]').forEach(b=>{if(b.dataset.adminView===view)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
    document.querySelectorAll('[data-admin-panel]').forEach(p=>p.hidden=p.dataset.adminPanel!==view);
    $('adminBackToDrivers').hidden=view==='overview';
    refresh();
    if(view==='accountant'){if(loadedDocumentKey!==documentKey())refreshDocuments();else renderDocuments();}
    if(changed){$('adminWorkspaceTitle').focus({preventScroll:true});$('adminDashboard').scrollIntoView({block:'start',behavior:'auto'});}
    return true;
  }
  document.querySelectorAll('[data-admin-view]').forEach(button=>button.addEventListener('click',()=>setView(button.dataset.adminView)));
  $('adminBackToDrivers').onclick=()=>setView('overview');
  $('adminDriverList').addEventListener('click',event=>{
    const button=event.target.closest('[data-admin-driver-action]');
    const state=getState();if(!button||!state.authorized||!state.ready)return;
    const uid=button.dataset.driverUid,action=button.dataset.adminDriverAction;
    if(!state.accounts.some(d=>d.uid===uid))return;
    if(scopedViews.has(action))setView(action,uid);
    else if(actions.some(([key])=>key===action))onDriverAction(action,uid);
  });
  $('adminGroupDebtBtn').addEventListener('click',()=>{if(getState().authorized&&getState().ready)openDebt(true);});
  $('adminDigitalExpenseBtn').addEventListener('click',openDigital);
  for(const id of ['adminActivityMonth','adminActivityType','adminActivitySearch'])$(id).addEventListener(id==='adminActivitySearch'?'input':'change',()=>{count=50;renderActivity(getState());});
  $('adminReceiptsMonth').onchange=()=>renderReceipts(getState());
  $('adminMoreActivity').onclick=()=>{count+=50;renderActivity(getState());};
  function renderActivity(state){
    if(!state.authorized)return;
    if(!state.ready){$('adminActivityTable').innerHTML=empty('Sincronizando movimientos…');$('adminMoreActivity').hidden=true;return;}
    const rows=filterAdminRows(state.movements,{driverUid:selectedDriverUid||'',month:$('adminActivityMonth').value,type:$('adminActivityType').value,search:$('adminActivitySearch').value});
    $('adminActivityTable').innerHTML=rows.length?`<table class="admin-table"><thead><tr><th>Fecha</th><th>Detalle</th><th>Método</th><th class="number">Monto</th><th>Comprobante</th></tr></thead><tbody>${rows.slice(0,count).map(r=>`<tr><td>${date(r.time)}</td><td>${esc(r.detail)}<small>${esc(r.label)}</small>${r.chargeClassification?`<span class="admin-charge-classification">${esc(r.chargeClassification.label)}</span>`:''}</td><td>${esc(r.method)}</td><td class="number ${['cash','digital'].includes(r.kind)?'income':'outgoing'}">${money(r.amount)}</td><td>${adminProofMarkup(r)}</td></tr>`).join('')}</tbody></table>`:empty('Este chofer no tiene movimientos para estos filtros.');
    $('adminMoreActivity').hidden=rows.length<=count;
  }
  function renderClosures(state){
    if(!state.authorized)return;
    if(!state.ready){$('adminClosuresTable').innerHTML=empty('Sincronizando cierres…');return;}
    const rows=filterAdminRows(state.closures,{driverUid:selectedDriverUid||''});
    $('adminClosuresTable').innerHTML=rows.length?`<table class="admin-table"><thead><tr><th>Fecha</th><th>Estado</th><th>Quién paga</th><th class="number">Monto</th><th>Comprobante</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${date(r.time)}</td><td><span class="admin-badge ${r.completed?'done':'pending'}">${esc(r.status)}</span></td><td>${esc(r.direction)}</td><td class="number">${money(r.amount)}</td><td>${adminProofMarkup(r)}</td></tr>`).join('')}</tbody></table>`:empty('Este chofer todavía no tiene cierres registrados.');
  }
  function renderReceipts(state){
    if(!state.authorized)return;
    if(!state.ready){$('adminReceiptsTable').innerHTML=empty('Sincronizando comprobantes…');return;}
    const rows=filterAdminRows([...state.movements,...state.closures],{driverUid:selectedDriverUid||'',month:$('adminReceiptsMonth').value});
    $('adminReceiptsTable').innerHTML=rows.length?`<table class="admin-table"><thead><tr><th>Fecha</th><th>Movimiento</th><th class="number">Monto</th><th>Comprobante</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${date(r.time)}</td><td>${esc(r.detail)}<small>${esc(r.label)}</small></td><td class="number">${money(r.amount)}</td><td>${adminProofMarkup(r)}</td></tr>`).join('')}</tbody></table>`:empty('Este chofer no tiene comprobantes para este mes.');
  }
  function renderCards(state){
    const host=$('adminDriverList'),markup=renderDriverCards(state.accounts,{ready:state.ready});
    if(renderedDriverMarkup===markup&&host.innerHTML===renderedDriverDOM)return;
    const active=document.activeElement,focused=host.contains(active)?{uid:active.dataset.driverUid,action:active.dataset.adminDriverAction}:null;
    host.innerHTML=markup;renderedDriverMarkup=markup;renderedDriverDOM=host.innerHTML;
    if(focused?.uid)Array.from(host.querySelectorAll('[data-admin-driver-action]')).find(b=>b.dataset.driverUid===focused.uid&&b.dataset.adminDriverAction===focused.action)?.focus({preventScroll:true});
  }
  function refresh(){
    const state=getState();if(!state.authorized)return;
    for(const id of ['adminDigitalExpenseBtn','adminAddDebtBtn','adminGroupDebtBtn'])$(id).disabled=!state.ready;
    $('adminQuickStatus').textContent=state.ready?'':state.error?'No pudimos sincronizar el equipo. Recargá para volver a intentar.':'Sincronizando el equipo…';
    const driver=selectedDriver(state);
    $('adminWorkspaceTitle').textContent=titles[view][0];
    $('adminWorkspaceSubtitle').textContent=scopedViews.has(view)?(driver?driver.name:'El chofer seleccionado ya no está activo.'):titles[view][1];
    $('adminWorkspaceSubtitle').classList.toggle('is-driver-name',scopedViews.has(view));
    document.querySelectorAll('[data-admin-scoped-name]').forEach(el=>el.textContent=driver?.name||'Chofer seleccionado');
    for(const id of ['adminMovementsBtn','adminManageClosuresBtn','adminAdjustmentBtn','adminHistoryBtn'])$(id).disabled=!state.ready||!driver;
    const owed=state.accounts.reduce((n,d)=>n+Math.max(0,d.balance),0),pay=state.accounts.reduce((n,d)=>n+Math.max(0,-d.balance),0);
    $('adminOverviewMetrics').innerHTML=[['Choferes activos',state.accounts.length],['Por cobrar a choferes',money(owed)],['Por pagar a choferes',money(pay)]].map(([label,value])=>`<article><span>${label}</span><strong>${state.ready?value:'—'}</strong></article>`).join('');
    renderCards(state);
    if(view==='movements')renderActivity(state);if(view==='closures')renderClosures(state);if(view==='receipts')renderReceipts(state);
  }
  function renderDocuments(){
    if(!documents)return;
    const rows=(documents.rows||[]).filter(r=>r.uid===selectedDriverUid);
    $('adminDocumentsTable').innerHTML=rows.length?`<table class="admin-table"><thead><tr><th>Chofer</th><th class="number">Facturación bruta</th><th class="number">Debe facturar · 40%</th><th>Factura del chofer</th><th>Resumen</th></tr></thead><tbody>${rows.map(r=>`<tr><td><strong>${esc(r.name)}</strong>${r.issues.length?`<small class="outgoing">${r.issues.length} observaciones en el resumen</small>`:''}</td><td class="number">${money(r.totals.gross)}${r.fiscalComplete===false?'<small>Bruto conocido; falta Uber</small>':''}</td><td class="number">${money(r.totals.participation)}${r.fiscalComplete===false?'<small class="outgoing">Subtotal: revisar base antes de facturar</small>':''}${!r.closedMonth?'<small>Provisional</small>':''}</td><td>${r.invoices.length?r.invoices.map((i,index)=>`<a href="${safeUrl(i.url)}" target="_blank" rel="noopener">Factura recibida${index?' · versión anterior':''} ↗</a>`).join('<br>'):`<span class="admin-badge ${r.closedMonth&&r.totals.gross>0?'pending':''}">${r.fiscalComplete===false?'Base por completar':r.closedMonth?(r.totals.gross>0?'Pendiente de recibir':'Sin facturación'):'Mes en curso'}</span>`}</td><td><button type="button" class="admin-table-button" data-admin-report="${esc(r.uid)}">Descargar PDF</button></td></tr>`).join('')}</tbody></table>`:empty('Este chofer no tiene documentación para el mes seleccionado.');
  }
  async function refreshDocuments(){
    if(!getState().authorized||!selectedDriverUid||view!=='accountant')return;
    const sequence=++documentSequence,month=$('adminDocumentsMonth').value,driverUid=selectedDriverUid,key=documentKey();
    loadedDocumentKey='';documents=null;$('adminDocumentsTable').innerHTML='';$('adminDocumentsStatus').textContent='Preparando la documentación del chofer…';$('adminRefreshDocuments').disabled=true;
    try{const result=await loadDocuments({month,driverUid,overviewOnly:true});if(sequence!==documentSequence||!getState().authorized||selectedDriverUid!==driverUid)return;documents={...result,month};loadedDocumentKey=key;renderDocuments();$('adminDocumentsStatus').textContent='';}
    catch(error){if(sequence===documentSequence)$('adminDocumentsStatus').textContent=error.message||'No se pudo cargar. Volvé a intentar.';}
    finally{if(sequence===documentSequence)$('adminRefreshDocuments').disabled=false;}
  }
  $('adminRefreshDocuments').onclick=refreshDocuments;$('adminDocumentsMonth').onchange=refreshDocuments;
  $('adminDocumentsTable').addEventListener('click',async event=>{
    const button=event.target.closest('[data-admin-report]');if(!button||button.disabled||!getState().authorized||button.dataset.adminReport!==selectedDriverUid)return;
    const sequence=documentSequence;button.disabled=true;$('adminDocumentsStatus').textContent='Preparando el PDF del chofer…';
    try{const result=await loadDocuments({month:documents.month,driverUid:selectedDriverUid});if(sequence!==documentSequence||!getState().authorized)return;
      const bytes=Uint8Array.from(atob(result.pdf.base64),c=>c.charCodeAt(0)),url=URL.createObjectURL(new Blob([bytes],{type:'application/pdf'}));
      const a=document.createElement('a');a.href=url;a.download=result.pdf.filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);$('adminDocumentsStatus').textContent='Resumen descargado.';
    }catch(error){if(sequence===documentSequence)$('adminDocumentsStatus').textContent=error.message;}
    finally{button.disabled=false;}
  });
  return {refresh,openDriverView:setView,getSelectedDriverUid:()=>selectedDriverUid,
    invalidateDocuments(){loadedDocumentKey='';clearTimeout(refreshTimer);if(view==='accountant'&&getState().authorized)refreshTimer=setTimeout(refreshDocuments,700);},
    reset(){clearTimeout(refreshTimer);documentSequence++;documents=null;loadedDocumentKey='';renderedDriverMarkup='';renderedDriverDOM='';view='overview';selectedDriverUid=null;document.querySelectorAll('[data-admin-panel]').forEach(p=>p.hidden=p.dataset.adminPanel!=='overview');document.querySelectorAll('[data-admin-view]').forEach(b=>b.removeAttribute('aria-current'));$('adminBackToDrivers').hidden=true;for(const id of ['adminDocumentsTable','adminDocumentsStatus','adminActivityTable','adminClosuresTable','adminReceiptsTable','adminOverviewMetrics','adminDriverList'])$(id).innerHTML='';$('adminRefreshDocuments').disabled=false;}
  };
}
