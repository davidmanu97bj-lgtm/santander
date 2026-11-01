'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {inflateSync}=require('node:zlib');
const {invoicePdf,qrUrl}=require('../arca-pdf');
const fixture=()=>({status:'authorized',invoiceType:11,issuerRegime:'iva_exento',number:1,
  cae:'12345678901234',caeExpires:'20261111',environment:'homologation',
  issuer:{cuit:'20123456786',pointOfSale:5,legalName:'EMISOR DE PRUEBA',address:'Domicilio de prueba',grossIncomeId:'Prueba',activityStart:'2024-01-01'},
  detail:{CbteFch:'20261101',FchServDesde:'20261101',FchServHasta:'20261101',FchVtoPago:'20261101',
    ImpTotal:32500,ImpNeto:32500,ImpOpEx:0,ImpIVA:0,DocTipo:80,DocNro:'20123456786',CondicionIVAReceptorId:1,MonId:'PES',MonCotiz:1},
  customer:{name:'EMPRESA DE PRUEBA'},description:'Traslado de prueba',paymentMethod:'digital'});
function renderedText(pdf){
  const binary=pdf.toString('latin1'),parts=[];
  for(const match of binary.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)){
    let text;try{text=inflateSync(Buffer.from(match[1],'latin1')).toString('latin1');}catch{continue;}
    for(const hex of text.matchAll(/<([0-9a-f]+)>/gi))parts.push(Buffer.from(hex[1],'hex').toString('latin1'));
  }
  return parts.join('');
}
test('PDF C nuevo muestra IVA Exento y no Monotributo; QR mantiene C, serie y total',async()=>{
  const invoice=fixture(),before=JSON.stringify(invoice),pdf=await invoicePdf(invoice),text=renderedText(pdf);
  assert.equal(pdf.subarray(0,4).toString(),'%PDF');assert.match(text,/FACTURA C/);assert.match(text,/IVA Exento/);
  assert.doesNotMatch(text,/Responsable Monotributo|IVA Responsable Inscripto/);
  assert.match(text,/Responsable inscripto/);assert.match(text,/EMPRESA DE PRUEBA/);assert.match(text,/32.500,00/);
  const qr=JSON.parse(Buffer.from(new URL(qrUrl(invoice)).searchParams.get('p'),'base64'));
  assert.equal(qr.tipoCmp,11);assert.equal(qr.ptoVta,5);assert.equal(qr.importe,32500);assert.equal(qr.nroCmp,1);
  assert.equal(JSON.stringify(invoice),before);
});
test('PDF conserva C histórica sin snapshot y A/B de responsable inscripto',async()=>{
  for(const regime of [undefined,'monotributo']){
    const invoice={...fixture(),issuerRegime:regime,invoiceType:regime===undefined?undefined:11};
    const text=renderedText(await invoicePdf(invoice));assert.match(text,/Responsable Monotributo/);assert.doesNotMatch(text,/IVA Exento/);
  }
  for(const [type,letter]of [[1,'A'],[6,'B']]){
    const invoice={...fixture(),invoiceType:type,issuerRegime:'general'};invoice.detail.ImpNeto=0;invoice.detail.ImpOpEx=32500;
    const text=renderedText(await invoicePdf(invoice));assert.match(text,new RegExp(`FACTURA ${letter}`));assert.match(text,/IVA Responsable Inscripto/);assert.doesNotMatch(text,/IVA Exento/);
  }
});
test('no imprime C con régimen contradictorio ni A/B con snapshot exento',async()=>{
  for(const change of [{issuerRegime:'general'},{issuerRegime:'unknown'},{invoiceType:1},{invoiceType:6},{status:'review'}]){
    await assert.rejects(invoicePdf({...fixture(),...change}));
  }
});
