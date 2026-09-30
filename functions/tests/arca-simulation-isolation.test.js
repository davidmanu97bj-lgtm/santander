'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {buildInvoice}=require('../arca-invoice');
const {enqueueInvoice,processInvoice,seriesKey}=require('../arca-worker');
const {DOMESTIC_EXEMPT_POLICY}=require('../arca-policy');
const memoryFirestore=require('./memory-firestore');
const fs=require('node:fs');
const path=require('node:path');

const NOW=Date.parse('2026-09-23T18:00:00Z');
const baseConfig={enabled:true,environment:'production',regime:'monotributo',exclusivePointOfSale:true,
  homologationPassed:true,registrationVerified:true,pointOfSale:3,cuit:'20123456786',
  legalName:'EMISOR SINTETICO',address:'Domicilio sintético',grossIncomeId:'Dato sintético',
  activityStart:'2024-01-01',activeFrom:'2026-09-23T00:00:00-03:00'};
const configs=[baseConfig,{...baseConfig,regime:'general',invoiceType:6,approvedDriverUids:['test-driver'],
  taxPolicy:DOMESTIC_EXEMPT_POLICY,domesticTaxiExemptionVerified:true,
  generalHomologationPassed:true,pointEmissionType:'CAE - Ri Iva'}];
const markers=[
  ['isSimulated',{isSimulated:true}],
  ['createdBySimulation',{createdBySimulation:true}],
  ['simulation mode',{verificationMode:'simulation'}],
  ['shadow mode',{verificationMode:'shadow'}],
  ['Fleet shadow source',{source:'uber_fleet_shadow'}],
  ['normalized shadow mode',{verificationMode:' SHADOW '}],
  ['normalized Fleet shadow source',{source:' UBER_FLEET_SHADOW '}]
];
const payment=()=>({driverUid:'test-driver',type:'billing',method:'cash',status:'completed',amount:100000,
  createdAt:{toMillis:()=>NOW},invoiceRequest:{version:'arca_c_v1',serviceDate:'2026-09-23',scope:'national',
    origin:'Origen sintético',destination:'Destino sintético',distanceKm:20,customer:{}}});

// These tests never construct an ARCA client, load credentials or access a real database.
function forbiddenClient() {
  const calls=[];
  return {calls,...Object.fromEntries(['points','last','consult','authorize'].map(name=>[name,async()=>{
    calls.push(name);throw new Error('Unexpected ARCA call in isolated test');
  }]))};
}
function queuedJob(config,status='queued') {
  return {...buildInvoice(payment(),config,new Date(NOW)),paymentId:'trip',driverUid:'test-driver',
    status,seriesKey:seriesKey(config),leaseUntil:0,createdAtMs:NOW,updatedAtMs:NOW,
    number:['sent','uncertain'].includes(status)?7:null,cae:null,caeExpires:null};
}

