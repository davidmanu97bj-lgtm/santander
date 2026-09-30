import test from 'node:test';
import assert from 'node:assert/strict';
import {newExit, opsDayKey, buildOpsBoard, paymentFitsExit} from '../ops-salidas.js';
import {createOpsExitStore} from '../ops-salidas-store.js';
import {MemoryStore} from '../tools/preview/memory-store.mjs';

const time = s => Date.parse(s);
const departure = (id,date,extra={}) => ({id,remisNumber:57,dayKey:opsDayKey(time(date)),markedAtMs:time(date),active:true,...extra});
const charge = (id,date,extra={}) => ({id,remisNumber:57,createdAtMs:time(date),dayKey:opsDayKey(time(date)),amount:50000,type:'billing',status:'completed',...extra});
const board = (exits,payments=[],dayKey='2026-10-01') => buildOpsBoard({exits,payments,dayKey});
function fixture(exits=[],payments=[]) {
  const seed = {'cierres_semanales/close':{amount:15000,status:'approved'},'team_realtime_balances/driver':{balance:24000},
    ...Object.fromEntries(exits.map(({id,...e})=>['ops_number_exits/'+id,e])),
    ...Object.fromEntries(payments.map(({id,...p})=>['billing_records/'+id,p]))};
  const db = new MemoryStore(structuredClone(seed));
  const stamp = time('2026-10-02T10:00:00-03:00');
  const service = createOpsExitStore({db,doc:(_,collection,id)=>db.reference(collection+'/'+id),
    runTransaction:(_,fn)=>db.runTransaction(tx=>fn({...tx,get:async ref=>{const snap=await tx.get(ref);return {...snap,exists:()=>snap.exists};}})),
    serverTimestamp:()=>stamp,now:()=>stamp,getActor:()=>({uid:'admin',name:'Admin'})});
  const rows = () => [...db.data].filter(([key])=>key.startsWith('ops_number_exits/')).map(([key,value])=>({...value,id:key.split('/')[1]}));
  return {db,service,rows,seed};
}

test('varias salidas del mismo número y mismo milisegundo no se pisan; reintentar conserva la hora original',async()=>{
  const {service,rows}=fixture();
  const a=newExit(57,time('2026-09-30T23:59:59-03:00')),b=newExit(57,a.markedAtMs);
  assert.notEqual(a.id,b.id);
  await Promise.all([service.markExit(a),service.markExit(b)]);
  await service.markExit(a);
  assert.equal(rows().length,2);
  assert.equal(rows()[0].markedAtMs,a.markedAtMs);
  assert.equal(rows()[0].dayKey,'2026-09-30');
  await assert.rejects(service.markExit({...a,markedAtMs:a.markedAtMs-1}));
});

test('medianoche argentina, cambio de mes y varios días conservan las pendientes',()=>{
  const e=departure('old','2026-09-30T23:59:59-03:00');
  assert.equal(opsDayKey(time('2026-10-01T02:59:59Z')),'2026-09-30');
  assert.equal(opsDayKey(time('2026-10-01T03:00:00Z')),'2026-10-01');
  for(const day of ['2026-09-30','2026-10-01','2026-10-15']) {
    const result=board([e],[],day);
    assert.equal(result.rows[0].id,'old');
    assert.equal(result.rows[0].markedAtMs,e.markedAtMs);
    assert.equal(result.summary.withoutCharge,1);
    assert.match(result.rows[0].markedLabel,/30\/09\/2026/);
  }
});

test('cobro demorado días: vincula una vez, sin cambiar importes, fechas financieras, saldos ni cierres',async()=>{
  const e=departure('old','2026-09-30T23:55:00-03:00');
  const p=charge('late','2026-10-02T10:00:00-03:00',{invoiceRequest:{serviceDate:'2026-09-30'}});
  const {service,db,rows,seed}=fixture([e],[p]);
  const proposal=board(rows(),[p],'2026-10-02').automaticLinks;
  assert.deepEqual(proposal,[{exitId:'old',paymentId:'late'}]);
  await service.linkPayment(proposal[0]);
  await service.linkPayment(proposal[0]);
  assert.equal(rows()[0].paymentId,'late');
  assert.equal(rows()[0].markedAtMs,e.markedAtMs);
  assert.equal(board(rows(),[p],'2026-10-02').summary.withoutCharge,0);
  for(const [key,value] of Object.entries(seed)) if(!key.startsWith('ops_')) assert.deepEqual(db.data.get(key),value);
  assert.deepEqual([...db.data.keys()].filter(k=>!Object.hasOwn(seed,k)),['ops_exit_payment_links/late']);
});

