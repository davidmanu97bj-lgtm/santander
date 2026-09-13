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
    ...(cashbox ? [`Caja chica 5%: ${money(cashbox)}`,`Total con caja: ${cash ? '' : '−'}${money(cash ? amount+cashbox : amount-cashbox)}`] : []),
    '',balanceLine(balance)].join('\n');
}
function expenseSummary({driverName,amount,recognized,balance,detail}) {
  return [`⛽ Gasto${clean(detail) ? ` · ${clean(detail)}` : ''}`,`👤 ${clean(driverName)}`,'',
    `🔴 Gasto: ${money(amount)}`,`🟢 Reintegro: ${money(recognized)}`,'',balanceLine(balance)].join('\n');
}
function managementSummary({driverName,amount,paying,balance,note}) {
  return [paying ? '📤 Pago a Explora' : '📥 Cobro a Explora',`👤 ${clean(driverName)}`,
    `Importe: ${money(amount)}`,...(clean(note) ? [`Nota: ${clean(note)}`] : []),'',balanceLine(balance)].join('\n');
}
function uberSummary({data,driverName,balance}) {
  const amount = Number(data.grossAmount || data.totalAmount || data.amount || 0), box = amount * 0.05;
  return ['🚘 Liquidación Uber',`👤 ${clean(driverName)}`,`📅 ${clean(data.weekLabel || data.weekStartDate)}`,'',
    `Ganancia semanal: ${money(amount)}`,`Caja chica 5%: ${money(box)}`,`Total con caja: ${money(amount+box)}`,'',balanceLine(balance)].join('\n');
}
function richMessage(text,{photo,document} = {}) {
  const blocks = String(text).split(/\n\n/).filter(Boolean).map(section => ({type:'paragraph',text:section.split('\n').flatMap((line,index) => [
    ...(index ? ['\n'] : []), /^(?:💵|💳|⛽|📤|📥|🚘|Total con caja:|Chofer debe:|Explora debe:|Cuenta al día)/u.test(line) ? {type:'bold',text:line} : line
  ])}));
  if (photo) blocks.push({type:'photo',photo:{type:'photo',media:photo}});
  if (document) blocks.push({type:'document',document:{type:'document',media:document}});
  return {blocks};
}
function invoiceFilename(invoice) {
  const prefix = invoice.environment === 'production' ? 'FC' : 'PRUEBA-FC';
  return `${prefix}-${Number(invoice.issuer.pointOfSale)}-${Number(invoice.number)}.pdf`;
}
module.exports = {balanceLine,billingSummary,expenseSummary,managementSummary,uberSummary,richMessage,invoiceFilename};
