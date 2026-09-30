import {escapeUi as esc} from './explora-ui.js?v=20260919-admin-1';
const money=cents=>new Intl.NumberFormat('es-AR',{style:'currency',currency:'ARS',maximumFractionDigits:2}).format(Number(cents||0)/100);
export function fleetSourceAmount(cents,currency){
  if(cents===null||cents===undefined)return 'Sin confirmar';
  const amount=new Intl.NumberFormat('es-AR',{minimumFractionDigits:2,maximumFractionDigits:2}).format(Number(cents)/100);
  return `${amount} ${/^[A-Z]{3}$/.test(String(currency||''))?currency:'(moneda por confirmar)'}`;
}
const issueText=issue=>typeof issue==='string'?issue:issue.message||issue.code||'Revisar información';
const statuses={planned:'Comparación preparada',ready:'Comparación preparada',review:'Necesita revisión',unchanged:'Ya comparado',blocked:'Datos incompletos'};
export function fleetInvoicePreviewText(invoice){
  const route=invoice?.route;
  return ['Servicio de traslado de pasajeros',route?.origin&&route?.destination?`${route.origin} → ${route.destination}`:'Recorrido pendiente de corroborar',`Fecha: ${invoice?.serviceDate||'por confirmar'}`,`Importe informado: ${fleetSourceAmount(invoice?.amountCents,invoice?.currency)}`,'Pendiente de validar tratamiento fiscal y datos del receptor. Sin emisión ni validez fiscal.'].join('\n');
}

