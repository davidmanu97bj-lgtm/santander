import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {MemoryStore} from '../tools/preview/memory-store.mjs';
const require=createRequire(import.meta.url);
const {registerAdminUberWeek,confirmAdminUberWeek,createAdminUberWeekFunction,createDriverConfirmAdminUberWeekFunction,adminUberConfirmationTelegramText}=require('../functions/admin-uber-weekly.js');
const policy=require('../functions/uber-weekly-policy.js');
const {calculateTeamRealtimeSettlementBalance}=require('../functions/telegram-billing-balance.js');
const {periodQuote,confirmPeriodClosure}=require('../functions/period-closure.js');
const uid='driver-confirm-test',now=Date.parse('2026-10-02T15:00:00Z');
const input=(cashAmount=6000,transferAmount=4000)=>({driverUid:uid,cashAmount,transferAmount});
const register=(db,data=input())=>registerAdminUberWeek({db,adminUid:'admin-test',input:data,now});
const accept=(db,id,extra={})=>confirmAdminUberWeek({db,driverUid:uid,input:{closureId:id},now:now+1000,...extra});
const balances=db=>calculateTeamRealtimeSettlementBalance({uberWeeks:[...db.data].filter(([path])=>path.startsWith('uber_weekly_closures/')).map(([path,data])=>({...data,id:path.split('/')[1]}))});

test('alta con sólo dos importes deriva total y semana, exige aceptación y no mueve el saldo',async()=>{
  for(const [cash,digital] of [[10000,0],[0,10000],[6000,4000],[100,.17],[0,0]]) {
    const db=new MemoryStore(),result=await register(db,{...input(cash,digital),driverConfirmationRequired:false,driverConfirmed:true,reviewStatus:'completed'});
    assert.equal(result.record.totalAmount,policy.calculate(input(cash,digital)).total);
    assert.equal(result.record.weekStartDate,'2026-09-21');
    assert.equal(result.record.reviewStatus,'awaiting_driver_confirmation');
    assert.equal(result.record.driverConfirmationRequired,true);assert.equal(result.record.driverConfirmed,false);
    assert.equal(result.record.reconciled,false);assert.equal(result.record.sourceReference,'Carga manual del administrador');
    assert.equal(balances(db).balance,0);assert.equal((await periodQuote({db,uid})).balance,0);
    const confirmed=await accept(db,result.id);
    assert.equal(confirmed.balance,policy.calculate(input(cash,digital)).balance);
    assert.equal(balances(db).balance,confirmed.balance);
    assert.equal(confirmed.record.inputFingerprint,result.record.inputFingerprint);
    assert.equal(confirmed.record.registeredAtMs,now);assert.equal(confirmed.record.createdAtMs,now+1000);
    assert.equal(confirmed.record.driverConfirmedByUid,uid);
  }
});

test('importe total provisto incorrecto y datos de conciliación incompatibles no se aceptan',async()=>{
  for(const extra of [{totalAmount:9999},{cashAmount:-1},{transferAmount:.001},{cashAmount:'6000'},{reconciled:false},{amountBasis:'gross'},{cashRecipient:'explora'},{digitalRecipient:'driver'}]) {
    const db=new MemoryStore();await assert.rejects(register(db,{...input(),...extra}));assert.equal(db.data.size,0);
  }
});

test('callables toman la identidad autenticada y prohíben confirmar un cierre ajeno',async()=>{
  const db=new MemoryStore(),result=await register(db),before=JSON.stringify([...db.data]);
  const rejected=createDriverConfirmAdminUberWeekFunction({db,assertViewer:async()=>{throw Error('not authenticated');}});
  await assert.rejects(rejected.run({data:{closureId:result.id}}),/not authenticated/);
  const foreign=createDriverConfirmAdminUberWeekFunction({db,assertViewer:async()=>'another-driver'});
  await assert.rejects(foreign.run({data:{closureId:result.id,driverUid:uid}}),/no pertenece/);
  assert.equal(JSON.stringify([...db.data]),before);
  const owner=createDriverConfirmAdminUberWeekFunction({db,assertViewer:async()=>uid,now:()=>now+1000});
  const accepted=await owner.run({data:{closureId:result.id,driverUid:'another-driver',cashAmount:999999}});
  assert.equal(accepted.record.cashAmount,6000);assert.equal(accepted.balance,2000);
  let reads=0;
  const admin=createAdminUberWeekFunction({db,assertAdmin:async()=>{throw Error('not admin');},getProfile:async()=>{reads++;}});
  await assert.rejects(admin.run({data:input()}),/not admin/);assert.equal(reads,0);
});

