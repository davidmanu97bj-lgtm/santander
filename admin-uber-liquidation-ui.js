import {escapeUi} from './explora-ui.js?v=20260919-login-period-1';

const money=value=>new Intl.NumberFormat('es-AR',{style:'currency',currency:'ARS',maximumFractionDigits:2}).format(value);
export function parseUberNetAmount(value) {
  const text=String(value??'').trim();
  if(text.startsWith('-'))throw new Error('No se puede registrar un importe negativo. Conciliá con Fleet el saldo y las comisiones antes de cerrar.');
  if(!/^(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d{1,2})?$/.test(text))throw new Error('Ingresá importes en pesos, con hasta dos decimales separados por coma.');
  const amount=Number(text.replace(/\./g,'').replace(',','.'));
  if(!Number.isFinite(amount)||amount<0||amount>100000000)throw new Error('Revisá los importes de la semana.');
  return amount;
}

export function adminUberWeek(now=new Date()) {
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Argentina/Buenos_Aires',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
  const part=name=>parts.find(p=>p.type===name).value;
  const date=new Date(`${part('year')}-${part('month')}-${part('day')}T12:00:00Z`),day=date.getUTCDay();
  date.setUTCDate(date.getUTCDate()-(day+6)%7-(day===1?14:7));
  const weekStartDate=date.toISOString().slice(0,10);
  date.setUTCDate(date.getUTCDate()+7);
  return {weekStartDate,weekCloseDate:date.toISOString().slice(0,10)};
}

export function adminUberInput(values,week) {
  const cashAmount=parseUberNetAmount(values.cash),transferAmount=parseUberNetAmount(values.digital),totalAmount=parseUberNetAmount(values.total);
  if(!values.driverUid)throw new Error('Elegí un chofer.');
  if(Math.round(cashAmount*100)+Math.round(transferAmount*100)!==Math.round(totalAmount*100))throw new Error('Efectivo y digital deben sumar el total neto de la semana.');
  const sourceReference=String(values.sourceReference||'').trim();
  if(sourceReference.length<3||sourceReference.length>300)throw new Error('Indicá la referencia del reporte de Fleet (entre 3 y 300 caracteres).');
  if(values.reconciled!==true)throw new Error('Confirmá que conciliaste los importes netos y sus destinatarios.');
  return {driverUid:values.driverUid,...week,cashAmount,transferAmount,totalAmount,sourceReference,
    amountBasis:'net_after_uber_commission',digitalRecipient:'explora',cashRecipient:'driver',reconciled:true};
}

export function adminUberReview(result) {
  return `<dl class="admin-uber-net-review"><div><dt>Total neto</dt><dd>${escapeUi(money(result.total))}</dd></div><div><dt>Caja chica incluida</dt><dd>${escapeUi(money(result.cashbox))}</dd></div><div><dt>${result.balance>0?'Chofer le pasa a Explora':result.balance<0?'Explora le pasa al chofer':'Sin transferencia por Uber'}</dt><dd>${escapeUi(money(Math.abs(result.balance)))}</dd></div></dl><p class="file-note">Este importe se compensa con los demás movimientos de Billeteras en un único cierre.</p>`;
}

