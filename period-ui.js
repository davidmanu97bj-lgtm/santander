import {exploraIcon,escapeUi} from './explora-ui.js?v=20260919-login-period-1';
const money=value=>new Intl.NumberFormat('es-AR',{style:'currency',currency:'ARS',minimumFractionDigits:0,maximumFractionDigits:2}).format(Number(value)||0);
const row=(label,value,total=false,subtitle='')=>`<div class="period-row${total?' period-total':''}"><span>${escapeUi(label)}${subtitle?`<small class="period-row-subtitle">${escapeUi(subtitle)}</small>`:''}</span><strong>${escapeUi(money(value))}</strong></div>`;
function section(tone,icon,title,description,body){return `<section class="period-section ${tone}"><div class="period-section-label"><span class="period-section-icons">${exploraIcon(icon)}${tone==='uber'?'<img class="period-uber-logo" src="./assets/uber-logo.svg" alt="" width="34" height="12">':''}</span><h2>${title}</h2><p>${description}</p></div><div class="period-section-data">${body}</div></section>`;}
const round=value=>Math.round((Number(value)||0)*100)/100;
const paymentMessage=(balance,reason)=>Math.abs(balance)<=.005
  ? `<div class="period-instruction"><strong>Sin importe pendiente</strong><small>${escapeUi(reason)}</small></div>`
  : `<div class="period-instruction"><strong>${balance>0?'Pasale':'Explora te pasa'} <span>${escapeUi(money(Math.abs(balance)))}</span>${balance>0?' a Explora':''}</strong><small>${escapeUi(reason)}</small></div>`;

