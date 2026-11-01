'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const {buildInvoice,matchesAuthorized,authorizationFromResponse}=require('../arca-invoice');
const {enqueueInvoice,processInvoice,seriesKey,enabled}=require('../arca-worker');
const {DOMESTIC_EXEMPT_POLICY,INTERNATIONAL_EXEMPT_POLICY,configuredInvoiceType,ivaExemptPolicyReady,internationalExemptCEnabled,pointMatches,enabledInvoiceTypes}=require('../arca-policy');
const {createArcaClient}=require('../arca-client');
const {prepareInvoiceDraft}=require('../arca-invoice-draft');
const NOW=Date.parse('2026-11-01T15:00:00Z'),EFFECTIVE='2026-11-01T00:00:00-03:00';
const config={enabled:true,environment:'homologation',regime:'iva_exento',invoiceType:11,
  approvedDriverUids:['real-driver'],ivaExemptRegistrationVerified:true,
  regimeEffectiveFrom:EFFECTIVE,activeFrom:EFFECTIVE,
  taxPolicy:DOMESTIC_EXEMPT_POLICY,domesticTaxiExemptionVerified:true,exclusivePointOfSale:true,
  pointEmissionType:'CAE - Exento',pointOfSale:5,cuit:'20123456786',legalName:'EMISOR DE PRUEBA',
  address:'Domicilio de prueba',grossIncomeId:'Dato de prueba',activityStart:'2024-01-01'};
