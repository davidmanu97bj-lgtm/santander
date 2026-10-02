const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=n=>new Intl.NumberFormat('es-AR',{style:'currency',currency:'ARS',maximumFractionDigits:2}).format(n||0);
const directions={driver_to_explora:'Chofer a Explora',explora_to_driver:'Explora al chofer',driver_pays_explora:'Chofer a Explora',explora_pays_driver:'Explora al chofer'};
const statuses={completed:'Completado',paid:'Pagado',approved:'Aprobado',pending:'Pendiente',pending_review:'En revisión',uploaded:'Adjuntada',active:'Activo',rejected:'Rechazado',cancelled:'Anulado',canceled:'Anulado',deleted:'Eliminado','sin estado':'Sin estado informado'};
const safeUrl=url=>/^https?:\/\//i.test(url||'')?esc(url):'';
const sections=[['resumen','Resumen'],['movimientos','Movimientos'],['cierres','Cierres y rendiciones'],['factura','Mi factura']];
export function mountMonthlyManagement({loadReport,uploadInvoice,openWallet=()=>{}}) {
  const root=document.getElementById('monthlyManagement');
  let current=null,view='resumen',filter='Todos',limit=15,sequence=0;
  const month=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Argentina/Buenos_Aires',year:'numeric',month:'2-digit'}).format(new Date());
  const [year,monthNumber]=month.split('-').map(Number);
  const months=Array.from({length:36},(_,i)=>{const date=new Date(Date.UTC(year,monthNumber-36+i,15,12));return {value:date.toISOString().slice(0,7),label:new Intl.DateTimeFormat('es-AR',{timeZone:'UTC',month:'long',year:'numeric'}).format(date)};});
  root.innerHTML=`<div class="mg-heading"><div><p class="mg-eyebrow">TU CUENTA, EN ORDEN</p><h2>Tu mes en Explora</h2></div><div class="monthly-month-picker"><label for="managementMonth">Mes a consultar</label><div><button type="button" id="previousManagementMonth" aria-label="Ver mes anterior">‹</button><select id="managementMonth">${months.map(m=>`<option value="${m.value}"${m.value===month?' selected':''}>${esc(m.label)}</option>`).join('')}</select><button type="button" id="nextManagementMonth" aria-label="Ver mes siguiente">›</button></div></div></div><nav class="mg-nav" aria-label="Secciones de Gestión">${sections.map(([id,label])=>`<button type="button" data-management-view="${id}" aria-controls="managementContent">${label}</button>`).join('')}</nav><p id="monthlyStatus" role="status"></p><div id="managementContent" class="mg-content" tabindex="-1"></div>`;
  const content=root.querySelector('#managementContent'),status=root.querySelector('#monthlyStatus'),selector=root.querySelector('#managementMonth');
  const previous=root.querySelector('#previousManagementMonth'),next=root.querySelector('#nextManagementMonth');
  const issueBox=()=>current.issues.length?`<details class="mg-alert"${current.fiscalComplete===false?' open':''}><summary>${current.issues.length} observación${current.issues.length===1?'':'es'} para revisar</summary>${current.issues.map(x=>`<p>${esc(x)}</p>`).join('')}</details>`:'';
  const walletButton=()=>'<button type="button" class="mg-secondary" data-wallet>Ver saldo y rendir en Billeteras →</button>';
  function navigation(){previous.disabled=selector.selectedIndex===0;next.disabled=selector.selectedIndex===selector.options.length-1;root.querySelectorAll('[data-management-view]').forEach(b=>{if(b.dataset.managementView===view)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});}
  function changeView(id){view=id;filter='Todos';limit=15;render();}
  function movement(r){const url=safeUrl(r.proof);return `<article class="mg-movement"><div class="mg-movement-top"><span>${esc(r.group)}</span><time>${esc(r.date)}</time></div><div class="mg-movement-main"><strong>${esc(r.detail||r.group)}</strong><b>${money(r.amount)}</b></div><div class="mg-movement-meta"><span>${esc(statuses[r.status]||r.status||'Sin estado informado')}</span>${r.method?`<span>${esc(r.method)}</span>`:''}${r.direction?`<span>${esc(directions[r.direction]||r.direction)}</span>`:''}</div>${r.included===false?'<p class="mg-note">No incluido en el bruto del mes.</p>':''}${r.includedInClosure?'<p class="mg-note">Incluido en un cierre. No es un pago adicional.</p>':''}${r.remaining!==undefined?`<p class="mg-note">Saldo de este registro al consultar: ${money(r.remaining)}</p>`:''}${url?`<a class="mg-proof" href="${url}" target="_blank" rel="noopener">Ver comprobante ↗</a>`:''}</article>`;}
  function render(){
    navigation();if(!current)return;
    const t=current.totals,invoices=current.invoices||[],closed=current.closedMonth;
    const sub=`<p class="mg-context">${esc(current.driverName)} · ${closed?'Mes finalizado':'Mes en curso · importes provisionales'}</p>`+
      (current.fiscalComplete===false?'<p class="mg-alert" role="status"><strong>Base mensual incompleta.</strong> Los netos de Uber sirven para Billeteras; falta su bruto fiscal. El importe mostrado es un subtotal conocido, no el importe final para emitir una factura.</p>':'');
    if(view==='resumen'){
      const action=current.issues.length?'Revisá las observaciones antes de emitir tu factura.':invoices.length?'Tenés una factura adjuntada. Podés consultarla en «Mi factura».':!t.gross?'No hay cobros aceptados para facturar en este mes.':closed?'Descargá el resumen y adjuntá tu factura emitida.':'Podés consultar tu acumulado. El importe final se define al terminar el mes.';
      content.innerHTML=sub+`<section class="mg-hero"><span>Tu participación del mes · ${t.rate||40}% del bruto</span><strong>${money(t.participation)}</strong><p>Importe para tu factura a Explora. El saldo a cobrar o rendir se consulta en Billeteras.</p></section><div class="mg-metrics"><article><span>Bruto de viajes</span><strong>${money(t.gross)}</strong></article><article><span>Tu factura</span><strong class="mg-small-value">${invoices.length?'Adjuntada':!t.gross?'Sin actividad':closed?'Sin adjuntar':'Mes en curso'}</strong></article></div><section class="mg-next"><h3>Tu próximo paso</h3><p>${action}</p><button class="mg-primary" type="button" data-go="factura">Ir a mi factura →</button></section>${issueBox()}<div class="mg-balance"><div><h3>¿Qué queda por cobrar o rendir?</h3><p>Consultá el saldo vigente y los períodos pendientes.</p></div>${walletButton()}</div>`;
    }else if(view==='factura'){
      content.innerHTML=`<h3>Mi factura del mes</h3>${sub}<section class="mg-hero"><span>Importe a facturar a Explora${!closed?' · provisional':''}</span><strong>${money(t.participation)}</strong></section>${issueBox()}<dl class="monthly-breakdown"><dt>Efectivo, incluido Uber aceptado</dt><dd>${money(t.cash)}</dd><dt>Cobros digitales</dt><dd>${money(t.digital)}</dd><dt>Bruto del mes</dt><dd>${money(t.gross)}</dd><dt>Participación</dt><dd>${t.rate||40}%</dd></dl><p class="mg-note">Explora factura al pasajero el 100% del viaje. Vos emitís a Explora tu factura por el 40% del bruto de tus viajes. Gastos y rendiciones no reducen esa base.</p><div class="mg-invoice-action"><span class="mg-step">1</span><div><h4>Descargá el resumen</h4><p>Compartilo con tu contadora para emitir la factura.</p><button type="button" id="downloadMonthlyReport" class="mg-primary">Descargar PDF para contadora</button></div></div><div class="mg-invoice-action"><span class="mg-step">2</span><div><h4>Adjuntá tu factura emitida</h4><label class="monthly-upload">Seleccionar PDF (hasta 15 MB)<input id="monthlyInvoiceFile" type="file" accept="application/pdf,.pdf"></label>${invoices.map(r=>`<p class="mg-note">Factura adjuntada · ${safeUrl(r.url)?`<a href="${safeUrl(r.url)}" target="_blank" rel="noopener">Ver PDF ↗</a>`:'Archivo sin enlace disponible'}</p>`).join('')}</div></div>`;
    }else{
      const closures=view==='cierres';
      const groups=closures?['Cierres','Pagos y compensaciones']:['Cobros de viajes','Liquidaciones Uber','Uber neto conciliado','Gastos','Deudas','Adelantos y préstamos'];
      const all=current.rows.filter(r=>groups.includes(r.group)).slice().sort((a,b)=>b.date.localeCompare(a.date));
      const rows=all.filter(r=>filter==='Todos'||r.group===filter);
      content.innerHTML=`<h3>${closures?'Cierres y rendiciones':'Movimientos del mes'}</h3>${sub}${closures?`<p class="mg-note">Historial registrado en este mes. Para ver qué falta rendir, consultá Billeteras. Los ajustes de un cierre no son pagos adicionales.</p>${walletButton()}`:''}<div class="mg-filter"><label for="managementFilter">Mostrar</label><select id="managementFilter">${['Todos',...groups].map(g=>`<option${g===filter?' selected':''}>${g}</option>`).join('')}</select><span>${rows.length} registro${rows.length===1?'':'s'}</span></div>${rows.length?rows.slice(0,limit).map(movement).join(''):'<div class="mg-empty">No hay movimientos para esta selección.</div>'}${rows.length>limit?'<button class="mg-secondary mg-more" id="managementMore" type="button">Ver más movimientos</button>':''}`;
    }
    if(current.fiscalComplete===false){
      const hero=content.querySelector('.mg-hero');
      if(hero){hero.querySelector('span').textContent='Subtotal conocido · base mensual incompleta';const note=hero.querySelector('p');if(note)note.textContent='Falta el bruto fiscal de Uber. Revisá el resumen antes de emitir; el saldo operativo está en Billeteras.';}
      const cashLabel=content.querySelector('.monthly-breakdown dt');if(cashLabel)cashLabel.textContent='Efectivo con bruto fiscal disponible';
      const metricLabel=content.querySelector('.mg-metrics article span');if(metricLabel)metricLabel.textContent='Bruto conocido de viajes';
      const invoiceState=content.querySelector('.mg-small-value');if(invoiceState&&!invoices.length)invoiceState.textContent='Base por completar';
    }
    content.querySelectorAll('[data-wallet]').forEach(b=>b.onclick=()=>openWallet());
    content.querySelectorAll('[data-go]').forEach(b=>b.onclick=()=>changeView(b.dataset.go));
    const f=content.querySelector('#managementFilter');if(f)f.onchange=()=>{filter=f.value;limit=15;render();content.querySelector('#managementFilter').focus();};
    const more=content.querySelector('#managementMore');if(more)more.onclick=()=>{limit+=15;render();};
    const download=content.querySelector('#downloadMonthlyReport');if(download)download.onclick=async()=>{
      const selected=selector.value,request=sequence;download.disabled=true;status.textContent='Preparando el resumen…';
      try{const result=await loadReport(selected,true);const blob=new Blob([Uint8Array.from(atob(result.pdf.base64),c=>c.charCodeAt(0))],{type:'application/pdf'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=result.pdf.filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);if(request===sequence)status.textContent='Resumen descargado.';}catch(error){if(request===sequence)status.textContent=error.message;}finally{download.disabled=false;}
    };
    const file=content.querySelector('#monthlyInvoiceFile');if(file)file.onchange=async()=>{
      if(!file.files[0])return;const selected=selector.value,request=sequence;file.disabled=true;status.textContent='Adjuntando factura…';
      try{await uploadInvoice(selected,file.files[0]);if(request===sequence){await refresh();status.textContent='Factura adjuntada para revisión.';}}catch(error){if(request===sequence)status.textContent=error.message;}finally{file.disabled=false;}
    };
  }
  async function refresh(){const request=++sequence;navigation();status.textContent='Consultando el mes…';content.innerHTML='';current=null;root.setAttribute('aria-busy','true');try{const report=await loadReport(selector.value,false);if(request!==sequence)return;current=report;status.textContent='';render();}catch(error){if(request===sequence){status.textContent=error.message;content.innerHTML='<button type="button" class="mg-secondary" id="managementRetry">Volver a intentar</button>';content.querySelector('button').onclick=refresh;}}finally{if(request===sequence)root.removeAttribute('aria-busy');}}
  selector.onchange=()=>{filter='Todos';limit=15;refresh();};
  previous.onclick=()=>{if(selector.selectedIndex>0){selector.selectedIndex--;selector.dispatchEvent(new Event('change'));}};
  next.onclick=()=>{if(selector.selectedIndex<selector.options.length-1){selector.selectedIndex++;selector.dispatchEvent(new Event('change'));}};
  root.querySelectorAll('[data-management-view]').forEach(b=>b.onclick=()=>changeView(b.dataset.managementView));
  navigation();return {refresh};
}