export function mountAdminUberLiquidation({isAuthorized,getDrivers,register,onCompleted,policy=globalThis.ExploraUberWeeklyPolicy}) {
  const button=document.getElementById('adminUberLiquidationBtn');
  let dialog,busy=false,week,generation=0;
  const el=id=>dialog.querySelector('#'+id);
  const close=()=>{if(busy)return;generation++;dialog.close();button?.focus();};
  const fields=()=>({driverUid:el('adminUberNetDriver').value,cash:el('adminUberNetCash').value,digital:el('adminUberNetDigital').value,total:el('adminUberNetTotal').value,sourceReference:el('adminUberNetSource').value,reconciled:el('adminUberNetConfirmed').checked});
  function preview(){
    el('adminUberNetStatus').textContent='';
    try{const data=adminUberInput({...fields(),reconciled:true,sourceReference:'preview'},week);el('adminUberNetReview').innerHTML=adminUberReview(policy.calculate(data));}
    catch{el('adminUberNetReview').textContent='Completá efectivo, digital y total para ver la compensación.';}
  }
  function ensure(){
    if(dialog)return;
    dialog=document.createElement('dialog');dialog.className='admin-uber-net-dialog';dialog.setAttribute('aria-labelledby','adminUberNetTitle');
    dialog.innerHTML=`<form id="adminUberNetForm" novalidate><header><div><p class="eyebrow">ADMINISTRACIÓN</p><h2 id="adminUberNetTitle">Cierre semanal de Uber</h2></div><button type="button" id="adminUberNetClose">Cerrar</button></header>
      <p id="adminUberNetWeek" class="admin-uber-net-week"></p>
      <p>Cargá el <strong>efectivo retenido por el chofer y el digital neto recibido por Explora</strong>, con las comisiones de Uber ya descontadas y conciliados con el reporte semanal de Fleet.</p>
      <fieldset id="adminUberNetFields"><label>Chofer<select id="adminUberNetDriver" required></select></label>
      <div class="admin-uber-net-grid"><label>Efectivo retenido por el chofer<input id="adminUberNetCash" inputmode="decimal" type="text" placeholder="0,00" autocomplete="off" required></label><label>Digital neto de Explora<input id="adminUberNetDigital" inputmode="decimal" type="text" placeholder="0,00" autocomplete="off" required></label></div>
      <label>Total neto de la semana<input id="adminUberNetTotal" inputmode="decimal" type="text" placeholder="0,00" autocomplete="off" required></label>
      <p class="file-note">Efectivo + digital deben coincidir con el total neto. Si Fleet muestra efectivo bruto o comisiones pendientes de descontar, conciliá esos importes antes de registrar.</p>
      <label>Referencia del reporte de Fleet<input id="adminUberNetSource" type="text" maxlength="300" placeholder="Reporte, período e identificador del conductor" required></label>
      <label class="admin-uber-net-check"><input id="adminUberNetConfirmed" type="checkbox"><span>Verifiqué la semana, los importes netos, las comisiones y que el chofer conserva el efectivo y Explora recibe el digital.</span></label></fieldset>
      <div id="adminUberNetReview" aria-live="polite"></div><p id="adminUberNetStatus" role="status" aria-live="polite"></p>
      <footer><button type="button" id="adminUberNetCancel">Cancelar</button><button type="submit" id="adminUberNetSave" class="save">Registrar cierre semanal</button></footer></form>`;
    document.body.append(dialog);
    el('adminUberNetClose').onclick=close;el('adminUberNetCancel').onclick=close;
    dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();else generation++;});
    el('adminUberNetFields').addEventListener('input',preview);
    el('adminUberNetForm').addEventListener('submit',async event=>{
      event.preventDefault();if(busy||!isAuthorized())return;
      let input;try{input=adminUberInput(fields(),week);}catch(error){el('adminUberNetStatus').textContent=error.message;return;}
      const seq=generation;busy=true;el('adminUberNetFields').disabled=true;el('adminUberNetSave').disabled=true;el('adminUberNetClose').disabled=true;el('adminUberNetCancel').disabled=true;dialog.setAttribute('aria-busy','true');el('adminUberNetStatus').textContent='Registrando cierre semanal…';
      try{
        const result=await register(input);if(seq!==generation||!isAuthorized())return;
        el('adminUberNetStatus').textContent=result.alreadyRegistered?'Esta semana ya quedó registrada con estos importes.':'Cierre semanal registrado. Ya está incluido en Billeteras.';
        el('adminUberNetSave').textContent='Registrado';onCompleted?.(result);
      }catch(error){if(seq===generation&&isAuthorized()){el('adminUberNetStatus').textContent=error.message||'No se pudo registrar el cierre. Podés reintentar.';el('adminUberNetFields').disabled=false;el('adminUberNetSave').disabled=false;}}
      finally{busy=false;dialog.removeAttribute('aria-busy');el('adminUberNetClose').disabled=false;el('adminUberNetCancel').disabled=false;}
    });
  }
  function open(){
    if(!isAuthorized())return;ensure();if(busy)return;generation++;week=adminUberWeek();el('adminUberNetForm').reset();el('adminUberNetFields').disabled=false;el('adminUberNetSave').disabled=false;el('adminUberNetSave').textContent='Registrar cierre semanal';
    el('adminUberNetWeek').textContent=`Semana ${week.weekStartDate} al ${week.weekCloseDate}`;
    const drivers=getDrivers();el('adminUberNetDriver').innerHTML='<option value="">Elegir chofer</option>'+drivers.map(driver=>`<option value="${escapeUi(driver.uid)}">${escapeUi(driver.name)}</option>`).join('');
    preview();dialog.showModal();el('adminUberNetDriver').focus();
  }
  button?.addEventListener('click',open);
  return {open,reset(){generation++;dialog?.close();}};
}