const payment=(method='digital')=>({driverUid:'real-driver',type:'billing',method,status:'completed',amount:32500,
  createdAt:{toMillis:()=>NOW},invoiceRequest:{version:'arca_c_v1',serviceDate:'2026-11-01',
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
const response=d=>({header:{Resultado:'A',PtoVta:5,CbteTipo:11,CantReg:1},
  detail:{Resultado:'A',CbteDesde:d.CbteDesde,CbteHasta:d.CbteHasta,CAE:'12345678901234',CAEFchVto:'20261111'}});
function api(){let calls=0,last=0;const issued=new Map(),trace=[];return {issued,trace,get calls(){return calls;},
  points:async()=>[{Nro:5,Bloqueado:'N',FchBaja:'NULL',EmisionTipo:'CAE - Exento'}],
  last:async(p,t)=>{trace.push(['last',p,t]);return last;},
  consult:async(p,n,t)=>{trace.push(['consult',p,n,t]);return issued.get(n)||null;},
  authorize:async(p,d,t)=>{calls++;trace.push(['authorize',p,t]);last=d.CbteDesde;
    issued.set(last,{...d,Resultado:'A',EmisionTipo:'CAE',PtoVta:p,CbteTipo:t,CodAutorizacion:'12345678901234',FchVto:'20261111'});return response(d);}};
}

test('IVA exento emits C for every supported recipient without inheriting A/B activation',()=>{
  const c={...config,invoiceAEnabled:true,invoiceAHomologationPassed:true,generalHomologationPassed:true};
  assert.equal(configuredInvoiceType(c),11);assert.deepEqual(enabledInvoiceTypes(c),[11]);
  for(const method of ['cash','digital'])for(const vat of ['consumer','registered','monotributo','exempt']){
    const p=payment(method);
    p.invoiceRequest.customer={requested:true,name:'Cliente de prueba',documentType:'CUIT',documentNumber:'20123456786',vatCondition:vat};
    const before=JSON.stringify(p),i=buildInvoice(p,c,new Date(NOW));
    assert.deepEqual(i.issues,[]);assert.equal(i.invoiceType,11);assert.equal(i.issuerRegime,'iva_exento');
    assert.equal(i.issuer.vatCondition,'IVA Exento');assert.equal(i.regimeEffectiveFrom,EFFECTIVE);
    assert.equal(i.detail.CondicionIVAReceptorId,{consumer:5,registered:1,monotributo:6,exempt:4}[vat]);
    // WSFE v4.7 C uses subtotal in ImpNeto, even when the issuer is IVA-exempt.
    assert.equal(i.detail.ImpTotal,32500);assert.equal(i.detail.ImpNeto,32500);
    for(const key of ['ImpOpEx','ImpIVA','ImpTotConc','ImpTrib'])assert.equal(i.detail[key],0);
    assert.equal(i.detail.Iva,undefined);assert.equal(JSON.stringify(p),before);
  }
});

test('IVA exento has independent registration and homologation gates',()=>{
  const production={...config,environment:'production',registrationVerified:true,ivaExemptHomologationPassed:true};
  assert.equal(enabled(production,NOW),true);
  for(const patch of [{ivaExemptRegistrationVerified:false},{ivaExemptHomologationPassed:false},{registrationVerified:false},
    {regimeEffectiveFrom:''},{regimeEffectiveFrom:'invalid'},{regimeEffectiveFrom:'2026-11-01'},
    {regimeEffectiveFrom:'2026-02-30T00:00:00-03:00'},{activeFrom:'2026-11-01'},
    {activeFrom:'2026-10-31T00:00:00-03:00'},
    {invoiceType:6},{invoiceType:undefined},{taxPolicy:'unverified'},{domesticTaxiExemptionVerified:false},
    {approvedDriverUids:[]},{approvedDriverUids:['']},{exclusivePointOfSale:false}]){
    assert.equal(enabled({...production,homologationPassed:true,generalHomologationPassed:true,...patch},NOW),false,JSON.stringify(patch));
  }
  assert.equal(enabled({...production,regimeEffectiveFrom:'2026-11-02T00:00:00-03:00',activeFrom:'2026-11-02T00:00:00-03:00'},NOW),false);
});

test('October service uploaded in November remains review; cutoff uses Argentina midnight',async()=>{
  const db=memoryDb(),client=api(),old=payment();old.invoiceRequest.serviceDate='2026-10-31';
  db.data.set('billing_records/october',old);await enqueueInvoice(db,'october',config,NOW);
  const job=db.data.get('arca_invoices/october');assert.equal(job.status,'review');
  assert.ok(job.issues.includes('service_before_regime_activation'));
  await processInvoice({db,id:'october',config,client,now:()=>NOW});assert.equal(client.calls,0);
  const midnight=Date.parse(EFFECTIVE);
  assert.equal(enabled(config,midnight-1),false);assert.equal(enabled(config,midnight),true);
  const fresh=payment();fresh.createdAt={toMillis:()=>midnight};
  assert.deepEqual(buildInvoice(fresh,config,new Date(midnight)).issues,[]);
  const laterActivation={...config,activeFrom:'2026-11-01T12:00:00-03:00'};
  assert.equal(ivaExemptPolicyReady(laterActivation),true);
  assert.ok(buildInvoice(old,laterActivation,new Date(NOW)).issues.includes('service_before_regime_activation'));
  const createdBefore=payment();createdBefore.createdAt={toMillis:()=>midnight-1};
  db.data.set('billing_records/before',createdBefore);await enqueueInvoice(db,'before',config,NOW);
  assert.equal(db.data.get('arca_invoices/before').status,'disabled');
});

test('national eligibility and real-driver safeguards still apply to exempt C',async()=>{
  for(const [name,change] of [['distance',{invoiceRequest:{...payment().invoiceRequest,distanceKm:101}}],
    ['unapproved',{driverUid:'fake-driver'}],['simulation',{isSimulated:true}],['shadow',{verificationMode:'shadow'}]]){
    const db=memoryDb(),p={...payment(),...change},client=api();db.data.set('billing_records/'+name,p);
    await enqueueInvoice(db,name,config,NOW);await processInvoice({db,id:name,config,client,now:()=>NOW});
    assert.equal(client.calls,0);
    if(name==='simulation'||name==='shadow')assert.equal(db.data.has('arca_invoices/'+name),false);
    else assert.equal(db.data.get('arca_invoices/'+name).status,'review');
  }
});

test('international C has an explicit policy and a new exempt activation cutoff',()=>{
  const c={...config,internationalInvoiceType:11,internationalTaxPolicy:INTERNATIONAL_EXEMPT_POLICY,
    internationalTransportExemptionVerified:true,internationalActiveFrom:EFFECTIVE};
  const p=payment();p.invoiceRequest.scope='international';p.invoiceRequest.distanceKm=150;
  assert.equal(internationalExemptCEnabled(c,new Date(NOW)),true);
  const i=buildInvoice(p,c,new Date(NOW));assert.deepEqual(i.issues,[]);assert.equal(i.invoiceType,11);
  assert.equal(i.internationalTaxPolicy,INTERNATIONAL_EXEMPT_POLICY);assert.equal(i.detail.ImpOpEx,0);
  for(const patch of [{internationalInvoiceType:6},{internationalTransportExemptionVerified:false},
    {internationalTaxPolicy:'unverified'},{internationalActiveFrom:'2026-09-23T00:00:00-03:00'},
    {internationalActiveFrom:'2026-11-02T00:00:00-03:00'},{internationalActiveFrom:'2026-11-01'},
    {internationalActiveFrom:'2026-02-30T00:00:00-03:00'}]){
    assert.equal(internationalExemptCEnabled({...c,...patch},new Date(NOW)),false);
    assert.ok(buildInvoice(p,{...c,...patch},new Date(NOW)).issues.includes('international_requires_review'));
  }
});

test('exempt C requires an exact exempt WSFE point, rejects old Mono/RI points',async()=>{
  assert.equal(pointMatches({Nro:5,Bloqueado:'N',FchBaja:'NULL',EmisionTipo:'CAE - Exento'},config),true);
  for(const patch of [{EmisionTipo:'CAE - Monotributo'},{EmisionTipo:'CAE - Ri Iva'},{Bloqueado:'S'},
    {FchBaja:'20261101'},{Nro:3}]){
    const db=memoryDb(),client=api();client.points=async()=>[{Nro:5,Bloqueado:'N',FchBaja:'NULL',EmisionTipo:'CAE - Exento',...patch}];
    db.data.set('billing_records/a',payment());await enqueueInvoice(db,'a',config,NOW);
    await processInvoice({db,id:'a',config,client,now:()=>NOW});assert.equal(client.calls,0);
    assert.equal(db.data.get('arca_invoices/a').issue,'point_of_sale_unavailable');
  }
  assert.equal(pointMatches({Nro:5,Bloqueado:'N',FchBaja:'NULL',EmisionTipo:'CAE - Monotributo'},{...config,pointEmissionType:'CAE - Monotributo'}),false);
});

test('duplicate events, simultaneous workers and retries emit once and preserve ledgers',async()=>{
  const db=memoryDb(),client=api();db.data.set('billing_records/a',payment());
  db.data.set('wallets/real-driver',{balance:200});db.data.set('closures/latest',{total:900});
  const before=JSON.stringify([...db.data]);
  await Promise.all([enqueueInvoice(db,'a',config,NOW),enqueueInvoice(db,'a',config,NOW)]);
  const run=()=>processInvoice({db,id:'a',config,client,now:()=>NOW});await Promise.all([run(),run()]);await run();
  assert.equal(client.calls,1);const job=db.data.get('arca_invoices/a');assert.equal(job.status,'authorized');
  assert.equal(job.seriesKey,'homologation_20123456786_5_11');
  assert.deepEqual(client.trace,[['last',5,11],['authorize',5,11]]);
  assert.equal(JSON.stringify([...db.data].filter(([key])=>!key.startsWith('arca_'))),before);
});

test('old A/B/C snapshots are never migrated or emitted under the new exempt setting',async()=>{
  for(const type of [1,6,11])for(const status of ['queued','sent','uncertain','rejected','authorized']){
    const db=memoryDb(),client=api(),current=buildInvoice(payment(),config,new Date(NOW));
    const legacy={...current,invoiceType:type,issuerRegime:type===11?'monotributo':'general',
      status,number:status==='queued'?null:12,paymentId:'old',driverUid:'real-driver',createdAtMs:NOW-86400000,
      seriesKey:seriesKey(config,type),leaseUntil:0,cae:status==='authorized'?'12345678901234':null};
    delete legacy.issuer.vatCondition;
    db.data.set('billing_records/old',payment());db.data.set('arca_invoices/old',legacy);
    if(status==='sent'||status==='uncertain')db.data.set('arca_series/'+seriesKey(config,type),{activeId:'old'});
    const before=JSON.stringify([...db.data]);await enqueueInvoice(db,'old',config,NOW);
    await processInvoice({db,id:'old',config,client,now:()=>NOW});
    assert.equal(JSON.stringify([...db.data]),before);assert.equal(client.calls,0);assert.deepEqual(client.trace,[]);
  }
});

test('rollback to monotributo does not authorize a new exempt C snapshot',async()=>{
  const db=memoryDb(),client=api();db.data.set('billing_records/a',payment());await enqueueInvoice(db,'a',config,NOW);
  const before=JSON.stringify(db.data.get('arca_invoices/a'));
  await processInvoice({db,id:'a',config:{...config,regime:'monotributo'},client,now:()=>NOW});
  assert.equal(client.calls,0);assert.equal(JSON.stringify(db.data.get('arca_invoices/a')),before);
});

test('lost C response is reconciled by type, amount and recipient VAT, never sent again',async()=>{
  const db=memoryDb(),client=api(),original=client.authorize;db.data.set('billing_records/a',payment());
  await enqueueInvoice(db,'a',config,NOW);
  client.authorize=async(...args)=>{await original(...args);throw Error('lost response');};
  const run=()=>processInvoice({db,id:'a',config,client,now:()=>NOW});await run();assert.equal(db.data.get('arca_invoices/a').status,'uncertain');
  const actual={...client.issued.get(1)};client.issued.set(1,{...actual,CondicionIVAReceptorId:1});
  await run();assert.equal(db.data.get('arca_invoices/a').issue,'number_conflict');assert.equal(client.calls,1);
  assert.equal(db.data.get('arca_series/'+seriesKey(config)).activeId,'a');
  client.issued.set(1,actual);await run();await run();assert.equal(client.calls,1);
  assert.equal(db.data.get('arca_invoices/a').status,'authorized');
  assert.deepEqual(client.trace.at(-1),['consult',5,1,11]);
  assert.equal(matchesAuthorized({...actual,CondicionIVAReceptorId:1},actual,5,11,{requireRecipientVat:true}),false);
});

test('SOAP C sends total as subtotal and does not send VAT items or exempt A/B amounts',async()=>{
  const requests=[],d={...buildInvoice(payment(),config,new Date(NOW)).detail,CbteDesde:1,CbteHasta:1};
  const client=createArcaClient({environment:'homologation',cuit:config.cuit,
    ticketStore:{load:async()=>({token:'test-token',sign:'test-sign',expiresAt:'2099-01-01'})},
    fetchImpl:async(url,options)=>{requests.push(options.body);return {ok:true,text:async()=>
      '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><FECAESolicitarResponse><FECAESolicitarResult><FeCabResp><PtoVta>5</PtoVta><CbteTipo>11</CbteTipo><CantReg>1</CantReg><Resultado>A</Resultado></FeCabResp><FeDetResp><FECAEDetResponse><Resultado>A</Resultado><CbteDesde>1</CbteDesde><CbteHasta>1</CbteHasta><CAE>12345678901234</CAE><CAEFchVto>20261111</CAEFchVto></FECAEDetResponse></FeDetResp></FECAESolicitarResult></FECAESolicitarResponse></soap:Body></soap:Envelope>'};}});
  assert.equal(authorizationFromResponse(await client.authorize(5,d,11),d,5,11).status,'authorized');
  for(const fragment of ['<CbteTipo>11</CbteTipo>','<ImpTotal>32500</ImpTotal>','<ImpNeto>32500</ImpNeto>','<ImpOpEx>0</ImpOpEx>','<ImpIVA>0</ImpIVA>'])assert.ok(requests[0].includes(fragment));
  assert.ok(!requests[0].includes('<Iva>'));
});

test('preparation recognizes exempt issuer C but never claims a valid invoice or authorization',()=>{
  const p=payment();p.invoiceRequest.version='arca_preparation_v1';
  const draft=prepareInvoiceDraft(p,'draft',config);
  assert.equal(draft.targetRegime,'iva_exento');assert.equal(draft.voucherType,11);
  assert.equal(draft.emissionEnabled,false);assert.equal(draft.fiscalValidity,false);assert.equal(draft.vatTreatment,'pending_review');
  assert.equal(draft.issuer.registrationVerified,false);assert.ok(draft.blockers.includes('issuer_registration_unverified'));
  assert.ok(!draft.blockers.includes('issuerRegime'));
});

function draftHandler(db) {
  const source=fs.readFileSync(require.resolve('../index.js'),'utf8');
  const handler=source.slice(source.indexOf('exports.prepareArcaInvoiceDraft ='),source.indexOf('const MAX_SCANNED_DOCUMENTS'));
  const context={exports:{},onDocumentWritten:(_,fn)=>fn,db,prepareInvoiceDraft,
    FieldValue:{serverTimestamp:()=>NOW},process:{env:{ARCA_ISSUER_REGIME:'monotributo',ARCA_ISSUER_CUIT:'STALE'}}};
  vm.runInNewContext(handler,context);return context.exports.prepareArcaInvoiceDraft;
}
test('real draft trigger reads current issuer for new drafts, preserving historical issuer on updates',async()=>{
  const db=memoryDb(),p=payment();p.invoiceRequest.version='arca_preparation_v1';
  db.data.set('billing_records/new',p);db.data.set('arca_settings/current',config);
  const run=draftHandler(db);await run({data:{},params:{paymentId:'new'}});
  const draft=db.data.get('arca_invoice_drafts/new');assert.equal(draft.targetRegime,'iva_exento');
  assert.equal(draft.issuer.cuit,config.cuit);assert.equal(draft.issuer.legalName,config.legalName);assert.equal(draft.issuer.pointOfSale,5);
  assert.equal(draft.voucherType,11);assert.equal(draft.fiscalValidity,false);
  db.data.set('arca_settings/current',{...config,regime:'general',cuit:'CHANGED',legalName:'Changed',pointOfSale:3});
  await run({data:{},params:{paymentId:'new'}});
  assert.deepEqual(db.data.get('arca_invoice_drafts/new').issuer,draft.issuer);
  assert.equal(db.data.get('arca_invoice_drafts/new').targetRegime,'iva_exento');
  const old={...draft,targetRegime:'monotributo',issuer:{...draft.issuer,pointOfSale:2},createdAt:123};
  db.data.set('arca_invoice_drafts/old',old);db.data.set('billing_records/old',p);
  await run({data:{},params:{paymentId:'old'}});
  assert.equal(db.data.get('arca_invoice_drafts/old').targetRegime,'monotributo');
  assert.deepEqual(db.data.get('arca_invoice_drafts/old').issuer,old.issuer);
  assert.equal(db.data.get('arca_invoice_drafts/old').createdAt,123);
});

test('missing draft settings fail closed; current invoice requests need no settings read for preparation',async()=>{
  const db=memoryDb(),p=payment();p.invoiceRequest.version='arca_preparation_v1';db.data.set('billing_records/missing',p);
  const run=draftHandler(db);await run({data:{},params:{paymentId:'missing'}});
  const draft=db.data.get('arca_invoice_drafts/missing');assert.equal(draft.targetRegime,'unknown');
  assert.equal(draft.voucherType,null);assert.ok(draft.blockers.includes('issuerRegime'));assert.equal(draft.issuer.cuit,null);
  const original=db.runTransaction;db.runTransaction=callback=>original(tx=>callback({...tx,get:async ref=>{
    assert.notEqual(ref.path,'arca_settings/current','No fiscal settings read for current automatic requests');return tx.get(ref);
  }}));
  db.data.set('billing_records/automatic',payment());await run({data:{},params:{paymentId:'automatic'}});
  assert.equal(db.data.has('arca_invoice_drafts/automatic'),false);
});

test('draft settings read failure does not write a misleading legacy draft or alter the source',async()=>{
  const db=memoryDb(),p=payment();p.invoiceRequest.version='arca_preparation_v1';db.data.set('billing_records/read-failed',p);
  const before=JSON.stringify([...db.data]),original=db.runTransaction;
  db.runTransaction=callback=>original(tx=>callback({...tx,get:async ref=>{
    if(ref.path==='arca_settings/current')throw Error('READ_FAILED');return tx.get(ref);
  }}));
  await assert.rejects(draftHandler(db)({data:{},params:{paymentId:'read-failed'}}),/READ_FAILED/);
  assert.equal(JSON.stringify([...db.data]),before);
});
