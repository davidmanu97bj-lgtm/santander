import test from 'node:test';
import assert from 'node:assert/strict';
import {referencedExit, opsDayKey, buildOpsBoard, paymentFitsExit} from '../ops-salidas.js';
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
  const a=await referencedExit({remisNumber:57,markedAtMs:time('2026-09-30T23:59:59-03:00'),sourceRef:'message-a'}),b=await referencedExit({...a,sourceRef:'message-b'});
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
  const e=await referencedExit({remisNumber:57,markedAtMs:time('2026-10-01T23:50:00-03:00'),sourceRef:'retrospective'});
  const p=charge('paid-before-review','2026-10-02T00:30:00-03:00');
  const {service,db,rows,seed}=fixture([],[p]);
  await service.markExit(e); // review/load at 02/10 10:00, specified in fixture
  assert.equal(rows()[0].createdAt,time('2026-10-02T10:00:00-03:00'));
  assert.equal(rows()[0].markedAtMs,e.markedAtMs);
  assert.equal(rows()[0].dayKey,'2026-10-01');
  await service.linkPayment(board(rows(),[p],'2026-10-02').automaticLinks[0]);
  assert.equal(rows()[0].paymentId,p.id);
  for(const [key,value] of Object.entries(seed)) assert.deepEqual(db.data.get(key),value);
  await assert.rejects(service.markExit(await referencedExit({...e,markedAtMs:time('2026-10-03T10:00:00-03:00')})),/inválida/);
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
  assert.equal(result.rows.length,2);
  assert.equal(result.rows.find(r=>r.id==='old').status,'matched');
  assert.equal(result.rows.find(r=>r.id==='new').candidates.length,0);
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

test('08:00 salida, 08:30 cobro, 10:00 registro: usa la salida real y conserva ambos tiempos',async()=>{
  const p=charge('paid','2026-10-02T08:30:00-03:00');
  const {service,rows}=fixture([],[p]);
  const e=await referencedExit({remisNumber:57,markedAtMs:time('2026-10-02T08:00:00-03:00'),sourceRef:'WA-0800'});
  await service.markExit(e);
  const result=board(rows(),[p],'2026-10-02');
  assert.deepEqual(result.automaticLinks,[{exitId:e.id,paymentId:p.id}]);
  assert.equal(rows()[0].createdAt,time('2026-10-02T10:00:00-03:00'));
  await service.linkPayment(result.automaticLinks[0]);
  assert.equal(rows()[0].markedAtMs,time('2026-10-02T08:00:00-03:00'));
});

test('referencia estable tras recarga y dos administradores crean una sola salida',async()=>{
  const {service,rows,db}=fixture();
  const source={remisNumber:57,markedAtMs:time('2026-10-01T08:00:00-03:00'),sourceRef:'  WA mensaje 57  '};
  const a=await referencedExit(source),b=await referencedExit({...source,sourceRef:'WA  mensaje 57'});
  const results=await Promise.all([service.markExit(a),service.markExit(b)]);
  assert.equal(a.id,b.id);assert.equal(rows().length,1);
  assert.equal(results.filter(r=>r.duplicate).length,1);
  const saved=structuredClone([...db.data]);
  const reloaded=await referencedExit(JSON.parse(JSON.stringify(source)));
  assert.equal((await service.markExit(reloaded)).duplicate,true);
  assert.deepEqual([...db.data],saved);
  await assert.rejects(service.markExit(await referencedExit({...source,markedAtMs:source.markedAtMs+60000})),/ya identifica/);
  assert.equal(rows().length,1);
});

test('ambigüedad en cualquiera de los sentidos queda por revisar y nunca habilita reclamo',()=>{
  const a=departure('a','2026-10-01T08:00:00-03:00'),b=departure('b','2026-10-01T09:00:00-03:00');
  const p=charge('p','2026-10-01T10:00:00-03:00'),q=charge('q','2026-10-01T11:00:00-03:00');
  for(const [exits,payments] of [[[a,b],[p]],[[a],[p,q]]]){
    const result=board(exits,payments);assert.deepEqual(result.automaticLinks,[]);
    assert.equal(result.summary.withoutCharge,0);
    for(const row of result.rows){assert.equal(row.status,'review');assert.equal(row.canRemind,false);}
  }
});

