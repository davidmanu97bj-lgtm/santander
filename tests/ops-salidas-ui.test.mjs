import test from 'node:test';
import assert from 'node:assert/strict';
import {mountOpsSalidasBoard,opsDayKey,parseOpsDateTime,opsDateTimeInput} from '../ops-salidas.js';
function fixture(){
  const elements=new Map();
  const host={innerHTML:'',querySelector(selector){if(!elements.has(selector))elements.set(selector,{innerHTML:'',textContent:'',handlers:{},addEventListener(name,fn){this.handlers[name]=fn;}});return elements.get(selector);}};
  let stamp=Date.parse('2026-09-30T23:59:00-03:00'),payments=[],ready=false,listener,tick,stopped=0;
  const links=[],marks=[],reviews=[];
  const controller=mountOpsSalidasBoard(host,{
    numbers:[57],getDayKey:()=>opsDayKey(stamp),getPayments:()=>payments,paymentsReady:()=>ready,now:()=>stamp,
    listenExits:fn=>{listener=fn;return()=>{stopped++;};},markExit:async draft=>{marks.push(draft);},linkPayment:async pair=>{links.push(pair);},reviewExit:async input=>{reviews.push(input);},
    setIntervalFn:fn=>{tick=fn;return 1;},clearIntervalFn:()=>{tick=null;}
  });controller.start();
  return {controller,e:s=>host.querySelector(s),links,marks,reviews,receive:(rows,r)=>listener(rows,r),advance:date=>{stamp=Date.parse(date);tick();},payments:rows=>{payments=rows;},ready:()=>{ready=true;},stopped:()=>stopped,tick:()=>tick};
}
const choose=f=>f.e('.ops-salidas-chips').handlers.click({target:{closest:()=>({dataset:{opsNumber:'57'}})}});
async function register(f,date,ref){choose(f);f.e('[data-ops-departed-at]').value=date;f.e('[data-ops-source]').value=ref;await f.e('[data-ops-register]').handlers.click();}
const compare=f=>f.e('[data-ops-compare]').handlers.click();
const exit={id:'old',remisNumber:57,dayKey:'2026-09-30',markedAtMs:Date.parse('2026-09-30T23:58:00-03:00'),active:true};
const payment={id:'late',remisNumber:57,type:'billing',createdAtMs:Date.parse('2026-10-01T10:00:00-03:00'),amount:100};

test('panel cambia de día, espera ambos snapshots y compara después de cargar la revisión completa',async()=>{
  const f=fixture();f.receive([exit],true);f.advance('2026-10-01T00:01:00-03:00');
  assert.match(f.e('tbody').innerHTML,/30\/09\/2026/);assert.match(f.e('.ops-salidas-summary').innerHTML,/Salidas hoy<b>0/);assert.match(f.e('.ops-salidas-summary').innerHTML,/Por revisar<b>1/);
  f.payments([payment]);f.controller.refresh();compare(f);assert.equal(f.links.length,0);
  f.ready();f.receive([exit],false);compare(f);assert.equal(f.links.length,0);
  f.receive([exit],true);assert.equal(f.links.length,0);compare(f);await Promise.resolve();
  assert.deepEqual(f.links,[{exitId:'old',paymentId:'late'}]);f.controller.refresh();assert.equal(f.links.length,1);
  f.controller.stop();assert.equal(f.tick(),null);assert.equal(f.stopped(),1);
});

test('dos salidas del mismo número conservan ambas horas y referencias',async()=>{
  const f=fixture();f.receive([],true);await register(f,'2026-09-30T23:58','first');f.advance('2026-10-01T00:02:00-03:00');await register(f,'2026-10-01T00:01','second');
  assert.equal(f.marks.length,2);assert.notEqual(f.marks[0].id,f.marks[1].id);assert.equal(f.marks[0].dayKey,'2026-09-30');assert.equal(f.marks[1].dayKey,'2026-10-01');f.controller.stop();
});

