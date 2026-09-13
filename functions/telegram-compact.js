"use strict";
const clean = (value, max = 180) => String(value ?? '').replace(/[\r\n\t]+/g,' ').trim().slice(0,max);
const money = value => new Intl.NumberFormat('es-AR',{style:'currency',currency:'ARS',minimumFractionDigits:0,maximumFractionDigits:2}).format(Number(value) || 0);
function balanceLine(value) {
  if (!Number.isFinite(Number(value))) return 'Saldo no disponible';
  const amount = Number(value);
  return amount > 0.5 ? `Chofer debe: ${money(amount)}` : amount < -0.5 ? `Explora debe: ${money(-amount)}` : 'Cuenta al día';
}
function billingSummary({data,driverName,amount,cash,balance}) {
  const route = data.invoiceRequest?.origin && data.invoiceRequest?.destination
    ? `${clean(data.invoiceRequest.origin,90)} → ${clean(data.invoiceRequest.destination,90)}`
    : clean(data.detail || data.notes || data.serviceDescription);
  const current = data.settlementRuleVersion === 'gross_cash_digital_cashbox_5_v1';
  const excluded = data.excludeFromCashbox || data.cashboxExcluded || data.cajaChicaEliminada || data.noCashbox;
  const cashbox = !excluded && (cash || current) ? amount * 0.05 : 0;
  return [cash ? '💵 Cobro en efectivo' : '💳 Cobro digital',`👤 ${clean(driverName)}`,
    ...(route ? [`📍 ${route}`] : []),'',`Cobro: ${money(amount)}`,
    ...(cashbox ? [`Caja chica 5%: ${money(cashbox)}`] : []),
    '',balanceLine(balance)].join('\n');
}
function expenseSummary({driverName,amount,recognized,balance,detail,refundRate}) {
  return [`⛽ Gasto${clean(detail) ? ` · ${clean(detail)}` : ''}`,`👤 ${clean(driverName)}`,'',
    `🔴 Gasto: ${money(amount)}`,
    ...(refundRate === 0 ? ['100% chofer · Sin reintegro'] : [`🟢 Reintegro${refundRate == null ? '' : ' '+refundRate*100+'%'}: ${money(recognized)}`]),
    '',balanceLine(balance)].join('\n');
}
function managementSummary({driverName,amount,paying,balance,note}) {
  return [paying ? '📤 Pago a Explora' : '📥 Cobro a Explora',`👤 ${clean(driverName)}`,
    `Importe: ${money(amount)}`,...(clean(note) ? [`Nota: ${clean(note)}`] : []),'',balanceLine(balance)].join('\n');
}
function uberSummary({data,driverName,balance}) {
  const amount = Number(data.grossAmount || data.totalAmount || data.amount || 0), box = amount * 0.05;
  return ['🚘 Liquidación Uber',`👤 ${clean(driverName)}`,`📅 ${clean(data.weekLabel || data.weekStartDate)}`,'',
    `Ganancia semanal: ${money(amount)}`,`Caja chica 5%: ${money(box)}`,'',balanceLine(balance)].join('\n');
}
function richMessage(text,{photo,document} = {}) {
  const blocks = String(text).split(/\n\n/).filter(Boolean).map(section => ({type:'paragraph',text:section.split('\n').flatMap((line,index) => [
    ...(index ? ['\n'] : []), /^(?:💵|💳|⛽|📤|📥|🚘|Chofer debe:|Explora debe:|Cuenta al día)/u.test(line) ? {type:'bold',text:line} : line
  ])}));
  if (photo) blocks.push({type:'photo',photo:{type:'photo',media:photo}});
  if (document) blocks.push({type:'document',document:{type:'document',media:document}});
  return {blocks};
}
function invoiceFilename(invoice) {
  const prefix = invoice.environment === 'production' ? 'FC' : 'PRUEBA-FC';
  return `${prefix}-${Number(invoice.issuer.pointOfSale)}-${Number(invoice.number)}.pdf`;
}
const calendarDate = value => /^20\d{2}-\d{2}-\d{2}$/.test(value || '') ? value.split('-').reverse().join('/') : 'Fecha no disponible';
function calendarSummary({driverName,serviceDate}) {
  return ['🗓 Viaje agendado',`👤 ${clean(driverName,120)}`,`📅 ${calendarDate(serviceDate)}`].join('\n');
}
function calendarCoincidenceSummary({driverName,serviceDate,coincidences,otherDrivers=[]}) {
  const names=otherDrivers.slice(0,3).map(name=>clean(name,120)).join(', ');
  return ['🗓 Coincidencia en Todos',`📅 ${calendarDate(serviceDate)}`,`👤 ${clean(driverName,120)}`,
    `Ya ${coincidences===1?'hay otro viaje':'hay otros '+coincidences+' viajes'} ese día.`,
    ...(names?[`Chofer${otherDrivers.length===1?'':'es'}: ${names}${otherDrivers.length>3?' y '+(otherDrivers.length-3)+' más':''}`]:[])].join('\n');
}
module.exports = {balanceLine,billingSummary,expenseSummary,managementSummary,uberSummary,richMessage,invoiceFilename,calendarSummary,calendarCoincidenceSummary};
