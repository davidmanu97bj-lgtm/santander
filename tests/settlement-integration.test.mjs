import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {memoryDatabase,Timestamp,FieldValue} from './support/settlement-memory.mjs';
import {loadServer} from './support/load-server.mjs';
import {createFinancialStore} from '../financial-store.js';
const admin='2LziyTTdFcZzSOhK3hLbAKs2U4s2',uid='driver-x';
const now=Date.parse('2026-09-22T12:00:00Z');
function setup(){
 const db=memoryDatabase();db.put(`choferes/${uid}`,{uid,authUid:uid,active:true,role:'driver',displayName:'Prueba'});
 const {handlers:h,load}=loadServer(db,{now});let n=0;
 const write=(writes,by=uid,reads=[])=>h.commitFinancialOperation({auth:{uid:by},data:{requestId:`integration_${++n}`,writes,reads}});
 const pay=(id,method,amount)=>write([{path:`billing_records/${id}`,kind:'create',data:{driverUid:uid,type:method==='cash'?'billing':'payment',method,amount,advanceAllocations:[],advanceRepaymentAmount:0}}]);
 const account=()=>db.data.get(`driver_settlement_accounts/${uid}`);
 return {db,h,load,write,pay,account};
}
test('handlers reales: modifica y anula manteniendo una única secuencia y audit',async()=>{
 const {db,h,pay,account}=setup();await pay('cash','cash',10000);
 const first=JSON.stringify(db.data.get(`driver_settlement_entries/${uid}_000000000001`));
 await h.adminModifyBillingAmount({auth:{uid:admin},data:{documentId:'cash',newAmount:20000,reason:'Importe incorrecto'}});
 assert.equal(account().balance,21000);assert.equal(account().sequence,2);
 assert.equal(db.data.get('billing_records/cash').createdAtMs,now);
 const audit=[...db.data].filter(([path])=>path.startsWith('admin_audit/')).map(([,row])=>row);
 assert.equal(audit[0].telegramSettlementAfterBalance,21000);assert.equal(audit[0].financialSequence,2);
 await h.adminDeleteFinancialMovement({auth:{uid:admin},data:{type:'cobro',documentId:'cash',reason:'Anulación comprobada'}});
 assert.equal(account().balance,0);assert.equal(account().sequence,3);
 assert.equal(db.data.has('billing_records/cash'),false);assert.equal(JSON.stringify(db.data.get(`driver_settlement_entries/${uid}_000000000001`)),first);
});
test('handlers reales: gasto, corrección de reintegro y caja digital separada',async()=>{
 const {h,write,pay,account,db}=setup();
 await write([{path:'gastos/g',kind:'create',data:{driverUid:uid,amount:35000,expenseType:'combustible',receiptFlowVersion:'gross_expense_policy_v3',proofPath:`gastos/${uid}/proof.jpg`,proofUrl:'https://example.test/proof'}}]);
 assert.equal(account().balance,17500);
 await h.adminModifyExpenseAmount({auth:{uid:admin},data:{documentId:'g',newAmount:40000}});
 assert.equal(account().balance,20000);
 await pay('digital','digital',10000);assert.equal(account().balance,10500);
 await h.adminDeleteFinancialMovement({auth:{uid:admin},data:{type:'caja_chica',documentId:'digital'}});
 assert.equal(account().balance,10000);assert.equal(db.data.get('billing_records/digital').excludeFromCashbox,true);
});
test('Uber verificado utiliza el mismo saldo; reintento no duplica prueba ni entrada',async()=>{
 const {db,h,pay,account,load}=setup();await pay('cash','cash',10000);
 const week=load('uber-proof.js').eligibleUberWeek(new Date(now));
 const id='verified-proof';db.put(`uber_proof_checks/${id}`,{uid,valid:true,amount:100000,weekStartDate:week.start,weekCloseDate:week.close,
  proofPath:`uber_verified/${uid}/x.jpg`,proofUrl:'https://example.test/uber',expiresAt:Timestamp.fromMillis(now+3600000)});
 const request={auth:{uid},data:{amount:100000,weekStartDate:week.start,weekCloseDate:week.close,verifiedProofId:id}};
 const result=await h.registerUberLiquidation(request);assert.equal(result.record.telegramSettlementBeforeBalance,10500);
 assert.equal(result.record.telegramSettlementAfterBalance,115500);assert.equal(account().balance,115500);
 const repeated=await h.registerUberLiquidation(request);assert.equal(repeated.alreadyRegistered,true);assert.equal(account().sequence,2);
 await h.adminDeleteFinancialMovement({auth:{uid:admin},data:{type:'uber',documentId:result.id,reason:'Error de carga'}});
 assert.equal(account().balance,10500);assert.equal(account().sequence,3);
});
test('Gestión usa ±100%, ignora saldos del navegador y rechaza simulación',async()=>{
 const {pay,write,account}=setup();await pay('cash','cash',10000);
 const row={driverUid:uid,amount:2000,type:'settlement_adjustment',internalManagement:true,internalSettlementAdjustment:true,
  sourceModule:'gestion',adjustmentDirection:'driver_to_explora',method:'digital',proofPath:`billing_receipts/${uid}/proof`,proofUrl:'https://example.test/proof',telegramSettlementAfterBalance:0};
 await write([{path:'billing_records/gestion',kind:'create',data:row}]);assert.equal(account().balance,8500);
 await assert.rejects(write([{path:'billing_records/sim',kind:'create',data:{...row,verificationMode:'simulation'}}]),e=>e.code==='permission-denied');
 assert.equal(account().sequence,2);
});
test('cierre pendiente no mueve saldo; un pago concurrente usa revisión de servidor',async()=>{
 const {pay,write,account,db}=setup();await pay('cash','cash',10000);
 const closure={driverUid:uid,amountDueFromDriver:10500,remainingAmount:10500,requestedAmount:10500,settlementAmount:10500,requestedPaymentAmount:10500,
  paidAmountTotal:0,paymentDirection:'driver_to_explora',createdByRole:'driver',reviewStatus:'pending',status:'awaiting_admin_review',closureMode:'settlement_only',closureKind:'facturacion'};
 await write([{path:'cierres_semanales/close',kind:'create',data:closure}]);assert.equal(account().balance,10500);assert.equal(account().sequence,2);
 const revision=db.data.get('cierres_semanales/close').financialRevision;
 await write([{path:'cierres_semanales/close',kind:'update',data:{status:'completed',reviewStatus:'approved',paidAmountTotal:10500,remainingAmount:0}},
  {path:'billing_records/close-payment',kind:'create',data:{driverUid:uid,type:'settlement_adjustment',adjustmentDirection:'driver_to_explora',affectsBillingSettlement:true,amount:10500,method:'cash',status:'completed'}}],admin,[{path:'cierres_semanales/close',exists:true,revision}]);
 assert.equal(account().balance,0);assert.equal(account().sequence,3);
 await assert.rejects(write([{path:'cierres_semanales/close',kind:'update',data:{paidAmountTotal:21000}}],admin,[{path:'cierres_semanales/close',exists:true,revision}]),e=>e.code==='aborted');
 assert.equal(account().balance,0);
});
test('dos solicitudes de adelanto concurrentes no se aprueban ni duplican',async()=>{
 const {write,account,db}=setup();
 const advance={driverUid:uid,type:'cash_advance',principalAmount:10000,approvalStatus:'pending',status:'pending_admin_approval',remainingAmount:0,repaidAmount:0};
 const outcomes=await Promise.allSettled(['a','b'].map(id=>write([{path:`prestamos_operativos/${id}`,kind:'create',data:advance}])));
 assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);assert.equal(account().balance,0);
 assert.equal([...db.data.keys()].filter(path=>path.startsWith('prestamos_operativos/')).length,1);
});
test('adaptador del navegador: respuesta perdida reintenta misma clave sin write directo',async()=>{
 const {h,db,account}=setup();let calls=0;const ids=[];
 const store=createFinancialStore({db,sdk:{serverTimestamp:FieldValue.serverTimestamp,deleteField:FieldValue.delete},newId:()=> 'same',sleep:async()=>{},
  commit:async input=>{ids.push(input.requestId);const result=await h.commitFinancialOperation({auth:{uid},data:input});if(++calls===1){const e=new Error('lost');e.code='functions/unavailable';throw e;}return {data:result};}});
 await store.setDoc({path:'billing_records/mobile'},{driverUid:uid,type:'billing',method:'cash',amount:10000,createdAt:FieldValue.serverTimestamp()});
 assert.equal(calls,2);assert.equal(ids[0],ids[1]);assert.equal(account().sequence,1);assert.equal(account().balance,10500);
 assert.equal(db.data.get('billing_records/mobile').createdAtMs,now);
});
test('adaptador: dos lectores de la misma deuda no pisan actualizaciones',async()=>{
 const {h,db,write,account}=setup();
 await write([{path:'deudas_choferes/d',kind:'create',data:{driverUid:uid,type:'admin_debt',amount:1000,remainingAmount:1000,status:'active',acknowledgedByDriver:true,driverConfirmationRequired:true}}],admin);
 let ids=0;
 const sdk={serverTimestamp:FieldValue.serverTimestamp,deleteField:FieldValue.delete,
  getDocFromServer:async ref=>{const s=await db.doc(ref.path).get();return {id:s.id,data:s.data,exists:()=>s.exists};}};
 const adapter=createFinancialStore({db,sdk,newId:()=>`client_${++ids}`,sleep:async()=>{},commit:async data=>({data:await h.commitFinancialOperation({auth:{uid:admin},data})})});
 const update=()=>adapter.runTransaction(db,async tx=>{const ref={path:'deudas_choferes/d'},snap=await tx.get(ref);tx.update(ref,{remainingAmount:snap.data().remainingAmount-100});});
 await Promise.all([update(),update()]);assert.equal(db.data.get('deudas_choferes/d').remainingAmount,800);assert.equal(account().balance,800);assert.equal(account().sequence,3);
});
test('las reglas bloquean escrituras financieras directas, también para Admin',()=>{
 const rules=fs.readFileSync(new URL('../firestore.rules',import.meta.url),'utf8');
 for(const name of ['billing_records','gastos','uber_weekly_closures','cierres_semanales','deudas_choferes','deuda_pagos','prestamos_operativos','deuda_movimientos']){
  const start=rules.indexOf(`match /${name}/`);assert.ok(start>=0);const next=rules.indexOf('\n    match /',start+1);const block=rules.slice(start,next<0?undefined:next);
  const permissions=[...block.matchAll(/allow\s+([^:]+):\s*if\s+([^;]+);/g)].filter(match=>/create|update|delete|write/.test(match[1]));
  assert.ok(permissions.length);for(const match of permissions) assert.equal(match[2].trim(),'false');
 }
});
test('intereses diarios concurrentes: una sola aplicación, deuda y cuenta juntas',async()=>{
 const {db,h,account}=setup();
 db.put('deudas_choferes/penalty-debt',{driverUid:uid,type:'admin_debt',amount:1000,remainingAmount:1000,status:'active',
  acknowledgedByDriver:true,driverConfirmationRequired:true,penaltyEnabled:true,penaltyDailyRate:.03,
  penaltyStartAtMs:now-86400000,createdAt:Timestamp.fromMillis(now-17*86400000),createdAtMs:now-17*86400000});
 const reviewed=await h.reviewSettlementAccount({auth:{uid:admin},data:{driverUid:uid}});
 await h.activateSettlementAccount({auth:{uid:admin},data:{driverUid:uid,sourceHash:reviewed.sourceHash,confirmReviewed:true}});
 await Promise.all([h.applyDailyDebtPenalties(),h.applyDailyDebtPenalties()]);
 assert.equal(account().sequence,1);assert.equal(account().balance,1060.90);
 assert.equal(db.data.get('deudas_choferes/penalty-debt').remainingAmount,1060.90);
 assert.equal([...db.data.keys()].filter(path=>path.startsWith('deuda_movimientos/')).length,1);
});
test('el evento Tiempo real atrasado publica la cuenta vigente, no un valor calculado antes',async()=>{
 const {db,h,pay,account}=setup();
 await pay('cash','cash',10000);
 const event={data:{before:{exists:false,data:()=>({})},after:{exists:true,data:()=>({driverUid:uid,amount:10000})}}};
 await pay('digital','digital',10000);
 await h.onTeamRealtimeBillingWriteV1(event);
 assert.equal(db.data.get(`team_realtime_balances/${uid}`).settlementBalance,1000);
 assert.equal(db.data.get(`team_realtime_balances/${uid}`).sequence,account().sequence);
});
test('fecha de creación anterior al corte no se vuelve a incluir por una edición reciente',()=>{
 const {load}=setup();const calculate=load('telegram-billing-balance.js').calculateTeamRealtimeSettlementBalance;
 const closure={driverUid:uid,closureKind:'facturacion',closureMode:'on_demand',status:'completed',cutoffAtMs:2000};
 const records=[{driverUid:uid,method:'cash',amount:10000,createdAt:Timestamp.fromMillis(1000),createdAtMs:1000,updatedAt:Timestamp.fromMillis(3000)}];
 assert.equal(calculate({records,closures:[closure]}).balance,0);
});
test('reset o borrado de perfil no destruyen identidad, saldo ni historial',async()=>{
 const {db,h,pay,account}=setup();await pay('cash','cash',10000);
 const prior=JSON.stringify([...db.data]);
 for(const [name,data] of [['adminUpdateDriver',{driverId:uid,deleteDriver:true}],
  ['adminResetDriverOperationalData',{driverId:uid}],['adminDeleteDriverCompletely',{driverId:uid}]]) {
  await assert.rejects(h[name]({auth:{uid:admin},data}),e=>e.code==='failed-precondition');
 }
 assert.equal(JSON.stringify([...db.data]),prior);assert.equal(account().balance,10500);
});