test('salida cargada retrospectivamente cruza cobro previo a la revisión y conserva auditoría de carga',async()=>{
  const e=newExit(57,time('2026-10-01T23:50:00-03:00'));
  const p=charge('paid-before-review','2026-10-02T00:30:00-03:00');
  const {service,db,rows,seed}=fixture([],[p]);
  await service.markExit(e); // review/load at 02/10 10:00, specified in fixture
  assert.equal(rows()[0].createdAt,time('2026-10-02T10:00:00-03:00'));
  assert.equal(rows()[0].markedAtMs,e.markedAtMs);
  assert.equal(rows()[0].dayKey,'2026-10-01');
  await service.linkPayment(board(rows(),[p],'2026-10-02').automaticLinks[0]);
  assert.equal(rows()[0].paymentId,p.id);
  for(const [key,value] of Object.entries(seed)) assert.deepEqual(db.data.get(key),value);
  await assert.rejects(service.markExit(newExit(57,time('2026-10-03T10:00:00-03:00'))),/inválida/);
});

test('varias pendientes: no adivina la salida y un cobro nunca cancela más de una',async()=>{
  const exits=[departure('first','2026-09-30T22:00:00-03:00'),departure('second','2026-10-01T08:00:00-03:00')];
  const p=charge('p','2026-10-01T10:00:00-03:00');
  const {service,rows}=fixture(exits,[p]);
  assert.deepEqual(board(rows(),[p]).automaticLinks,[]);
  await service.linkPayment({exitId:'second',paymentId:'p'});
  assert.equal(board(rows(),[p]).summary.withoutCharge,1);
  assert.equal(board(rows(),[p]).rows.find(r=>r.id==='first').candidates.length,0);
  await assert.rejects(service.linkPayment({exitId:'first',paymentId:'p'}),/otra salida/);
});

test('dos administradores concurrentes: un cobro queda reservado para una salida',async()=>{
  const {service,rows}=fixture([departure('a','2026-09-30T10:00:00-03:00'),departure('b','2026-09-30T11:00:00-03:00')],[charge('p','2026-10-01T12:00:00-03:00')]);
  const result=await Promise.allSettled(['a','b'].map(exitId=>service.linkPayment({exitId,paymentId:'p'})));
  assert.equal(result.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(rows().filter(r=>r.paymentId).length,1);
});

test('una salida tampoco consume dos cobros concurrentes',async()=>{
  const {service,rows}=fixture([departure('a','2026-09-30T10:00:00-03:00')],[charge('p','2026-10-01T12:00:00-03:00'),charge('q','2026-10-01T13:00:00-03:00')]);
  const result=await Promise.allSettled(['p','q'].map(paymentId=>service.linkPayment({exitId:'a',paymentId})));
  assert.equal(result.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(rows()[0].paymentId,'p');
});

test('los vínculos históricos no se reciclan al recargar o cambiar de día',()=>{
  const p=charge('p','2026-10-01T12:00:00-03:00');
  const exits=[departure('old','2026-09-30T10:00:00-03:00',{paymentId:'p'}),departure('new','2026-10-01T10:00:00-03:00')];
  const result=board(structuredClone(exits),[p],'2026-10-03');
  assert.equal(result.rows.length,1);
  assert.equal(result.rows[0].id,'new');
  assert.equal(result.rows[0].candidates.length,0);
});

test('ignora cobros anteriores, privados, anulados, simulaciones y ajustes',async()=>{
  const e=departure('e','2026-10-01T10:00:00-03:00');
  const invalid=[charge('before','2026-10-01T09:59:00-03:00'),charge('other','2026-10-01T12:00:00-03:00',{remisNumber:28}),
    ...[{viajePrivado:true},{isPrivateTrip:true},{deleted:true},{status:'anulado'},{isSimulated:true},{type:'settlement_adjustment'}].map((extra,i)=>charge('p'+i,'2026-10-01T12:00:00-03:00',extra))];
  const {service}=fixture([e],invalid);
  assert.equal(board([e],invalid).rows[0].candidates.length,0);
  for(const p of invalid) {assert.equal(paymentFitsExit(p,e),false);await assert.rejects(service.linkPayment({exitId:'e',paymentId:p.id}));}
});

test('revalida si el cobro fue anulado después de cargar el panel',async()=>{
  const e=departure('e','2026-10-01T10:00:00-03:00'),p=charge('p','2026-10-01T12:00:00-03:00');
  const {service,db}=fixture([e],[p]);
  db.data.get('billing_records/p').deleted=true;
  await assert.rejects(service.linkPayment({exitId:'e',paymentId:'p'}));
  assert.equal(db.data.has('ops_exit_payment_links/p'),false);
});

test('vincula marcas antiguas conservando el ID, fecha y hora original',async()=>{
  const e=departure('2026-09-30_57','2026-09-30T10:00:00-03:00'),p=charge('p','2026-10-01T12:00:00-03:00');
  const {service,rows}=fixture([e],[p]);
  await service.linkPayment({exitId:e.id,paymentId:p.id});
  assert.equal(rows()[0].markedAtMs,e.markedAtMs);
  assert.equal(rows()[0].dayKey,e.dayKey);
});