export function mountUberFleet({isAuthorized,call}){
  const openButton=document.getElementById('adminUberFleetBtn');
  let dialog,settings,result,files={},generation=0,busy=false,mappings={},fileLoads=new Set(),fileVersions={};
  const el=id=>dialog.querySelector('#'+id);
  const authorized=()=>isAuthorized()===true;
  const close=()=>{generation++;dialog?.close();openButton.focus();};
  function ensure(){
    if(dialog)return;
    dialog=document.createElement('dialog');dialog.className='uber-fleet-dialog';dialog.setAttribute('aria-labelledby','fleetTitle');
    dialog.innerHTML=`<header class="fleet-header"><div><span class="fleet-kicker">INTEGRACIONES</span><h2 id="fleetTitle">Uber Fleet</h2></div><button type="button" class="fleet-close">Cerrar ×</button></header>
      <div class="fleet-body"><div class="fleet-mode"><strong>Comparación en paralelo</strong><p>Los reportes se revisan en un espacio separado. No modifican las billeteras, no emiten facturas y no envían Telegram.</p></div>
      <details class="fleet-connection"><summary>Conexión automática: pendiente de habilitación de Uber</summary><p>La API de flotas necesita autorización de Uber. Tener acceso al portal no habilita automáticamente esa conexión. Mientras tanto, podés descargar los reportes de viajes y pagos del portal e importarlos acá.</p><p>Un viaje recibido es una novedad operativa; el cobro se concilia cuando están confirmados el importe y su destinatario.</p></details>
      <form id="fleetForm"><fieldset id="fleetInputFields"><h3>1. Cargá los reportes de Uber</h3><div class="fleet-fields"><label>Identificador de la flota<input id="fleetId" required maxlength="100" pattern="[A-Za-z0-9][A-Za-z0-9._-]*" autocomplete="off" placeholder="ID de la organización en Uber"></label>
      <label>Reporte de viajes · CSV<input id="fleetTripsFile" type="file" accept=".csv,text/csv"></label><label>Reporte de pagos · CSV<input id="fleetPaymentsFile" type="file" accept=".csv,text/csv"></label></div><p class="fleet-hint">Usá siempre el mismo identificador. Hasta 100 viajes y 2 MB entre los dos archivos por comparación. No se admiten capturas ni PDF.</p>
      <h3>2. Asociá los choferes</h3><p class="fleet-hint">La asociación se hace por el ID del conductor en Uber. Si todavía no lo conocés, compará primero: se mostrará en cada viaje.</p><div id="fleetMappings"></div><button id="fleetAddMapping" type="button" class="fleet-secondary">+ Asociar conductor</button>
      <div class="fleet-actions"><button id="fleetCompare" type="submit" class="fleet-primary">Comparar reportes</button><button id="fleetSave" type="button" class="fleet-secondary" disabled>Guardar comparación</button><button id="fleetExport" type="button" class="fleet-secondary" disabled>Descargar resultado</button></div></fieldset></form>
      <p id="fleetStatus" role="status" aria-live="polite"></p><div id="fleetResults"></div>
      <details class="fleet-help"><summary>Qué necesita cada viaje para automatizarse</summary><ul><li>ID único del viaje y del conductor, estado final y fecha.</li><li>Bruto del pasajero, comisiones, moneda y forma de cobro confirmados.</li><li>Quién recibe el dinero y si ya se incluyó en una liquidación semanal.</li><li>Recorrido y kilómetros verificables para revisar la factura.</li></ul><p>Si falta el destino, la descripción será «Servicio de traslado de pasajeros». El sistema no inventa un recorrido ni presume una exención de IVA.</p><button id="fleetTemplates" type="button" class="fleet-secondary">Descargar formato de referencia</button><p class="fleet-hint">Estos archivos contienen ejemplos ficticios; no son reportes de tu cuenta.</p></details></div>`;
    document.body.append(dialog);
    dialog.querySelector('.fleet-close').onclick=close;
    dialog.addEventListener('cancel',()=>{generation++;});
    el('fleetForm').onsubmit=event=>{event.preventDefault();compare(false);};
    el('fleetSave').onclick=()=>compare(true);
    el('fleetAddMapping').onclick=()=>mappingRow('',{});
    el('fleetExport').onclick=()=>{if(result&&authorized())download('Explora-Uber-comparacion.json',JSON.stringify(result,null,2),'application/json');};
    el('fleetTemplates').onclick=async()=>{
      if(!authorized())return;const seq=generation;
      try{const data=await call('uberFleetTemplates',{});if(seq!==generation)return;for(const [name,text]of Object.entries(data.templates||{}))download(`ejemplo-ficticio-uber-${name}.csv`,text,'text/csv;charset=utf-8');}
      catch{if(seq===generation&&authorized())el('fleetStatus').textContent='No se pudieron obtener los formatos de referencia.';}
    };
    for(const [id,key]of [['fleetTripsFile','tripsCsv'],['fleetPaymentsFile','paymentsCsv']])el(id).onchange=async()=>{
      result=null;el('fleetSave').disabled=true;el('fleetExport').disabled=true;el('fleetResults').replaceChildren();files[key]='';
      const file=el(id).files[0],seq=generation,version=(fileVersions[key]||0)+1;fileVersions[key]=version;fileLoads.delete(key);el('fleetCompare').disabled=fileLoads.size>0||busy;if(!file)return;
      if(file.size>2_000_000||!file.name.toLowerCase().endsWith('.csv')){el('fleetStatus').textContent='Elegí un archivo CSV de hasta 2 MB.';el(id).value='';return;}
      fileLoads.add(key);el('fleetCompare').disabled=true;
      try{
        const content=await file.text();if(seq!==generation||version!==fileVersions[key])return;
        if(content.includes('\uFFFD')){el('fleetStatus').textContent='No se reconoce la codificación. Guardá el reporte como CSV UTF-8 antes de cargarlo.';el(id).value='';return;}
        files[key]=content;el('fleetStatus').textContent=`${file.name}: listo para comparar.`;
      }catch{if(seq===generation&&version===fileVersions[key])el('fleetStatus').textContent='No se pudo leer el archivo. Volvé a seleccionarlo.';}
      finally{if(seq===generation&&version===fileVersions[key]){fileLoads.delete(key);el('fleetCompare').disabled=fileLoads.size>0||busy;}}
    };
    el('fleetForm').addEventListener('input',event=>{if(!['fleetTripsFile','fleetPaymentsFile'].includes(event.target.id)){result=null;el('fleetSave').disabled=true;el('fleetExport').disabled=true;el('fleetResults').replaceChildren();}});
  }
  function download(name,text,type){const url=URL.createObjectURL(new Blob([text],{type}));const link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),15000);}
  function mappingRow(uberId,mapping){
    const row=document.createElement('div');row.className='fleet-mapping';
    row.innerHTML=`<label>ID del conductor en Uber<input data-uber-id maxlength="128" value="${esc(uberId)}" placeholder="UUID de Uber" autocomplete="off"></label><label>Chofer en Explora<select data-driver><option value="">Seleccionar chofer</option>${(settings?.drivers||[]).map(d=>`<option value="${esc(d.uid)}" ${d.uid===mapping.driverUid?'selected':''}>${esc(d.name)}</option>`).join('')}</select></label><label>Destinatario de lo digital<select data-recipient><option value="unknown">Pendiente de confirmar</option><option value="explora">Cuenta de Explora</option><option value="driver">Cuenta del chofer</option></select></label><button class="fleet-remove" type="button" aria-label="Quitar asociación">Quitar</button>`;
    row.querySelector('[data-recipient]').value=mapping.digitalRecipient||'unknown';
    row.querySelector('button').onclick=()=>{row.remove();result=null;el('fleetSave').disabled=true;el('fleetExport').disabled=true;el('fleetResults').replaceChildren();};
    el('fleetMappings').append(row);
  }
  function getMappings(){
    const value={};
    for(const row of el('fleetMappings').children){const uberId=row.querySelector('[data-uber-id]').value.trim(),driverUid=row.querySelector('[data-driver]').value,digitalRecipient=row.querySelector('[data-recipient]').value;
      if(!uberId&&!driverUid)continue;
      if(!uberId||!driverUid)throw new Error('Completá el ID de Uber y elegí el chofer, o quitá la asociación incompleta.');
      if(Object.hasOwn(value,uberId))throw new Error('Hay un ID de conductor de Uber repetido.');
      Object.defineProperty(value,uberId,{value:{driverUid,digitalRecipient},enumerable:true});
    }return value;
  }
  async function compare(persist){
    if(busy||fileLoads.size||!authorized())return;
    const seq=generation;busy=true;el('fleetInputFields').disabled=true;el('fleetCompare').disabled=true;el('fleetSave').disabled=true;el('fleetExport').disabled=true;
    el('fleetStatus').textContent=persist?'Guardando únicamente la comparación…':'Comparando viajes, cobros y liquidaciones semanales…';
    try{
      if(!files.tripsCsv)throw new Error('Primero cargá el CSV de viajes.');
      mappings=getMappings();
      const next=await call('uberFleetAnalyze',{mode:'shadow',fleetId:el('fleetId').value.trim(),tripsCsv:files.tripsCsv,paymentsCsv:files.paymentsCsv||'',driverMappings:mappings,persist});
      if(seq!==generation||!authorized())return;
      result=next;renderResult();el('fleetStatus').textContent=next.saved?(next.differenceCount?`Resumen guardado con ${next.differenceCount} diferencias. Se conservaron los viajes anteriores; descargá el resultado y conservá los CSV para revisar los cambios.`:'Comparación guardada. Los saldos y las facturas reales siguen sin cambios.'):'Comparación terminada. Revisá las diferencias antes de guardar.';
    }catch(error){if(seq===generation){el('fleetStatus').textContent=error.message||'No se pudo comparar. Volvé a intentar.';result=null;el('fleetResults').replaceChildren();}}
    finally{if(seq===generation){busy=false;el('fleetInputFields').disabled=false;el('fleetCompare').disabled=false;el('fleetSave').disabled=!result?.trips?.length||result?.summary?.inputRejected===true;el('fleetExport').disabled=!result;}}
  }
  function renderResult(){
    const s=result.summary||{},trips=result.trips||[];
    el('fleetResults').innerHTML=`<div class="fleet-metrics"><div><span>Viajes</span><strong>${trips.length}</strong></div><div><span>Preparados</span><strong>${s.planned??s.ready??trips.filter(t=>['planned','ready'].includes(t.status)).length}</strong></div><div><span>A revisar</span><strong>${s.review??0}</strong></div><div><span>Ya comparados</span><strong>${s.unchanged??0}</strong></div></div>
      ${(result.issues||[]).length?`<ul class="fleet-issues">${result.issues.map(i=>`<li>${esc(issueText(i))}</li>`).join('')}</ul>`:''}
      <div class="fleet-trip-list">${trips.map(t=>{
        const driver=settings.drivers.find(d=>d.uid===t.driverUid),issues=t.issues||[];
        return `<article class="fleet-trip"><header><strong>${esc(driver?.name||'Chofer sin asociar')}</strong><span class="fleet-pill ${t.status==='review'?'review':''}">${esc(statuses[t.status]||t.status)}</span></header><p>${esc(t.route?.origin&&t.route?.destination?`${t.route.origin} → ${t.route.destination}`:'Servicio de traslado de pasajeros · recorrido pendiente')}</p><dl><div><dt>Bruto informado</dt><dd>${esc(fleetSourceAmount(t.amountCents,t.currency))}</dd></div><div><dt>Medio de cobro</dt><dd>${({cash:'Efectivo',digital:'Digital'})[t.method]||'Sin confirmar'}</dd></div><div><dt>Impacto estimado sobre el bruto</dt><dd>${t.walletDeltaCents===null||t.walletDeltaCents===undefined?'Pendiente':money(t.walletDeltaCents)}</dd></div></dl>
          ${issues.length?`<ul class="fleet-issues">${issues.map(i=>`<li>${esc(issueText(i))}</li>`).join('')}</ul>`:''}
          <details><summary>Identificación y vista previa</summary><p class="fleet-id">ID Uber del conductor: ${esc(t.uberDriverId||'Falta')}<br>Viaje: ${esc(t.tripId||'Falta')}<br>Finalizado: ${esc(t.completedAt||'Sin fecha')}</p>${t.invoicePreview?`<h4>Factura · sin emisión</h4><pre>${esc(fleetInvoicePreviewText(t.invoicePreview))}</pre>`:'<p>La factura requiere revisión; no se emitió ningún comprobante.</p>'}${t.telegramPreview?.text?`<h4>Telegram · sin envío</h4><pre>${esc(t.telegramPreview.text)}</pre>`:'<p>Telegram: sin envío.</p>'}</details></article>`;
      }).join('')}</div><p class="fleet-hint">El impacto es una comparación, no un saldo definitivo. Un valor positivo indica importe a favor de Explora; uno negativo, a favor del chofer. Las comisiones, devoluciones y cobros pendientes requieren conciliación.</p>`;
  }
  openButton.addEventListener('click',async()=>{
    if(!authorized())return;ensure();const seq=++generation;files={};fileLoads=new Set();fileVersions={};result=null;busy=false;settings=null;el('fleetInputFields').disabled=false;
    el('fleetForm').reset();el('fleetMappings').replaceChildren();el('fleetResults').replaceChildren();el('fleetCompare').disabled=true;el('fleetSave').disabled=true;el('fleetExport').disabled=true;el('fleetStatus').textContent='Consultando la configuración…';dialog.showModal();
    try{const data=await call('uberFleetStatus',{});if(seq!==generation||!authorized())return;settings=data;el('fleetId').value=data.fleetId||'';mappings=data.driverMappings||{};for(const [id,map]of Object.entries(mappings))mappingRow(id,map);if(!Object.keys(mappings).length)mappingRow('',{});el('fleetCompare').disabled=false;el('fleetStatus').textContent='Listo para comparar reportes. Conexión automática pendiente de Uber.';}
    catch(error){if(seq===generation)el('fleetStatus').textContent=error.message||'No se pudo abrir la integración. Volvé a intentar.';}
  });
  return {reset(){generation++;files={};fileLoads=new Set();fileVersions={};result=null;settings=null;mappings={};dialog?.close();dialog?.remove();dialog=null;}};
}