test('concurrencia, doble toque y reintento de registro conservan una sola semana y un impacto',async()=>{
  const db=new MemoryStore(),registrations=await Promise.all(Array.from({length:8},()=>register(db)));
  assert.equal(registrations.filter(row=>!row.alreadyRegistered).length,1);
  const id=registrations[0].id,results=await Promise.all(Array.from({length:8},()=>accept(db,id)));
  assert.equal(results.filter(row=>!row.alreadyConfirmed).length,1);assert.equal(balances(db).balance,2000);
  const before=JSON.stringify([...db.data]);
  assert.equal((await register(db)).alreadyRegistered,true);
  assert.equal((await accept(db,id,{now:now+100000})).alreadyConfirmed,true);
  assert.equal(JSON.stringify([...db.data]),before);
  await assert.rejects(register(db,input(5000,5000)),/ya tiene un cierre/);
});

test('aceptar tras un ancla o cierre ingresa a la fecha efectiva sin perder la fecha original',async()=>{
  const db=new MemoryStore(),result=await register(db);
  db.data.set('billing_records/anchor',{id:'anchor',driverUid:uid,type:'reimbursement_compensation',settlementAfter:321.45,createdAtMs:now+500});
  assert.equal((await periodQuote({db,uid})).balance,321.45);
  const confirmed=await accept(db,result.id);
  assert.equal(confirmed.record.telegramSettlementBeforeBalance,321.45);assert.equal(confirmed.balance,2321.45);
  const quote=await periodQuote({db,uid});assert.equal(quote.balance,2321.45);assert.equal(quote.presentation.uber.recordCount,1);
  await confirmPeriodClosure({db,uid,input:{quoteId:quote.quoteId,proofPath:`cierres_semanales/period/${uid}/${quote.quoteId}/proof.png`},
    proofMetadata:async()=>({size:100,contentType:'image/png',url:'https://example.test/proof'}),now:now+2000});
  assert.equal((await periodQuote({db,uid})).balance,0);
  assert.equal((await accept(db,result.id,{now:now+3000})).alreadyConfirmed,true);
  assert.equal((await periodQuote({db,uid})).balance,0);
});

test('confirmación nueva no altera ni reinterpreta semanas históricas completed',async()=>{
  const db=new MemoryStore(),result=await register(db),path='uber_weekly_closures/'+result.id;
  const historical={...result.record,driverConfirmationRequired:undefined,driverConfirmed:undefined,status:'completed',reviewStatus:'completed'};
  db.data.set(path,historical);assert.equal(policy.confirmed(historical),true);assert.equal(balances(db).balance,2000);
  const before=JSON.stringify([...db.data]);await assert.rejects(accept(db,result.id),/confirmación anterior/);
  assert.equal(JSON.stringify([...db.data]),before);
  assert.equal(policy.confirmed({...historical,driverConfirmationRequired:true,driverConfirmed:false}),false);
});

test('aceptar inmediatamente tras cerrar el período conserva la semana visible y la liquida una sola vez',async()=>{
  const db=new MemoryStore({'billing_records/cash':{driverUid:uid,method:'cash',amount:1000,createdAtMs:now-1000,settlementRuleVersion:'net_wallets_cashbox_10_v1'}});
  const pending=await register(db),quote=await periodQuote({db,uid});assert.equal(quote.balance,600);
  await confirmPeriodClosure({db,uid,input:{quoteId:quote.quoteId,proofPath:`cierres_semanales/period/${uid}/${quote.quoteId}/proof.png`},
    proofMetadata:async()=>({size:100,contentType:'image/png',url:'https://example.test/proof'}),now:now+1000});
  assert.equal((await periodQuote({db,uid})).balance,0);
  const accepted=await accept(db,pending.id);assert.equal(accepted.balance,2000);assert.equal(accepted.record.createdAtMs,now+1001);
  const after=await periodQuote({db,uid});assert.equal(after.balance,2000);assert.equal(after.presentation.uber.recordCount,1);
  assert.equal((await accept(db,pending.id,{now:now+2000})).alreadyConfirmed,true);
  assert.equal((await periodQuote({db,uid})).quoteId,after.quoteId);
});