// Present the wallet equalization and every debt separately. An expense already
// deducted from a wallet is compensated explicitly, so it cannot be charged twice.
export function periodBreakdown(quote) {
  const s=quote.summary;
  const ordinary=quote.presentation?.ordinary;
  const uber=quote.presentation?.uber;
  const cashbox=ordinary?ordinary.cashbox:s.cashbox;
  const uberCashbox=ordinary?Number(uber?.cashboxInPeriod||0):0;
  const walletDifference=ordinary?round(ordinary.walletDifference+Number(uber?.walletDifference||0)):s.walletDifference;
  const previousBalance=ordinary?Number(quote.presentation.previousBalance||0):s.previousBalance;
  const roundingAdjustment=ordinary?Number(quote.presentation.roundingAdjustment||0):0;
  const debts=[...(s.debtRows||[]),...(s.externalDebtRows||[])];
  const detailedExternal=round((s.externalDebtRows||[]).reduce((sum,debt)=>sum+debt.amount,0));
  const otherExternal=round((s.externalDebt||0)-detailedExternal);
  if(otherExternal>0)debts.push({label:'tu deuda',amount:otherExternal});
  const expenseDebt=round((s.debtRows||[]).reduce((sum,debt)=>sum+debt.amount,0));
  const compensation=round((s.responsibilityAdjustment||0)-expenseDebt);
  const lines=[{label:'Debés de caja chica',balance:cashbox},
    {label:'Debés de caja chica Uber',balance:uberCashbox},
    ...debts.map(debt=>({label:`Debés de ${debt.label.toLocaleLowerCase('es-AR')}`,balance:debt.amount})),
    {label:walletDifference<0?'Explora te debe de billetera':'Debés de billetera',balance:walletDifference}];
  if(Math.abs(compensation)>.005)lines.push({label:compensation<0?'Compensación a tu favor por gastos de billetera':'Compensación a Explora por gastos de billetera',balance:compensation});
  lines.push({label:previousBalance<0?'Explora te debe de saldo anterior':'Debés de saldo anterior',balance:previousBalance});
  if(Math.abs(roundingAdjustment)>.005)lines.push({label:roundingAdjustment<0?'Ajuste de redondeo a tu favor':'Ajuste de redondeo a favor de Explora',balance:roundingAdjustment});
  if(Math.abs(previousBalance)>.005)debts.push({label:previousBalance>0?'Deuda del saldo anterior':'Saldo anterior a tu favor',amount:previousBalance});
  return {debts,debtTotal:round(debts.reduce((sum,debt)=>sum+debt.amount,0)),lines,
    walletTarget:ordinary?ordinary.walletTarget:round((s.netCash+s.netDigital)/2),compensation,
    ordinary:ordinary||s,cashbox,uberCashbox,walletDifference,previousBalance};
}
export function uberPeriodMarkup(uber) {
  if(!uber)return section('uber','cash','UBER','Cierre semanal<br>cargado por Admin','<p class="period-uber-note">El detalle de Uber estará disponible al actualizar la consulta.</p>');
  const unknown=Number(uber.unavailableCount||0)>0;
  const amounts=unknown
    ? row('Total cobrado efectivo (con desglose)',uber.cash)+row('Total cobrado digital (con desglose)',uber.digital)+row('Total anterior sin desglose',uber.unavailableTotal)
    : row('Total cobrado efectivo',uber.cash)+row('Total cobrado digital',uber.digital);
  const principal=Number(uber.walletDifference??round((uber.cash-uber.digital)/2));
  const target=Number(uber.walletTarget??round((uber.cash+uber.digital)/2));
  return section('uber','cash','UBER','Efectivo: chofer<br>Digital: Explora',amounts+
    row('TOTAL UBER',uber.total,true)+
    paymentMessage(principal,`Para que ambos tengan ${money(target)} en sus billeteras de Uber${unknown?' con desglose':''}.`)+
    (unknown?'<p class="period-uber-note">Desglose no disponible para liquidaciones anteriores. Su saldo se conserva en el saldo anterior; no se recalcula.</p>':'')+
    '<p class="period-uber-note">El 10% va a Caja chica. Esta compensación y la caja se suman una sola vez en el Resumen.</p>');
}
export function periodMarkup(quote) {
  const s=quote.summary,driverPays=quote.balance>0.5,balanced=quote.amount<=.5;
  const breakdown=periodBreakdown(quote);
  const ordinary=breakdown.ordinary;
  const walletMessage=paymentMessage(ordinary.walletDifference,`Para que ambos tengan ${money(breakdown.walletTarget)} en sus billeteras.`);
  return section('cash','cash','Efectivo','Viajes de Explora<br>en mano',row('Total cobrado',ordinary.cash)+row('Total gastado',-ordinary.cashExpense)+row('NETO EFECTIVO',ordinary.netCash,true)+(ordinary.walletDifference>.005?walletMessage:''))+
    section('digital','digital','Digital','Tarjeta,<br>transferencia o QR',row('Total cobrado',ordinary.digital)+row('Total gastado',-ordinary.digitalExpense)+row('NETO DIGITAL',ordinary.netDigital,true)+(ordinary.walletDifference<-.005?walletMessage:''))+
    uberPeriodMarkup(quote.presentation?.uber)+
    section('cashbox','expense','Caja chica','10% sobre el<br>total cobrado',row('Total caja chica · 10% facturación total',breakdown.cashbox,false,'Viajes de Explora, sin Uber')+row('Total caja chica · 10% facturación total Uber',breakdown.uberCashbox,false,'Sobre el total Uber cargado')+paymentMessage(round(breakdown.cashbox+breakdown.uberCashbox),'De caja chica.'))+
    section('debts','debt','Deudas','Gastos a cargo<br>del chofer (100%)',
      (breakdown.debts.length?breakdown.debts.map(debt=>row(debt.label,debt.amount)).join(''):row('Deudas pendientes',0))+
      row('TOTAL DEUDA',breakdown.debtTotal,true)+
      paymentMessage(breakdown.debtTotal,breakdown.debtTotal<0?'Por la deuda de Explora con vos.':'Por tu deuda.'))+
    section('period-summary','management','Resumen','Un único<br>cierre',
      breakdown.lines.map(line=>row(line.label,Math.abs(line.balance))).join('')+
      row(balanced?'CUENTAS EQUILIBRADAS':driverPays?'PÁSALE A EXPLORA':'EXPLORA TE PASA',quote.amount,true)+
      `<div class="period-closed-note"><span aria-hidden="true">✓</span><small>${balanced?'Todo está cerrado.':'Y queda todo cerrado.'}</small></div>`);
}
export function mountPeriodClose({getQuote,uploadProof,confirmClose,showScreen,onCompleted}) {
  const $=id=>document.getElementById(id),modal=$('periodReceiptModal');
  let quote=null,busy=false,openGeneration=0,uploadedProofPath='';
  const status=text=>{$('periodReceiptStatus').textContent=text;};
  function setBusy(value){busy=value;modal.setAttribute('aria-busy',String(value));for(const id of ['periodReceiptFile','dismissPeriodReceipt','cancelPeriodReceipt'])$(id).disabled=value;$('acceptPeriodReceipt').disabled=value||!uploadedProofPath;modal.querySelector('.receipt-file-label').setAttribute('aria-disabled',String(value));}
  function dismiss(){if(busy)return;modal.classList.add('hidden');$('periodReceiptFile').value='';uploadedProofPath='';setBusy(false);status('');$('confirmPeriodClose').focus();}
  async function open(){
    const generation=++openGeneration;quote=null;uploadedProofPath='';setBusy(false);showScreen('period');
    $('periodDate').textContent=new Date().toLocaleDateString('es-AR',{day:'numeric',month:'short',year:'numeric'});
    $('periodSections').innerHTML='';$('periodSections').setAttribute('aria-busy','true');
    $('periodStatus').innerHTML=`<span class="period-loading"><span class="period-loading-symbol" aria-hidden="true">${exploraIcon('wallet')}</span><span>Cargando tu período…</span></span>`;
    $('confirmPeriodClose').disabled=true;
    try{const result=await getQuote();if(generation!==openGeneration)return;quote=result;$('periodSections').innerHTML=periodMarkup(quote);$('periodStatus').textContent='';$('confirmPeriodClose').disabled=quote.amount<=.5;}
    catch(error){if(generation===openGeneration)$('periodStatus').textContent=error.message||'No se pudo consultar el cierre. Volvé a intentarlo.';}
    finally{if(generation===openGeneration)$('periodSections').setAttribute('aria-busy','false');}
  }
  $('openPeriodClose').addEventListener('click',open);
  $('confirmPeriodClose').addEventListener('click',()=>{if(!quote||busy||quote.amount<=.5)return;status('');modal.classList.remove('hidden');modal.querySelector('.receipt-file-label').focus();});
  $('dismissPeriodReceipt').addEventListener('click',dismiss);$('cancelPeriodReceipt').addEventListener('click',dismiss);
  modal.addEventListener('click',event=>{if(event.target===modal)dismiss();});
  const label=modal.querySelector('.receipt-file-label');
  label.addEventListener('click',event=>{if(busy)event.preventDefault();});
  label.addEventListener('keydown',event=>{if(['Enter',' '].includes(event.key)){event.preventDefault();if(!busy)$('periodReceiptFile').click();}});
  modal.addEventListener('keydown',event=>{
    if(event.key==='Escape'){event.preventDefault();dismiss();}
    if(event.key==='Tab'){const controls=[...modal.querySelectorAll('button,[tabindex="0"]')].filter(el=>!el.disabled);if(event.shiftKey&&document.activeElement===controls[0]){event.preventDefault();controls.at(-1).focus();}else if(!event.shiftKey&&document.activeElement===controls.at(-1)){event.preventDefault();controls[0].focus();}}
  });
  $('periodReceiptFile').addEventListener('change',async event=>{
    const file=event.target.files?.[0];event.target.value='';
    if(!file||busy||!quote)return;
    uploadedProofPath='';setBusy(false);
    if(!/^(image\/(jpeg|png|webp|heic|heif)|application\/pdf)$/.test(file.type)||!file.size||file.size>15*1024*1024){status('Elegí una imagen o PDF de hasta 15 MB.');return;}
    setBusy(true);status('Cargando comprobante…');
    try {
      uploadedProofPath=await uploadProof(file,quote.quoteId);
      status(`Comprobante cargado: ${file.name}. Tocá “Aceptar y cerrar” para finalizar.`);
    } catch(error){status(error.message||'No se pudo cargar el comprobante. Volvé a intentarlo.');}
    finally{setBusy(false);}
  });
  $('acceptPeriodReceipt').addEventListener('click',async()=>{
    if(busy||!quote||!uploadedProofPath)return;
    setBusy(true);status('Confirmando cierre…');
    try {
      await confirmClose({quoteId:quote.quoteId,proofPath:uploadedProofPath});
      setBusy(false);dismiss();await open();$('periodStatus').textContent='Cierre confirmado. El comprobante quedó asociado al cierre.';onCompleted?.();
    } catch(error){status(error.message||'No se pudo confirmar. Volvé a tocar “Aceptar y cerrar” para reintentar.');}
    finally{setBusy(false);}
  });
  return {open};
}
