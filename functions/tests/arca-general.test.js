'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {buildInvoice,matchesAuthorized,authorizationFromResponse}=require('../arca-invoice');
const {enqueueInvoice,processInvoice,seriesKey,enabled}=require('../arca-worker');
const {DOMESTIC_EXEMPT_POLICY,INTERNATIONAL_EXEMPT_POLICY,internationalBEnabled}=require('../arca-policy');
const {createArcaClient}=require('../arca-client');
const {invoicePdf,qrUrl}=require('../arca-pdf');
const {invoiceFilename}=require('../telegram-compact');
const NOW=Date.parse('2026-09-23T18:00:00Z');
const config={enabled:true,environment:'homologation',regime:'general',invoiceType:6,
  approvedDriverUids:['test-driver'],
  taxPolicy:DOMESTIC_EXEMPT_POLICY,domesticTaxiExemptionVerified:true,exclusivePointOfSale:true,
  pointEmissionType:'CAE - Ri Iva',pointOfSale:3,cuit:'20123456786',legalName:'EMISOR DE PRUEBA',
  address:'Domicilio de prueba',grossIncomeId:'Dato de prueba',activityStart:'2024-01-01',activeFrom:'2026-09-23T00:00:00-03:00'};
const payment=()=>({driverUid:'test-driver',type:'billing',method:'cash',status:'completed',amount:100000,
  createdAt:{toMillis:()=>NOW},invoiceRequest:{version:'arca_c_v1',serviceDate:'2026-09-23',
    scope:'national',origin:'Origen de prueba',destination:'Destino de prueba',distanceKm:20,customer:{}}});
function memoryDb(){
  const data=new Map();let pending=Promise.resolve();const ref=(c,id)=>({id,path:c+'/'+id});
  return {data,collection:c=>({doc:id=>ref(c,id)}),runTransaction:fn=>{
    const result=pending.then(async()=>{const writes=[];const result=await fn({
      get:async r=>({exists:data.has(r.path),data:()=>data.get(r.path)}),
      create:(r,d)=>{assert.ok(!data.has(r.path));writes.push([r.path,d]);},
      set:(r,d,opt)=>writes.push([r.path,opt?.merge?{...data.get(r.path),...d}:d]),
      update:(r,d)=>writes.push([r.path,{...data.get(r.path),...d}])});
      for(const [k,v] of writes)data.set(k,v);return result;});pending=result.catch(()=>{});return result;
  }};
}
const response=(d,type=6)=>({header:{Resultado:'A',PtoVta:3,CbteTipo:type,CantReg:1},
  detail:{Resultado:'A',CbteDesde:d.CbteDesde,CbteHasta:d.CbteHasta,CAE:'12345678901234',CAEFchVto:'20261003'}});