for(const config of configs) {
  test(`${config.regime}: simulation markers cannot build or queue a fiscal request`,async()=>{
    for(const [name,marker] of markers) {
      const db=memoryFirestore(),source={...payment(),...marker},client=forbiddenClient();
      db.data.set('billing_records/trip',source);
      assert.equal(buildInvoice(source,config,new Date(NOW)),null,name);
      await Promise.all([enqueueInvoice(db,'trip',config,NOW),enqueueInvoice(db,'trip',config,NOW)]);
      await processInvoice({db,id:'trip',config,client,now:()=>NOW});
      assert.equal(db.data.has('arca_invoices/trip'),false,name);
      assert.equal(db.data.has('arca_series/'+seriesKey(config)),false,name);
      assert.equal(db.data.get('billing_records/trip'),source,name);
      assert.deepEqual(client.calls,[],name);
    }
  });

  test(`${config.regime}: legacy jobs check both their snapshot and source before any ARCA call`,async()=>{
    for(const [name,marker] of markers) for(const location of ['job','source']) {
      for(const status of ['queued','reserved','sent','uncertain']) {
        const db=memoryFirestore(),client=forbiddenClient();
        const source={...payment(),...(location==='source'?marker:{})};
        const job={...queuedJob(config,status),...(location==='job'?marker:{})};
        const series={activeId:'trip'};
        db.data.set('billing_records/trip',source);
        db.data.set('arca_invoices/trip',job);
        db.data.set('arca_series/'+seriesKey(config),series);
        await Promise.all([enqueueInvoice(db,'trip',config,NOW),processInvoice({db,id:'trip',config,client,now:()=>NOW})]);
        const label=`${name}, ${location}, ${status}`;
        assert.deepEqual(client.calls,[],label);
        assert.equal(db.data.get('arca_invoices/trip'),job,label);
        assert.equal(db.data.get('arca_series/'+seriesKey(config)),series,label);
        assert.equal(db.data.get('billing_records/trip'),source,label);
      }
    }
  });

  test(`${config.regime}: a simulated job stays blocked even if its source is missing`,async()=>{
    for(const [name,marker] of markers) {
      const db=memoryFirestore(),client=forbiddenClient();
      db.data.set('arca_invoices/trip',{...queuedJob(config),...marker});
      await processInvoice({db,id:'trip',config,client,now:()=>NOW});
      assert.deepEqual(client.calls,[],name);
      assert.equal(db.data.has('arca_series/'+seriesKey(config)),false,name);
    }
  });

  test(`${config.regime}: suppressTelegram alone preserves real payment invoicing`,async()=>{
    const db=memoryFirestore(),source={...payment(),suppressTelegram:true,isSimulated:false,
      createdBySimulation:false,verificationMode:'verified',source:'uber_fleet'},calls=[];
    db.data.set('billing_records/trip',source);
    assert.deepEqual(buildInvoice(source,config,new Date(NOW)).issues,[]);
    await enqueueInvoice(db,'trip',config,NOW);
    assert.equal(db.data.get('arca_invoices/trip').status,'queued');
    const type=config.regime==='general'?6:11;
    const client={
      points:async()=>{calls.push('points');return [{Nro:3,Bloqueado:'N',FchBaja:'NULL',EmisionTipo:type===6?'CAE - Ri Iva':'CAE - Monotributo'}];},
      last:async()=>{calls.push('last');return 0;},
      consult:async()=>{calls.push('consult');throw new Error('Unexpected consultation');},
      authorize:async(point,detail,invoiceType)=>{calls.push('authorize');assert.equal(invoiceType,type);return {
        header:{Resultado:'A',PtoVta:point,CbteTipo:type,CantReg:1},
        detail:{Resultado:'A',CbteDesde:detail.CbteDesde,CbteHasta:detail.CbteHasta,CAE:'12345678901234',CAEFchVto:'20261003'}
      };}
    };
    await processInvoice({db,id:'trip',config,client,now:()=>NOW});
    assert.equal(db.data.get('arca_invoices/trip').status,'authorized');
    assert.deepEqual(calls,['points','last','authorize']);
    assert.equal(db.data.get('billing_records/trip'),source);
  });
}

test('driver charge rules forbid fiscal simulation overrides without requiring new fields',()=>{
  const rules=fs.readFileSync(path.join(__dirname,'../../firestore.rules'),'utf8');
  const chargeRules=rules.split('function validDriverCharge(d) {')[1]?.split('\n      }')[0];
  assert.ok(chargeRules,'Missing driver charge validation');
  assert.match(chargeRules,/!d\.keys\(\)\.hasAny\(\['isSimulated','createdBySimulation','verificationMode'\]\)/);
  assert.ok(chargeRules.includes("d.get('source', '') is string && !d.get('source', '').matches('(?is).*uber_fleet_shadow.*')"));
  assert.doesNotMatch(chargeRules,/suppressTelegram/);
  // Firestore RE2 uses the same pattern with inline flags; exercise its expected
  // matching separately. This contract check does not replace emulator validation.
  const shadowPattern=/.*uber_fleet_shadow.*/is;
  for(const source of ['uber_fleet_shadow',' UBER_FLEET_SHADOW ','\nuber_fleet_shadow\n','\u00a0uber_fleet_shadow\u00a0']) {
    assert.ok(shadowPattern.test(source));
  }
  for(const source of ['', 'barberia-main-migrated','uber_fleet'])assert.equal(shadowPattern.test(source),false);
});