test('pendientes anteriores a 06:00 y de días previos mantienen antigüedad; sin servidor no reclamar',()=>{
  const e=departure('old','2026-09-30T04:00:00-03:00');
  const input={exits:[e],payments:[],dayKey:'2026-10-02',now:time('2026-10-02T06:00:00-03:00')};
  const row=buildOpsBoard(input).rows[0];assert.equal(row.status,'missing_charge');assert.equal(row.canRemind,true);assert.equal(row.ageLabel,'2 d 2 h 0 min');
  const waiting=buildOpsBoard({...input,dataReady:false}).rows[0];assert.equal(waiting.status,'review');assert.equal(waiting.canRemind,false);
});

test('exclusión se aplica a un evento; reemplazo interno sí necesita cobro',async()=>{
  const a=departure('a','2026-10-01T08:00:00-03:00',{disposition:'external_cover'}),b=departure('b','2026-10-01T09:00:00-03:00',{disposition:'internal_cover'});
  const p=charge('p','2026-10-01T10:00:00-03:00');
  for(const disposition of ['external_cover','uber']){
    const excluded={...a,disposition},result=board([excluded,b],[p]);
    assert.equal(result.rows[0].status,'excluded');assert.equal(result.rows[0].canRemind,false);
    assert.deepEqual(result.automaticLinks,[{exitId:'b',paymentId:'p'}]);
    const {service}=fixture([excluded,b],[p]);await assert.rejects(service.linkPayment({exitId:'a',paymentId:'p'}));
  }
});

test('cobertura por confirmar impide adjudicar automáticamente su posible cobro a otra salida',()=>{
  const a=departure('a','2026-10-01T08:00:00-03:00',{disposition:'review'}),b=departure('b','2026-10-01T09:00:00-03:00');
  const result=board([a,b],[charge('p','2026-10-01T10:00:00-03:00')]);
  assert.deepEqual(result.automaticLinks,[]);assert.ok(result.rows.every(r=>r.status==='review'&&!r.canRemind));
});

test('Pago a Explora, gastos, cierres y ajustes no cancelan viajes',()=>{
  const e=departure('a','2026-10-01T08:00:00-03:00');
  for(const extra of [{type:'admin_billing_settlement_payment'},{category:'Pago a Explora'},{sourceModule:'expense'},{movementType:'cierre'},{type:'settlement_adjustment'},{operationType:'driver_payment'},{affectsBillingSettlement:true}]){
    assert.equal(paymentFitsExit(charge('p','2026-10-01T10:00:00-03:00',extra),e),false);
  }
});

test('revisiones simultáneas y exclusión frente a cobro no pisan cambios ni tocan finanzas',async()=>{
  const e=departure('a','2026-10-01T08:00:00-03:00'),p=charge('p','2026-10-01T10:00:00-03:00');
  const {service,rows,db,seed}=fixture([e],[p]);
  const results=await Promise.allSettled(['external_cover','uber'].map(disposition=>service.reviewExit({exitId:'a',disposition,reviewNote:'Aviso WhatsApp',expectedRevision:0})));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(rows()[0].reviewRevision,1);
  await assert.rejects(service.linkPayment({exitId:'a',paymentId:'p'}));
  await service.reviewExit({exitId:'a',disposition:'internal_cover',reviewNote:'Reemplazo confirmado',expectedRevision:1});
  await service.linkPayment({exitId:'a',paymentId:'p'});
  await assert.rejects(service.reviewExit({exitId:'a',disposition:'uber',reviewNote:'Tardío',expectedRevision:2}),/vinculada/);
  for(const [key,value] of Object.entries(seed))if(!key.startsWith('ops_'))assert.deepEqual(db.data.get(key),value);
});

test('cobro vinculado invalidado queda por revisar y reservado; no crea otro reclamo',()=>{
  const a=departure('a','2026-10-01T08:00:00-03:00',{paymentId:'p'}),b=departure('b','2026-10-01T09:00:00-03:00');
  const result=board([a,b],[charge('p','2026-10-01T10:00:00-03:00',{deleted:true})]);
  assert.equal(result.rows[0].status,'review');assert.equal(result.rows[0].canRemind,false);assert.equal(result.rows[1].candidates.length,0);
});
