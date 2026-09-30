import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {MemoryStore} from '../tools/preview/memory-store.mjs';
const require=createRequire(import.meta.url);
const {createFleetShadowService,COLLECTIONS}=require('../functions/uber-fleet-service');
const {CSV_TEMPLATES}=require('../functions/uber-fleet-core');
const now=Date.parse('2026-09-29T12:00:00-03:00');
const driver='22222222-2222-4222-8222-222222222222';
const seed=()=>({'choferes/chofer-1':{uid:'chofer-1',nombre:'Chofer de prueba',active:true},'choferes/baja':{uid:'baja',active:false},'choferes/admin':{uid:'admin',role:'admin'}});
const input=extra=>({mode:'shadow',fleetId:'fleet-test',tripsCsv:CSV_TEMPLATES.trips,paymentsCsv:CSV_TEMPLATES.payments,driverMappings:{[driver]:{driverUid:'chofer-1',digitalRecipient:'explora'}},...extra});
const service=db=>createFleetShadowService({db,assertAdmin:async()=> 'admin',now:()=>now});

test('Fleet rejects unauthorized calls before reading any account or CSV',async()=>{
  let reads=0;const protectedService=createFleetShadowService({db:{collection(){reads++;throw Error('Unexpected read');}},assertAdmin:async()=>{throw Error('denied');}});
  for(const action of ['status','analyze','templates'])await assert.rejects(protectedService[action]({data:input()}),/denied/);
  assert.equal(reads,0);
});
test('status exposes only active driver identity and latest imports, never credentials',async()=>{
  const db=new MemoryStore(seed());for(let i=0;i<35;i++)db.data.set(COLLECTIONS.imports+'/'+i,{updatedAtMs:i});
  const state=await service(db).status({});assert.deepEqual(state.drivers,[{uid:'chofer-1',name:'Chofer de prueba'}]);
  assert.equal(state.history.length,10);assert.equal(state.history[0].updatedAtMs,34);assert.equal(state.apiConnected,false);assert.equal(state.liveEnabled,false);
});
test('analysis and simultaneous saves cannot write payments, invoices, wallets, Telegram or weekly closures',async()=>{
  const db=new MemoryStore(seed());db.data.set('billing_records/existing',{driverUid:'chofer-1',amount:25000,status:'completed'});
  db.data.set('arca_invoices/existing',{status:'authorized'});db.data.set('telegram_notifications/existing',{status:'sent'});
  const protectedBefore=[...db.data.entries()],svc=service(db);
  const preview=await svc.analyze({data:input()});assert.equal(preview.trips.length,1);assert.equal(preview.trips[0].status,'planned');assert.equal(preview.saved,false);assert.deepEqual([...db.data.entries()],protectedBefore);
  const results=await Promise.all([svc.analyze({data:input({persist:true})}),svc.analyze({data:input({persist:true})})]);
  assert.ok(results.every(r=>r.saved));assert.equal(results[1].trips[0].status,'unchanged');
  const added=[...db.data.keys()].filter(key=>!protectedBefore.some(([old])=>old===key));
  assert.ok(added.every(key=>Object.values(COLLECTIONS).some(col=>key.startsWith(col+'/'))));assert.equal(added.length,3);
  for(const [key,value]of protectedBefore)assert.deepEqual(db.data.get(key),value);
});
test('reimport with changed fare is a review, not a silent replacement of facts',async()=>{
  const db=new MemoryStore(seed()),svc=service(db),first=await svc.analyze({data:input({persist:true})});
  const second=await svc.analyze({data:input({persist:true,tripsCsv:CSV_TEMPLATES.trips.replaceAll('10000.00','11000.00'),paymentsCsv:CSV_TEMPLATES.payments.replaceAll('10000.00','11000.00')})});
  assert.equal(second.trips[0].status,'review');assert.ok(second.trips[0].issues.some(i=>i.code==='source_changed'));
  assert.equal(db.data.get(COLLECTIONS.trips+'/'+first.trips[0].id).amountCents,1000000);
  assert.equal(second.differenceCount,1);assert.equal(db.data.get(COLLECTIONS.imports+'/'+second.importId).differences[0].amountCents,1100000);
});
test('association can be fixed after review without creating a second trip',async()=>{
  const db=new MemoryStore(seed()),svc=service(db);
  const first=await svc.analyze({data:input({persist:true,driverMappings:{}})});assert.equal(first.trips[0].status,'review');
  const second=await svc.analyze({data:input({persist:true})});assert.equal(second.trips[0].status,'planned');
  assert.equal(first.trips[0].id,second.trips[0].id);assert.equal([...db.data.keys()].filter(p=>p.startsWith(COLLECTIONS.trips+'/')).length,1);
});
test('existing weekly closure is read again before saving comparison',async()=>{
  const db=new MemoryStore(seed()),svc=service(db);await svc.analyze({data:input()});
  db.data.set('uber_weekly_closures/week',{driverUid:'chofer-1',weekStartDate:'2026-09-22',weekCloseDate:'2026-09-28',status:'completed'});
  const result=await svc.analyze({data:input({persist:true})});assert.ok(result.trips[0].issues.some(i=>i.code==='weekly_closure_overlap'));assert.equal(result.trips[0].walletDeltaCents,null);
});
test('malformed input, inactive mapping and unsupported live requests fail without writes',async()=>{
  const db=new MemoryStore(seed()),svc=service(db),before=[...db.data];
  for(const override of [{mode:'live'},{fleetId:'../flota'},{tripsCsv:'x'.repeat(2_000_001)},{driverMappings:{[driver]:{driverUid:'baja',digitalRecipient:'explora'}}}])await assert.rejects(svc.analyze({data:input({...override,persist:true})}));
  await assert.rejects(svc.analyze({data:input({persist:true,tripsCsv:'bad csv'})}));assert.deepEqual([...db.data],before);
});
test('a truncated historical context fails closed instead of claiming complete reconciliation',async()=>{
  const db=new MemoryStore(seed());for(let i=0;i<1001;i++)db.data.set('billing_records/'+i,{driverUid:'chofer-1'});
  await assert.rejects(service(db).analyze({data:input({persist:true})}),error=>error.code==='resource-exhausted');
  assert.equal([...db.data.keys()].filter(key=>key.startsWith('uber_fleet_shadow_')).length,0);
});