function api(){let calls=0,last=0;const issued=new Map(),trace=[];return {issued,trace,get calls(){return calls;},
  points:async()=>[{Nro:3,Bloqueado:'N',FchBaja:'NULL',EmisionTipo:'CAE - Ri Iva'}],
  last:async(p,t)=>{trace.push(['last',p,t]);return last;},
  consult:async(p,n,t)=>{trace.push(['consult',p,n,t]);return issued.get(n)||null;},
  authorize:async(p,d,t)=>{calls++;trace.push(['authorize',p,t]);last=d.CbteDesde;
    issued.set(last,{...d,Resultado:'A',EmisionTipo:'CAE',PtoVta:p,CbteTipo:t,CodAutorizacion:'12345678901234',FchVto:'20261003'});return response(d,t);}};
}
test('B exenta informa el bruto en ImpOpEx; no convierte el 40% del chofer en venta ni cambia la fuente',()=>{
  for(const method of ['cash','digital']){
    const p=payment();p.method=method;const before=JSON.stringify(p),i=buildInvoice(p,config,new Date(NOW));
    assert.deepEqual(i.issues,[]);assert.equal(i.invoiceType,6);assert.equal(i.issuerRegime,'general');
    assert.equal(i.detail.ImpTotal,100000);assert.equal(i.detail.ImpOpEx,100000);assert.equal(i.detail.ImpNeto,0);
    assert.equal(i.detail.ImpIVA,0);assert.equal(i.detail.ImpTotConc,0);assert.equal(i.detail.Iva,undefined);
    assert.equal(JSON.stringify(p),before);
  }
});
test('internacionales, más de 100 km, datos dudosos y receptores de A quedan para revisar',async()=>{
  const cases=[{scope:'international'},{distanceKm:100.01},{distanceKm:Infinity},{distanceKm:0},
    {customer:{requested:true,name:'Empresa de prueba',documentType:'CUIT',documentNumber:'20123456786',vatCondition:'registered'}},
    {customer:{requested:true,name:'Monotributista de prueba',documentType:'CUIT',documentNumber:'20123456786',vatCondition:'monotributo'}}];
  for(const [index,change] of cases.entries()){
    const db=memoryDb(),p=payment(),client=api();Object.assign(p.invoiceRequest,change);
    db.data.set('billing_records/'+index,p);await enqueueInvoice(db,String(index),config,NOW);
    assert.equal(db.data.get('arca_invoices/'+index).status,'review');
    await processInvoice({db,id:String(index),config,client,now:()=>NOW});assert.equal(client.calls,0);
  }
  const p=payment();p.invoiceRequest.distanceKm=100;assert.deepEqual(buildInvoice(p,config,new Date(NOW)).issues,[]);
  p.invoiceRequest.customer={requested:true,name:'Exento de prueba',documentType:'CUIT',documentNumber:'20123456786',vatCondition:'exempt'};
  assert.deepEqual(buildInvoice(p,config,new Date(NOW)).issues,[]);
});
test('configuración heredada o sin homologación B no activa producción',()=>{
  const c={...config,environment:'production',homologationPassed:true,registrationVerified:true};
  assert.equal(enabled(c),false);assert.equal(enabled({...c,generalHomologationPassed:true}),true);
  assert.equal(enabled({...c,generalHomologationPassed:true,domesticTaxiExemptionVerified:false}),false);
  assert.equal(enabled({...c,generalHomologationPassed:true,invoiceType:11}),false);
  assert.equal(enabled({...config,taxPolicy:'unverified'}),false);
  assert.equal(enabled({...config,approvedDriverUids:[]}),false);
});
test('perfiles de prueba no emiten B ni entran en la cola automática',async()=>{
  const db=memoryDb(),p=payment(),client=api();p.driverUid='test-profile-not-approved';
  db.data.set('billing_records/test',p);await enqueueInvoice(db,'test',config,NOW);
  const j=db.data.get('arca_invoices/test');assert.equal(j.status,'review');assert.ok(j.issues.includes('driver_not_authorized_for_invoicing'));
  await processInvoice({db,id:'test',config,client,now:()=>NOW});assert.equal(client.calls,0);
});
test('B internacional necesita política/corte propios y conserva exención, bruto e idempotencia',async()=>{
  const c={...config,internationalTaxPolicy:INTERNATIONAL_EXEMPT_POLICY,internationalInvoiceType:6,
    internationalTransportExemptionVerified:true,internationalActiveFrom:'2026-09-23T00:00:00-03:00'};
  assert.equal(internationalBEnabled(c,new Date(NOW)),true);
  const db=memoryDb(),client=api();
  for(const method of ['cash','digital']){
    const p=payment();p.method=method;p.invoiceRequest.scope='international';p.invoiceRequest.distanceKm=150;
    p.invoiceRequest.origin='Puerto Iguazú - Argentina';p.invoiceRequest.destination='Destino de prueba - Brasil';
    db.data.set('billing_records/'+method,p);await enqueueInvoice(db,method,c,NOW);await enqueueInvoice(db,method,c,NOW);
    const run=()=>processInvoice({db,id:method,config:c,client,now:()=>NOW});await run();await run();
    const j=db.data.get('arca_invoices/'+method);assert.equal(j.status,'authorized');assert.equal(j.invoiceType,6);
    assert.equal(j.internationalTaxPolicy,INTERNATIONAL_EXEMPT_POLICY);assert.equal(j.detail.ImpOpEx,100000);assert.equal(j.detail.ImpNeto,0);
  }
  assert.equal(client.calls,2);
  for(const change of [{internationalInvoiceType:11},{internationalTransportExemptionVerified:false},
    {internationalTaxPolicy:'unverified'},{internationalActiveFrom:'2026-09-24T00:00:00-03:00'}]){
    assert.equal(internationalBEnabled({...c,...change},new Date(NOW)),false);
    const p=payment();p.invoiceRequest.scope='international';
    assert.ok(buildInvoice(p,{...c,...change},new Date(NOW)).issues.includes('international_requires_review'));
  }
  const old=payment();old.invoiceRequest.scope='international';old.invoiceRequest.serviceDate='2026-09-22';
  assert.ok(buildInvoice(old,c,new Date(NOW)).issues.includes('international_before_activation'));
  old.invoiceRequest.serviceDate='2026-09-23';old.createdAt={toMillis:()=>Date.parse(c.internationalActiveFrom)-1};
  assert.ok(buildInvoice(old,c,new Date(NOW)).issues.includes('international_before_activation'));
});
test('evento repetido B, numeración propia y pagos/saldos intactos',async()=>{
  const db=memoryDb(),client=api(),p=payment();db.data.set('billing_records/a',p);
  db.data.set('drivers/test-driver',{balance:987654});const sourceBefore=JSON.stringify(p);
  await Promise.all([enqueueInvoice(db,'a',config,NOW),enqueueInvoice(db,'a',config,NOW)]);
  const run=()=>processInvoice({db,id:'a',config,client,now:()=>NOW});await Promise.all([run(),run()]);await run();
  assert.equal(client.calls,1);assert.equal(db.data.get('arca_invoices/a').number,1);
  assert.equal(db.data.get('arca_invoices/a').seriesKey,'homologation_20123456786_3_6');
  assert.deepEqual(client.trace,[['last',3,6],['authorize',3,6]]);
  assert.equal(JSON.stringify(db.data.get('billing_records/a')),sourceBefore);
  assert.deepEqual(db.data.get('drivers/test-driver'),{balance:987654});
});
test('B autorizada con respuesta perdida consulta tipo 6 sin emitir otra vez',async()=>{
  const db=memoryDb(),client=api();db.data.set('billing_records/a',payment());await enqueueInvoice(db,'a',config,NOW);
  const original=client.authorize;client.authorize=async(...args)=>{await original(...args);throw Error('timeout');};
  const run=()=>processInvoice({db,id:'a',config,client,now:()=>NOW});await run();await run();
  assert.equal(client.calls,1);assert.equal(db.data.get('arca_invoices/a').status,'authorized');
  assert.deepEqual(client.trace.at(-1),['consult',3,1,6]);
});
test('una C del mismo número nunca se adopta como B y mantiene bloqueada la serie',async()=>{
  const db=memoryDb(),client=api();db.data.set('billing_records/a',payment());await enqueueInvoice(db,'a',config,NOW);
  const job=db.data.get('arca_invoices/a'),detail={...job.detail,CbteDesde:1,CbteHasta:1};
  db.data.set('arca_invoices/a',{...job,detail,status:'sent',number:1});db.data.set('arca_series/'+seriesKey(config),{activeId:'a'});
  client.issued.set(1,{...detail,Resultado:'A',EmisionTipo:'CAE',PtoVta:3,CbteTipo:11,CodAutorizacion:'12345678901234',FchVto:'20261003'});
  await processInvoice({db,id:'a',config,client,now:()=>NOW});
  assert.equal(client.calls,0);assert.equal(db.data.get('arca_invoices/a').issue,'number_conflict');
  assert.equal(db.data.get('arca_series/'+seriesKey(config)).activeId,'a');
  assert.equal(matchesAuthorized(client.issued.get(1),detail,3,6),false);
  assert.equal(matchesAuthorized({...client.issued.get(1),CbteTipo:6,CondicionIVAReceptorId:1},detail,3,6),false);
  assert.throws(()=>authorizationFromResponse(response(detail,11),detail,3,6));
});
test('no migra rechazos C ni servicios anteriores a activación aunque se carguen hoy',async()=>{
  const db=memoryDb(),client=api(),mono={...config,regime:'monotributo',pointOfSale:2};
  db.data.set('billing_records/old',payment());await enqueueInvoice(db,'old',mono,NOW);
  db.data.set('arca_invoices/old',{...db.data.get('arca_invoices/old'),status:'rejected'});
  const before=JSON.stringify(db.data.get('arca_invoices/old'));
  await enqueueInvoice(db,'old',config,NOW);await processInvoice({db,id:'old',config,client,now:()=>NOW});
  assert.equal(JSON.stringify(db.data.get('arca_invoices/old')),before);
  const p=payment();p.invoiceRequest.serviceDate='2026-09-22';db.data.set('billing_records/past',p);
  await enqueueInvoice(db,'past',config,NOW);assert.equal(db.data.get('arca_invoices/past').status,'review');
  await processInvoice({db,id:'past',config,client,now:()=>NOW});assert.equal(client.calls,0);
});
test('no usa punto de monotributo ni punto bloqueado para B',async()=>{
  for(const change of [{EmisionTipo:'CAE - Monotributo'},{Bloqueado:'S'},{FchBaja:'20260901'},{Nro:2}]){
    const db=memoryDb(),client=api();client.points=async()=>[{Nro:3,Bloqueado:'N',FchBaja:'NULL',EmisionTipo:'CAE - Ri Iva',...change}];
    db.data.set('billing_records/a',payment());await enqueueInvoice(db,'a',config,NOW);
    await processInvoice({db,id:'a',config,client,now:()=>NOW});assert.equal(client.calls,0);
    assert.equal(db.data.get('arca_invoices/a').issue,'point_of_sale_unavailable');
  }
});
test('SOAP de autorización B usa tipo 6 y monto exento',async()=>{
  const requests=[],d={...buildInvoice(payment(),config,new Date(NOW)).detail,CbteDesde:1,CbteHasta:1};
  const client=createArcaClient({environment:'homologation',cuit:config.cuit,
    ticketStore:{load:async()=>({token:'test-token',sign:'test-sign',expiresAt:'2099-01-01'})},
    fetchImpl:async(url,options)=>{requests.push(options.body);return {ok:true,text:async()=>
      '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><FECAESolicitarResponse><FECAESolicitarResult><FeCabResp><PtoVta>3</PtoVta><CbteTipo>6</CbteTipo><CantReg>1</CantReg><Resultado>A</Resultado></FeCabResp><FeDetResp><FECAEDetResponse><Resultado>A</Resultado><CbteDesde>1</CbteDesde><CbteHasta>1</CbteHasta><CAE>12345678901234</CAE><CAEFchVto>20261003</CAEFchVto></FECAEDetResponse></FeDetResp></FECAESolicitarResult></FECAESolicitarResponse></soap:Body></soap:Envelope>'};}});
  const result=await client.authorize(3,d,6);assert.equal(authorizationFromResponse(result,d,3,6).status,'authorized');
  assert.ok(requests[0].includes('<CbteTipo>6</CbteTipo>'));assert.ok(requests[0].includes('<ImpOpEx>100000</ImpOpEx>'));
  assert.ok(requests[0].includes('<ImpNeto>0</ImpNeto>'));assert.ok(!requests[0].includes('<Iva>'));
});
test('PDF/QR/nombre B coherentes y C histórica conservada',async()=>{
  const i={...buildInvoice(payment(),config,new Date(NOW)),status:'authorized',number:1,cae:'12345678901234',caeExpires:'20261003'};
  const b=await invoicePdf(i);assert.equal(b.subarray(0,4).toString(),'%PDF');assert.equal(invoiceFilename(i),'PRUEBA-FB-3-1.pdf');
  const qr=JSON.parse(Buffer.from(new URL(qrUrl(i)).searchParams.get('p'),'base64'));assert.equal(qr.tipoCmp,6);assert.equal(qr.ptoVta,3);assert.equal(qr.importe,100000);
  const old={...i,invoiceType:undefined,issuerRegime:undefined,environment:'production'};
  const oldQr=JSON.parse(Buffer.from(new URL(qrUrl(old)).searchParams.get('p'),'base64'));assert.equal(oldQr.tipoCmp,11);
  assert.equal(invoiceFilename(old),'FC-3-1.pdf');await invoicePdf(old);
  await assert.rejects(invoicePdf({...i,status:'review'}));await assert.rejects(invoicePdf({...i,issuerRegime:'monotributo'}));
});
