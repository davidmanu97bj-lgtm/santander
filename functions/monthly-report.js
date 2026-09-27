'use strict';
const {createHash}=require('node:crypto');

const periodPolicy=require('./period-policy');
const collections={cobros:'billing_records',gastos:'gastos',cierres:'cierres_semanales',deudas:'deudas_choferes',pagosDeuda:'deuda_pagos',adelantos:'prestamos_operativos',uber:'uber_weekly_closures'};
const owners=['driverUid','choferUid','uid','ownerUid','driverId','choferId','userUid','operatorUid'];
const clean=value=>String(value??'').replace(/[\r\n\t]+/g,' ').slice(0,1000);
const round=n=>Math.round((n+Number.EPSILON)*100)/100;
const amount=r=>Number(r.amount??r.monto??r.grossAmount??r.totalAmount??r.principalAmount??0)||0;
const stamp=r=>Number(r.createdAtMs)||r.createdAt?.toMillis?.()||Date.parse(r.createdAt)||0;
const localDate=ms=>ms ? new Intl.DateTimeFormat('en-CA',{timeZone:'America/Argentina/Buenos_Aires',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(ms)) : '';
const method=r=>/cash|efectivo/.test(String(r.method||r.paymentMethod||''))?'Efectivo':'Digital';
const inactive=r=>r.deleted||r.isDeleted||r.eliminado||/cancel|anulad|reject|rechaz|deleted/.test(r.status||r.reviewStatus||'');
const serviceDate=r=>/^\d{4}-\d{2}-\d{2}$/.test(r.invoiceRequest?.serviceDate||r.serviceDate||'') ? (r.invoiceRequest?.serviceDate||r.serviceDate) : localDate(stamp(r));
const proof=r=>{const url=r.proofUrl||r.receiptUrl||r.comprobanteUrl||'';return /^https?:\/\//.test(url)?url:'';};
const formatCuit=value=>{const digits=String(value||'').replace(/\D/g,'');return digits.length===11?`${digits.slice(0,2)}-${digits.slice(2,10)}-${digits.slice(10)}`:'';};
function buildMonthlyReport({uid,profile={},month,input,now=Date.now(),explora={}}) {
  if(!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month))throw new Error('Elegí un mes válido.');
  const current=localDate(now).slice(0,7);if(month>current)throw new Error('El mes todavía no comenzó.');
  const rows=[],issues=[];let cash=0,digital=0,cashbox=0;
  const add=(group,r,date,extra={})=>rows.push({group,id:r.id,date,dateRegistered:localDate(stamp(r)),amount:round(amount(r)),detail:clean(r.detail||r.notes||r.reason||r.description||r.service||r.expenseLabel||r.expenseType||group),status:clean(r.status||r.reviewStatus||'sin estado'),proof:proof(r),...extra});
  const acceptedClosures=new Set((input.cierres||[]).filter(r=>!inactive(r)&&['completed','paid','approved'].includes(r.status)).map(r=>r.id));
  for(const [source,records] of Object.entries(input))for(const r of records) {
    const charge=source==='cobros'&&['billing','payment'].includes(r.type)&&!r.internalSettlementAdjustment&&!r.excludeFromBillingGross;
    const date=charge?serviceDate(r):source==='uber'?(r.weekEndDate||r.weekEnd||localDate(stamp(r))):localDate(stamp(r));
    if(!date){issues.push(`${source}/${r.id}: sin fecha; revisar antes de facturar.`);continue;}
    if(String(date).slice(0,7)!==month)continue;
    if(charge) {
      const included=!inactive(r)&&['completed','paid','approved'].includes(r.status)&&amount(r)>0;
      const box=included&&!r.excludeFromCashbox&&!r.cashboxExcluded&&!r.cajaChicaEliminada&&!r.noCashbox&&(method(r)==='Efectivo'||periodPolicy.isNew(r)||r.settlementRuleVersion==='gross_cash_digital_cashbox_5_v1')?round(amount(r)*periodPolicy.cashboxRate(r)):0;
      if(included){if(method(r)==='Efectivo')cash+=amount(r);else digital+=amount(r);cashbox+=box;}
      else if(!inactive(r))issues.push(`Cobro ${r.id}: pendiente o importe inválido; no incluido en el bruto.`);
      const route=r.invoiceRequest?.origin&&r.invoiceRequest?.destination?`${r.invoiceRequest.origin} - ${r.invoiceRequest.destination}`:r.service||r.detail;
      add('Cobros de viajes',r,date,{included,cashbox:box,method:method(r),detail:clean(route),fiscalReference:clean(r.invoiceId||r.arcaInvoiceId||''),dateBasis:r.invoiceRequest?.serviceDate||r.serviceDate?'Fecha del servicio':'Fecha de registro (sin fecha de servicio)'});
    } else if(source==='uber') {
      const included=!inactive(r)&&((r.verifiedAutomatically&&r.reviewStatus==='completed')||(r.adminConfirmed&&['approved','completed'].includes(r.reviewStatus||r.status)));
      if(included){cash+=Number(r.grossAmount??r.amount??0);cashbox+=round(Number(r.grossAmount??r.amount??0)*periodPolicy.cashboxRate(r));}
      else if(!inactive(r))issues.push(`Uber ${r.id}: pendiente; no incluido en el bruto.`);
      add('Liquidaciones Uber',r,date,{amount:Number(r.grossAmount??r.amount??0),included,method:'Efectivo',dateBasis:'Semana imputada al mes de finalización; revisar semanas que cruzan meses'});
    } else if(source==='gastos')add('Gastos',r,date,{method:r.expensePaymentMethod==='digital'?'Digital - pagado por Explora':'Efectivo - pagado por el chofer',responsibility:clean(r.expenseResponsibility||'Ver categoría')});
    else if(source==='cierres')add('Cierres',r,date,{amount:Number(r.settlementAmount??r.paidAmountTotal??r.requestedPaymentAmount??r.amount??0),direction:clean(r.paymentDirection||r.direction),summary:r.settlementSummary||null});
    else if(source==='cobros'||source==='pagosDeuda')add('Pagos y compensaciones',r,date,{direction:clean(r.adjustmentDirection||r.paymentDirection||r.settlementDirection),linkedClosure:clean(r.closureId),includedInClosure:acceptedClosures.has(r.closureId),method:method(r)});
    else if(source==='deudas')add('Deudas',r,date,{remaining:Number(r.remainingAmount??r.saldoPendiente??amount(r)),acknowledged:r.acknowledgedByDriver===true});
    else if(source==='adelantos')add('Adelantos y préstamos',r,date,{remaining:Number(r.remainingAmount??r.totalDebt??0)});
  }
  rows.sort((a,b)=>a.date.localeCompare(b.date)||a.id.localeCompare(b.id));
  const gross=round(cash+digital),participation=round(gross*.4);
  const recipient={legalName:clean(explora.legalName||'Explora Iguazú Viajes y Servicios'),cuit:formatCuit(explora.cuit||'20-40411688-7'),address:clean(explora.address||'')};
  const invoiceDetail=`Servicios de conducción y participación comercial - ${month}. Participación del 40% sobre la facturación bruta generada para Explora.`;
  const report={version:'monthly_gross_40_v1',uid,driverName:clean(profile.displayName||profile.nombre||profile.username||'Chofer'),driverCuit:clean(profile.cuit||''),month,closedMonth:month<current,generatedAtMs:now,totals:{cash:round(cash),digital:round(digital),gross,cashbox:round(cashbox),rate:40,participation},recipient,invoiceDetail,issues,rows,
    explanation:'Según la participación comercial indicada por Explora, el chofer factura el 40% de la facturación bruta de sus viajes del mes. Gastos, caja chica, multas, deudas, préstamos y transferencias se informan para conciliar movimientos, pero no reducen esta base ni se suman como nuevos cobros. El resumen no es una factura fiscal ni acredita su emisión.',
    criteria:'Viajes por fecha de servicio; cuando falta, por fecha de registro, identificado en el detalle. Cierres, pagos y gastos por fecha de registro. Cada cierre se informa completo aunque incluya operaciones de otro mes; no se usa como base del 40%. Los ajustes vinculados a un cierre son su contrapartida, no otro pago. Saldos de deuda mostrados al generar el informe, no reconstruidos al último día del mes.'};
  report.revision=createHash('sha256').update(JSON.stringify({...report,generatedAtMs:0})).digest('hex');return report;
}
async function loadMonthlyReport(db,uid,month,now=Date.now()) {
  return db.runTransaction(async tx=>{
  const input={};
  for(const [key,collection] of Object.entries(collections)) {
    const rows=new Map();for(const field of owners){const snap=await tx.get(db.collection(collection).where(field,'==',uid));for(const row of snap.docs){const data=row.data();if(data.driverUid&&data.driverUid!==uid)continue;rows.set(row.id,{...data,id:row.id});}}input[key]=[...rows.values()];
  }
  const profile=(await tx.get(db.collection('usuarios').doc(uid))).data()||(await tx.get(db.collection('choferes').doc(uid))).data()||{};
  const fiscal=(await tx.get(db.collection('arca_settings').doc('current'))).data()||{};
  return buildMonthlyReport({uid,profile,month,input,now,explora:{legalName:fiscal.legalName||process.env.ARCA_ISSUER_LEGAL_NAME,address:fiscal.address||process.env.ARCA_ISSUER_ADDRESS,cuit:fiscal.cuit||process.env.ARCA_ISSUER_CUIT}});
  });
}
const monthlyPdf=require('./monthly-summary-pdf');
module.exports={buildMonthlyReport,loadMonthlyReport,monthlyPdf};