test('rechazado, eliminado o simulado no puede confirmarse',async()=>{
  for(const extra of [{reviewStatus:'rejected'},{deleted:true},{isSimulated:true},{adminConfirmed:false}]) {
    const db=new MemoryStore(),result=await register(db),path='uber_weekly_closures/'+result.id;
    db.data.set(path,{...result.record,...extra});const before=JSON.stringify([...db.data]);
    await assert.rejects(accept(db,result.id),/no está pendiente/);assert.equal(JSON.stringify([...db.data]),before);
  }
});

const indexSource=fs.readFileSync(new URL('../functions/index.js',import.meta.url),'utf8');
const declaration=name=>{
  const match=indexSource.match(new RegExp(`^(?:async )?function ${name}\\(`,'m'));
  assert.ok(match,`missing ${name}`);
  const tail=indexSource.slice(match.index),end=/^}\r?$/m.exec(tail);
  return tail.slice(0,end.index+1);
};
test('Telegram espera aceptación, entrega sólo texto con caja/saldo y deduplica el evento',async()=>{
  const db=new MemoryStore(),result=await register(db),pending=result.record;
  const confirmed=(await accept(db,result.id)).record;
  // Add document writes to the offline store to exercise the actual notification
  // claim and delivery functions, replacing only the external send operation.
  const reference=db.reference.bind(db);
  db.reference=(...args)=>{const ref=reference(...args);ref.set=async(data,options)=>{db.data.set(ref.path,options?.merge?{...db.data.get(ref.path),...data}:data);};return ref;};
  const sent=[];
  const methods=['notifyConfirmedAdminUberWeek','uberTelegramText','telegramProcessNotification','telegramClaimNotification','telegramNotificationDocId','telegramSafeText'];
  const context={db,uberWeeklyPolicy:policy,adminUberConfirmationTelegramText,Date,Intl,console,
    FieldValue:{serverTimestamp:()=>new Date(),increment:value=>value,delete:()=>null},
    TELEGRAM_NOTIFICATIONS_COLLECTION:'telegram_notifications',TELEGRAM_PROCESSING_LEASE_MS:120000,
    telegramDriverName:data=>data.driverName,telegramDateTimeLines:()=>[],
    telegramSendText:async text=>{sent.push(text);return {message_id:sent.length,chat:{id:'offline'}};},
    telegramResolvePhotoUrl:async()=>{throw Error('photo must not be requested');}};
  const notify=vm.runInNewContext(methods.map(declaration).join('\n')+'\nnotifyConfirmedAdminUberWeek',context);
  const event=(before,after)=>({id:'event-test',params:{docId:result.id},data:{before:{exists:!!before,data:()=>before},after:{exists:!!after,data:()=>after}}});
  assert.equal((await notify(event(null,pending))).skipped,true);assert.equal(sent.length,0);
  const results=await Promise.all(Array.from({length:8},()=>notify(event(pending,confirmed))));
  assert.equal(results.filter(row=>row.sent).length,1);assert.equal(sent.length,1);
  for(const label of ['aceptado por el chofer','Efectivo:','Digital:','Total Uber:','Caja chica 10%:','1.000','Chofer debe','2.000'])assert.ok(sent[0].includes(label),label);
  await notify(event(pending,confirmed));await notify(event(confirmed,{...confirmed,updatedAtMs:now+9000}));assert.equal(sent.length,1);
  assert.match(indexSource,/if\(after\.settlementWorkflowVersion===uberWeeklyPolicy\.WORKFLOW\)return notifyConfirmedAdminUberWeek\(event\)/);
});