test('panel ambiguo exige elegir un cobro y vincula solamente la fila elegida',async()=>{
  const f=fixture();f.ready();f.payments([payment]);f.receive([exit,{...exit,id:'other',markedAtMs:exit.markedAtMs+1000}],true);compare(f);assert.equal(f.links.length,0);
  const tbody=f.e('tbody');assert.match(tbody.innerHTML,/Elegir cobro/);assert.match(tbody.innerHTML,/no reclamar todavía/);
  tbody.handlers.change({target:{closest:()=>({dataset:{opsSelect:'1'},value:'late'})}});
  tbody.handlers.click({target:{closest:()=>({dataset:{opsLink:'1'}})}});await Promise.resolve();assert.deepEqual(f.links,[{exitId:'other',paymentId:'late'}]);f.controller.stop();
});

test('revisión tardía usa la hora real anterior al cobro, no la del clic',async()=>{
  const f=fixture();f.ready();f.receive([],true);f.advance('2026-10-01T12:00:00-03:00');f.payments([{...payment,createdAtMs:Date.parse('2026-10-01T10:30:00-03:00')}]);
  await register(f,'2026-10-01T10:00','delayed');assert.equal(f.marks[0].markedAtMs,Date.parse('2026-10-01T10:00:00-03:00'));assert.equal(f.e('[data-ops-departed-at]').value,'');
  f.receive(f.marks,true);compare(f);await Promise.resolve();assert.deepEqual(f.links,[{exitId:f.marks[0].id,paymentId:'late'}]);f.controller.stop();
});

test('hora argentina explícita, medianoche anterior, fechas inválidas y futuras',()=>{
  const now=Date.parse('2026-10-01T06:00:00-03:00');assert.equal(parseOpsDateTime('',now),now);
  assert.equal(parseOpsDateTime('2026-09-30T23:59:30',now),Date.parse('2026-10-01T02:59:30Z'));assert.equal(opsDateTimeInput(Date.parse('2026-10-01T03:00:00Z')),'2026-10-01T00:00:00');
  for(const value of ['2026-02-30T10:00','2026-09-31T10:00','2026-10-01T06:01','garbage','2026-10-01T25:00'])assert.throws(()=>parseOpsDateTime(value,now));
});

test('el panel rechaza salida futura y permite la hora actual explícita',async()=>{
  const f=fixture();f.receive([],true);await register(f,'2026-10-02T12:00','future');assert.equal(f.marks.length,0);assert.match(f.e('.ops-salidas-status').textContent,/futura/);
  f.e('[data-ops-now]').handlers.click();await f.e('[data-ops-register]').handlers.click();assert.equal(f.marks[0].markedAtMs,Date.parse('2026-09-30T23:59:00-03:00'));f.controller.stop();
});

test('no registra sin hora real o referencia; elegir número no guarda por sí solo',async()=>{
  const f=fixture();f.receive([],true);choose(f);assert.equal(f.marks.length,0);await f.e('[data-ops-register]').handlers.click();assert.equal(f.marks.length,0);assert.match(f.e('.ops-salidas-status').textContent,/hora real/);
  await register(f,'2026-09-30T10:00','');assert.equal(f.marks.length,0);assert.match(f.e('.ops-salidas-status').textContent,/referencia/);f.controller.stop();
});

test('clasificación guarda revisión operacional con la versión original',async()=>{
  const f=fixture();f.ready();f.receive([exit],true);f.e('[data-ops-review-kind="0"]').value='external_cover';f.e('[data-ops-review-note="0"]').value='Aviso de cobertura externa';
  await f.e('tbody').handlers.click({target:{closest:s=>s==='[data-ops-review]'?{dataset:{opsReview:'0'}}:null}});
  assert.deepEqual(f.reviews,[{exitId:'old',disposition:'external_cover',reviewNote:'Aviso de cobertura externa',expectedRevision:0}]);assert.equal(f.links.length,0);assert.equal(f.marks.length,0);f.controller.stop();
});

test('recarga conserva identidad del mensaje y diferencia otro viaje',async()=>{
  const first=fixture();first.receive([],true);await register(first,'2026-09-30T10:00','WA message 1');first.controller.stop();
  const second=fixture();second.receive(first.marks,true);await register(second,'2026-09-30T10:00','WA message 1');assert.equal(first.marks[0].id,second.marks[0].id);
  await register(second,'2026-09-30T10:00','WA message 2');assert.notEqual(second.marks[0].id,second.marks[1].id);second.controller.stop();
});
