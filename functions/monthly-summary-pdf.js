'use strict';
const PDFDocument=require('pdfkit');
const clean=value=>String(value??'').replace(/[\r\n\t]+/g,' ').replace(/[–—]/g,'-');
const money=n=>new Intl.NumberFormat('es-AR',{style:'currency',currency:'ARS',maximumFractionDigits:2}).format(n||0);
module.exports=async function monthlyPdf(report){
  const doc=new PDFDocument({size:'A4',margin:44,bufferPages:true,info:{Title:`Resumen para contadora - ${report.driverName} - ${report.month}`}}),chunks=[];
  const done=new Promise((resolve,reject)=>{doc.on('data',b=>chunks.push(b));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);});
  const width=507;
  function text(value,size=10,color='#344e5c'){doc.font('Helvetica').fontSize(size).fillColor(color).text(clean(value),{width,lineGap:3});}
  function heading(value){doc.moveDown(.8).font('Helvetica-Bold').fontSize(12).fillColor('#143c50').text(value,{width});doc.moveDown(.35);}
  doc.font('Helvetica-Bold').fontSize(24).fillColor('#143c50').text('EXPLORA');
  doc.font('Helvetica').fontSize(13).text(report.fiscalComplete===false?'Resumen mensual para revisar':'Resumen mensual para facturar');doc.moveDown(.8);
  text(`${report.driverName}${report.driverCuit?' | CUIT '+report.driverCuit:''}`,11);
  text(`Período: ${report.month} | ${report.closedMonth?'Mes finalizado':'PROVISIONAL - mes en curso'}`);
  if(report.fiscalComplete===false)text('BASE MENSUAL INCOMPLETA: falta el bruto fiscal de Uber. Los netos conciliados sirven para Billeteras; el subtotal siguiente no es el importe final para emitir una factura.',10,'#a44718');
  heading(report.fiscalComplete===false?'Subtotal conocido - base incompleta':'Importe a facturar a Explora');
  const boxY=doc.y;doc.roundedRect(44,boxY,width,72,10).fill('#eaf4f0');
  doc.font('Helvetica-Bold').fontSize(27).fillColor('#155945').text(money(report.totals.participation),60,boxY+12,{width:475});
  doc.font('Helvetica').fontSize(10).text(`${money(report.totals.gross)} de bruto x ${report.totals.rate||40}% de participación`,60,boxY+49,{width:475});
  doc.x=44;doc.y=boxY+86;
  const lines=[[report.fiscalComplete===false?'Efectivo con bruto fiscal disponible':'Cobros en efectivo (incluye Uber aceptado)',report.totals.cash],['Cobros digitales',report.totals.digital],[report.fiscalComplete===false?'Bruto conocido del mes':'Bruto del mes',report.totals.gross]];
  for(const [label,value] of lines){const y=doc.y;doc.font('Helvetica').fontSize(10).fillColor('#344e5c').text(label,44,y,{width:350});doc.font('Helvetica-Bold').text(money(value),394,y,{width:157,align:'right'});doc.y=y+22;doc.x=44;}
  heading('Datos para la factura');
  text(`Receptor: ${report.recipient.legalName}`);text(`CUIT: ${report.recipient.cuit||'Por confirmar'}`);
  if(report.recipient.address)text(`Domicilio: ${report.recipient.address}`);
  text(`Concepto sugerido: ${report.invoiceDetail}`);
  doc.moveDown(.35);text('La contadora debe verificar el tipo de comprobante y la condición fiscal de ambas partes antes de emitir.',9);
  heading('Criterio de cálculo');
  text('Explora factura al pasajero el 100% del viaje. El chofer emite a Explora su factura por el 40% del bruto de sus viajes.',9);
  text(report.fiscalComplete===false?'La base parcial excluye los netos Uber sin bruto fiscal. Gastos, caja chica, deudas y rendiciones no se descuentan del 40% ni se suman como nuevos ingresos.':'La base incluye los cobros de viajes y Uber aceptados. Gastos, caja chica, deudas y rendiciones no se descuentan del 40% ni se suman como nuevos ingresos.',9);
  text('Se usa la fecha del servicio; si falta, la fecha de registro. Uber se imputa al mes en que termina la semana liquidada. Este importe no representa el saldo a cobrar o rendir.',9);
  heading(report.issues.length?'Observaciones que requieren revisión':'Control del resumen');
  if(!report.issues.length)text('Sin observaciones detectadas por el sistema. El detalle de movimientos está disponible en Gestión.',9);
  else {
    text(`${report.issues.length} observación(es). Revisar antes de emitir la factura.`,9);
    report.issues.forEach((issue,index)=>{const line=`${index+1}. ${clean(issue)}`;doc.font('Helvetica').fontSize(9);if(doc.y+doc.heightOfString(line,{width,lineGap:3})>748){doc.addPage();heading('Observaciones - continuación');}text(line,9);});
  }
  if(doc.y>710)doc.addPage();
  doc.moveDown(.8);text('Resumen informativo, no fiscal. Adjuntar la factura emitida por separado.',9);
  text(`Generado: ${new Date(report.generatedAtMs).toLocaleString('es-AR',{timeZone:'America/Argentina/Buenos_Aires'})} | Revisión: ${report.revision.slice(0,12)}`,8,'#647a86');
  const pages=doc.bufferedPageRange();for(let i=0;i<pages.count;i++){doc.switchToPage(i);doc.font('Helvetica').fontSize(8).fillColor('#647a86').text(`EXPLORA | ${report.month} | ${i+1} / ${pages.count}`,44,795,{lineBreak:false});}
  doc.end();return done;
};
