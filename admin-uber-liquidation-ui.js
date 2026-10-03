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
  const cashAmount=parseUberNetAmount(values.cash),transferAmount=parseUberNetAmount(values.digital);
  const totalAmount=(Math.round(cashAmount*100)+Math.round(transferAmount*100))/100;
  if(!values.driverUid)throw new Error('Elegí un chofer.');
  if(totalAmount>100000000)throw new Error('El total supera el máximo permitido.');
  return {driverUid:values.driverUid,...week,cashAmount,transferAmount,totalAmount};
}

export function adminUberReview(result) {
  return `<dl class="admin-uber-net-review"><div><dt>Total Uber</dt><dd id="adminUberNetTotal">${escapeUi(money(result.total))}</dd></div></dl><p class="file-note">El chofer revisa y acepta. Recién entonces se incorpora a Billeteras, con el 10% de caja chica, y se avisa por Telegram.</p>`;
}

export function isPendingAdminUberConfirmation(item={}) {
  return item.settlementRuleVersion==='uber_admin_fleet_split_10_v1'&&item.settlementWorkflowVersion==='v86_admin_fleet_weekly'&&
    item.driverConfirmationRequired===true&&item.adminConfirmed===true&&item.driverConfirmed!==true&&
    String(item.reviewStatus||item.status||'').toLowerCase()==='awaiting_driver_confirmation'&&
    !item.deleted&&!item.isDeleted&&!item.eliminado;
}

export function driverUberConfirmationMarkup(item,policy=globalThis.ExploraUberWeeklyPolicy) {
  const result=policy.calculate(item);
  return `<div class="uber-driver-confirmation-week">Semana ${escapeUi(item.weekStartDate)} al ${escapeUi(item.weekCloseDate)}</div>
    <div class="uber-driver-result-grid"><div><span>Efectivo que tenés</span><b>${escapeUi(money(result.cash))}</b></div><div><span>Digital recibido por Explora</span><b>${escapeUi(money(result.digital))}</b></div><div><span>Total Uber</span><b>${escapeUi(money(result.total))}</b></div><div><span>Caja chica Uber · 10%</span><b>${escapeUi(money(result.cashbox))}</b></div></div>
    <p class="uber-driver-confirmation-note">Al aceptar se incorporan estos importes a tus billeteras y se solicita el aviso escrito a Telegram. El saldo final se compensa con tus otros movimientos.</p>`;
}

export function mountAdminUberLiquidation({isAuthorized,getDrivers,register,onCompleted,policy=globalThis.ExploraUberWeeklyPolicy}) {
  const button=document.getElementById('adminUberLiquidationBtn');
  let dialog,busy=false,week,generation=0;
  const el=id=>dialog.querySelector('#'+id);
  const close=()=>{if(busy)return;generation++;dialog.close();button?.focus();};
  const fields=()=>({driverUid:el('adminUberNetDriver').value,cash:el('adminUberNetCash').value,digital:el('adminUberNetDigital').value});
  function preview(){
    el('adminUberNetStatus').textContent='';
    try{const data=adminUberInput({...fields(),driverUid:fields().driverUid||'preview'},week);el('adminUberNetReview').innerHTML=adminUberReview(policy.calculate(data));}
    catch{el('adminUberNetReview').textContent='Completá efectivo y digital. El total se suma automáticamente.';}
  }
  function ensure(){
    if(dialog)return;
    dialog=document.createElement('dialog');dialog.className='admin-uber-net-dialog';dialog.setAttribute('aria-labelledby','adminUberNetTitle');
    dialog.innerHTML=`<form id="adminUberNetForm" novalidate><header><div><p class="eyebrow">ADMINISTRACIÓN</p><h2 id="adminUberNetTitle">Cierre semanal de Uber</h2></div><button type="button" id="adminUberNetClose">Cerrar</button></header>
      <p id="adminUberNetWeek" class="admin-uber-net-week"></p>
      <p>Importes de la liquidación de Uber, con su comisión ya descontada.</p>
      <fieldset id="adminUberNetFields"><label>Chofer<select id="adminUberNetDriver" required></select></label>
      <div class="admin-uber-net-grid"><label>Efectivo retenido por el chofer<input id="adminUberNetCash" inputmode="decimal" type="text" placeholder="0,00" autocomplete="off" required></label><label>Digital neto de Explora<input id="adminUberNetDigital" inputmode="decimal" type="text" placeholder="0,00" autocomplete="off" required></label></div>
      </fieldset>
      <div id="adminUberNetReview" aria-live="polite"></div><p id="adminUberNetStatus" role="status" aria-live="polite"></p>
      <footer><button type="button" id="adminUberNetCancel">Cancelar</button><button type="submit" id="adminUberNetSave" class="save">Enviar al chofer</button></footer></form>`;
    document.body.append(dialog);
    el('adminUberNetClose').onclick=close;el('adminUberNetCancel').onclick=close;
    dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();else generation++;});
    el('adminUberNetFields').addEventListener('input',preview);
    el('adminUberNetForm').addEventListener('submit',async event=>{
      event.preventDefault();if(busy||!isAuthorized())return;
      let input;try{input=adminUberInput(fields(),week);}catch(error){el('adminUberNetStatus').textContent=error.message;return;}
      const seq=generation;busy=true;el('adminUberNetFields').disabled=true;el('adminUberNetSave').disabled=true;el('adminUberNetClose').disabled=true;el('adminUberNetCancel').disabled=true;dialog.setAttribute('aria-busy','true');el('adminUberNetStatus').textContent='Enviando al chofer…';
      try{
        const result=await register(input);if(seq!==generation||!isAuthorized())return;
        const completed=result.record?.driverConfirmed===true||result.record?.reviewStatus==='completed';
        el('adminUberNetStatus').textContent=completed?'Esta semana ya fue aceptada y está incluida en Billeteras.':result.alreadyRegistered?'Estos importes ya están esperando la aceptación del chofer.':'Enviado. El saldo se actualiza cuando el chofer toca Aceptar.';
        el('adminUberNetSave').textContent=completed?'Aceptado':'Esperando al chofer';onCompleted?.(result);
      }catch(error){if(seq===generation&&isAuthorized()){el('adminUberNetStatus').textContent=error.message||'No se pudo registrar el cierre. Podés reintentar.';el('adminUberNetFields').disabled=false;el('adminUberNetSave').disabled=false;}}
      finally{busy=false;dialog.removeAttribute('aria-busy');el('adminUberNetClose').disabled=false;el('adminUberNetCancel').disabled=false;}
    });
  }
  function open(){
    if(!isAuthorized())return;ensure();if(busy)return;generation++;week=adminUberWeek();el('adminUberNetForm').reset();el('adminUberNetFields').disabled=false;el('adminUberNetSave').disabled=false;el('adminUberNetSave').textContent='Enviar al chofer';
    el('adminUberNetWeek').textContent=`Semana ${week.weekStartDate} al ${week.weekCloseDate}`;
    const drivers=getDrivers();el('adminUberNetDriver').innerHTML='<option value="">Elegir chofer</option>'+drivers.map(driver=>`<option value="${escapeUi(driver.uid)}">${escapeUi(driver.name)}</option>`).join('');
    preview();dialog.showModal();el('adminUberNetDriver').focus();
  }
  button?.addEventListener('click',open);
  return {open,reset(){generation++;dialog?.close();}};
}
