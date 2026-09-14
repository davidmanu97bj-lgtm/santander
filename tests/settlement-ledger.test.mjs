import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {memoryDatabase,Timestamp,FieldValue,Filter,HttpsError} from './support/settlement-memory.mjs';
import {ledgerReceiptRows} from '../financial-store.js';
const require=createRequire(import.meta.url);
const {createSettlementLedger,ACCOUNTS,ENTRIES}=require('../functions/settlement-ledger');
const {createSettlementApi}=require('../functions/settlement-api');
const uid='driver-a';
function setup(legacy=true) {
  const db=memoryDatabase();db.put(`choferes/${uid}`,{uid,displayName:'Chofer de prueba'});
  if(legacy)db.put('billing_records/anchor',{driverUid:uid,type:'reimbursement_compensation',settlementAfter:1406876,createdAt:Timestamp.fromMillis(1000),createdAtMs:1000});
  const ledger=createSettlementLedger({db,Timestamp,FieldValue,Filter,HttpsError,clock:()=>2000});
  const api=createSettlementApi({db,ledger,Timestamp,FieldValue,HttpsError,onCall:(_options,fn)=>fn,
    assertAdmin:async r=>{if(r.auth?.uid!=='admin')throw new HttpsError('permission-denied','not admin');return 'admin';},
    assertViewer:async r=>{if(!r.auth?.uid)throw new HttpsError('unauthenticated','login');return r.auth.uid;}});
  const active=async()=>{const review=await ledger.review(uid);await ledger.activate(uid,review.sourceHash,'admin');};
  const payment=(id,method,amount,requestId=id)=>api.commit({auth:{uid},data:{requestId,reads:[],writes:[{path:`billing_records/${id}`,kind:'set',data:{
    driverUid:uid,method,paymentMethod:method,type:method==='cash'?'billing':'payment',amount,
    settlementRuleVersion:'gross_cash_digital_cashbox_5_v1',createdAtMs:25,
    telegramSettlementBeforeBalance:999999999,telegramSettlementAfterBalance:-999999999,
    idempotencyKey:id,submissionFingerprint:`fingerprint-${id}`,advanceAllocations:[],advanceRepaymentAmount:0
  }}]}});
  return {db,ledger,api,active,payment};
}
test('no activa ni reescribe historia sin revisión de Admin',async()=>{
  const {db,ledger,payment}=setup();const old=JSON.stringify([...db.data]);
  await assert.rejects(payment('digital','digital',85000),e=>e.details?.reason==='settlement-activation-required');
  assert.equal(JSON.stringify([...db.data]),old);
  const review=await ledger.review(uid);assert.equal(review.balance,1406876);assert.equal(JSON.stringify([...db.data]),old);
  db.put('billing_records/extra',{driverUid:uid,amount:20,method:'cash',createdAtMs:1500});
  await assert.rejects(ledger.activate(uid,review.sourceHash,'admin'),e=>e.code==='aborted');
  assert.equal(db.data.has(`${ACCOUNTS}/${uid}`),false);
});
test('reproduce y corrige exactamente el salto de $80.750 con snapshots locales falsos',async()=>{
  const {db,active,payment}=setup();await active();
  await payment('digital','digital',85000);await payment('efectivo','cash',32500);
  const digital=db.data.get('billing_records/digital'),cash=db.data.get('billing_records/efectivo');
  assert.equal(digital.telegramSettlementBeforeBalance,1406876);assert.equal(digital.telegramSettlementAfterBalance,1326126);
  assert.equal(cash.telegramSettlementBeforeBalance,1326126);assert.equal(cash.telegramSettlementAfterBalance,1360251);
  assert.equal(db.data.get(`${ACCOUNTS}/${uid}`).balance,1360251);
  assert.equal(db.data.get(`${ACCOUNTS}/${uid}`).sequence,2);
  assert.equal(db.data.get('billing_records/anchor').settlementAfter,1406876);
  const entries=[...db.data].filter(([p])=>p.startsWith(ENTRIES+'/')).map(([p,d])=>({id:p.split('/')[1],...d}));
  const rows=ledgerReceiptRows(entries);assert.deepEqual(rows.map(r=>[r.confirmedBefore,r.confirmedAfter]),[
    [1406876,1321876],[1321876,1326126],[1326126,1358626],[1358626,1360251]]);
  const commit=db.commits.at(-1);assert.ok(commit.reads.includes(`${ACCOUNTS}/${uid}`));
  assert.ok(commit.writes.includes('billing_records/efectivo'));assert.ok(commit.writes.includes(`${ACCOUNTS}/${uid}`));
  assert.ok(commit.writes.some(p=>p.startsWith(ENTRIES+'/')));
});
test('dos sesiones concurrentes se serializan; los relojes del teléfono no ordenan el libro',async()=>{
  const {db,active,payment}=setup();await active();
  await Promise.all([payment('digital','digital',85000),payment('efectivo','cash',32500)]);
  const account=db.data.get(`${ACCOUNTS}/${uid}`);assert.equal(account.balance,1360251);assert.equal(account.sequence,2);
  const entries=[...db.data].filter(([p])=>p.startsWith(ENTRIES+'/')).map(([,d])=>d).sort((a,b)=>a.sequence-b.sequence);
  assert.equal(entries[1].before,entries[0].after);assert.ok(entries[1].createdAtMs>entries[0].createdAtMs);assert.ok(db.retries>0);
});
test('una respuesta perdida y un nuevo intento del mismo comprobante no duplican saldo ni secuencia',async()=>{
  const {db,active,payment}=setup();await active();
  await payment('cash','cash',10000,'same');await payment('cash','cash',10000,'same');
  await payment('cash','cash',10000,'new-request');
  assert.equal(db.data.get(`${ACCOUNTS}/${uid}`).sequence,1);assert.equal(db.data.get(`${ACCOUNTS}/${uid}`).balance,1417376);
});
test('gastos respetan las tres responsabilidades existentes y generan una única secuencia por gasto',async()=>{
  const {db,api}=setup(false);
  for(const [i,type,rate] of [[1,'combustible',.5],[2,'multa',0],[3,'cubiertas',1]]) {
    await api.commit({auth:{uid},data:{requestId:`expense${i}`,writes:[{path:`gastos/e${i}`,kind:'create',data:{driverUid:uid,amount:10000,
      expenseType:type,receiptFlowVersion:'gross_expense_policy_v3',proofPath:`gastos/${uid}/e/x.jpg`,proofUrl:'https://example.test/a.jpg'}}]}});
    const source=db.data.get(`gastos/e${i}`);assert.equal(source.reimbursementRate,rate);
  }
  assert.equal(db.data.get(`${ACCOUNTS}/${uid}`).balance,15000);assert.equal(db.data.get(`${ACCOUNTS}/${uid}`).sequence,3);
});
test('deuda pendiente no impacta; su aceptación usa la cuenta común',async()=>{
  const {db,api}=setup(false);
  await api.commit({auth:{uid:'admin'},data:{requestId:'debt',writes:[{path:'deudas_choferes/d',kind:'create',data:{driverUid:uid,
    type:'admin_debt',amount:5000,totalAmount:5000,remainingAmount:5000,driverConfirmationRequired:true,acknowledgedByDriver:false,status:'active'}}]}});
  assert.equal(db.data.get(`${ACCOUNTS}/${uid}`).balance,0);
  await api.commit({auth:{uid},data:{requestId:'ack',writes:[{path:'deudas_choferes/d',kind:'set',merge:true,data:{acknowledgedByDriver:true}}]}});
  assert.equal(db.data.get(`${ACCOUNTS}/${uid}`).balance,5000);
});
test('anular un registro crea contrapartida y conserva la entrada original',async()=>{
  const {db,ledger,payment}=setup(false);await payment('cash','cash',10000);
  const first=JSON.stringify(db.data.get(`${ENTRIES}/${uid}_000000000001`));
  await ledger.runTransaction(tx=>tx.delete(db.doc('billing_records/cash')),{actorUid:'admin',reason:'Duplicado real'});
  assert.equal(db.data.get(`${ACCOUNTS}/${uid}`).balance,0);
  assert.equal(JSON.stringify(db.data.get(`${ENTRIES}/${uid}_000000000001`)),first);
  assert.equal(db.data.get(`${ENTRIES}/${uid}_000000000002`).impact,-10500);
});
test('bloquea deriva externa y no corrige dinero silenciosamente',async()=>{
  const {db,active,payment}=setup();await active();
  db.put('billing_records/external',{driverUid:uid,amount:10000,method:'cash',createdAtMs:1500});
  await assert.rejects(payment('cash','cash',10000),e=>e.details?.reason==='settlement-reconciliation-required');
  assert.equal(db.data.has('billing_records/cash'),false);assert.equal(db.data.get(`${ACCOUNTS}/${uid}`).balance,1406876);
});
test('deniega identidad ajena, adelantos inventados y confirmación de Uber desde navegador',async()=>{
  const {api}=setup(false);
  for(const [path,data] of [['billing_records/x',{driverUid:'other',amount:10,method:'cash',type:'billing'}],
    ['uber_weekly_closures/x',{driverUid:uid,amount:10,verifiedAutomatically:true}],
    ['deudas_choferes/x',{driverUid:uid,amount:10,type:'admin_debt'}]]) {
    await assert.rejects(api.commit({auth:{uid},data:{requestId:`bad-${path.split('/')[0]}`,writes:[{path,kind:'create',data}]}}),e=>e.code==='permission-denied');
  }
});
test('revisión histórica detecta la discontinuidad de $80.750 sin inventar un ajuste',async()=>{
 const {db,ledger}=setup(false);
 db.put('billing_records/digital-old',{driverUid:uid,method:'digital',type:'payment',amount:85000,settlementRuleVersion:'gross_cash_digital_cashbox_5_v1',
   createdAtMs:1000,telegramSettlementBeforeBalance:1406876,telegramSettlementAfterBalance:1326126});
 db.put('billing_records/cash-old',{driverUid:uid,method:'cash',type:'billing',amount:32500,settlementRuleVersion:'gross_cash_digital_cashbox_5_v1',
   createdAtMs:1200,telegramSettlementBeforeBalance:1406876,telegramSettlementAfterBalance:1441001});
 const original=JSON.stringify([...db.data]);const review=await ledger.review(uid);
 assert.equal(review.historicDiscontinuityCount,1);assert.equal(review.historicDiscontinuities[0].difference,80750);
 assert.equal(JSON.stringify([...db.data]),original);
});
