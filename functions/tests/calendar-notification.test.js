const test=require('node:test'),assert=require('node:assert/strict');
const {createCalendarNotifier,precedes}=require('../calendar-notification');
const compact=require('../telegram-compact');
const time=(seconds,nanoseconds=0)=>({seconds,nanoseconds});
function fixture(rows) {
  const plans=new Map(),sent=new Map(),attempts=[];let failCoincidence=false;
  const db={collection:name=>({doc:id=>({name,id}),where:()=>({query:true})}),runTransaction:async run=>run({
    get:async target=>target.query?{docs:rows.map(row=>({id:row.id,data:()=>row}))}:{exists:plans.has(target.id),data:()=>plans.get(target.id)},
    set:(target,data)=>plans.set(target.id,data)
  })};
  const handler=createCalendarNotifier({db,compact,notificationKey:(data,id)=>data.driverUid+'_'+id,
    notify:async payload=>{const key=payload.kind+'_'+payload.notificationKey;attempts.push(key);
      if(payload.kind==='calendar_coincidence'&&failCoincidence){failCoincidence=false;throw new Error('network');}
      if(!sent.has(key))sent.set(key,payload);
    }});
  const event=row=>({params:{docId:row.id},id:'event-'+row.id,data:{id:row.id,data:()=>row}});
  return {handler,plans,sent,attempts,event,failOnce:()=>failCoincidence=true};
}
const trip=(id,seconds,patch={})=>({id,version:'trip_calendar_v1',driverUid:id,driverName:'Chofer '+id,
  serviceDate:'2026-09-14',detail:'PRIVATE DETAIL',phone:'+5491111111111',createdAt:time(seconds),...patch});
test('one trip produces only a short driver/date notification, never passenger data',async()=>{
  const row=trip('a',1),f=fixture([row]);
  assert.deepEqual(await f.handler(f.event(row)),{notifications:1});assert.equal(f.sent.size,1);
  const message=[...f.sent.values()][0];assert.equal(message.caption,'🗓 Viaje agendado\n👤 Chofer a\n📅 14/09/2026');
  assert.equal(message.requirePhoto,false);assert.equal(message.sourceCollection,'trip_calendar');
  assert.doesNotMatch(message.caption,/PRIVATE|549|Saldo/);
});
test('second same-day trip produces one normal notice and one coincidence, including own trips',async()=>{
  const a=trip('a',1),b=trip('b',2,{driverUid:'a',driverName:'Chofer a'}),future=trip('c',3);
  const f=fixture([a,b,future]);await f.handler(f.event(b));assert.equal(f.sent.size,2);
  assert.equal(f.plans.get('b').coincidences,1);
  assert.deepEqual(f.plans.get('b').otherDrivers,['Chofer a']);
  assert.match([...f.sent.values()][1].caption,/Coincidencia en Todos/);
  assert.doesNotMatch([...f.sent.values()][1].caption,/PRIVATE|549/);
});
test('notification retries keep a stable decision and independently retry the second notice',async()=>{
  const a=trip('a',1),b=trip('b',2),rows=[a,b],f=fixture(rows);f.failOnce();
  await assert.rejects(f.handler(f.event(b)),/network/);assert.equal(f.sent.size,1);
  rows.length=0;rows.push(trip('later',4));await f.handler(f.event(b));assert.equal(f.sent.size,2);
  await f.handler(f.event(b));assert.equal(f.sent.size,2);assert.equal(f.plans.get('b').coincidences,1);
});
test('out-of-order events and equal timestamp ties do not mark the first booking as a collision',async()=>{
  const a=trip('a',1),b=trip('b',1),f=fixture([b,a]);
  assert.equal(precedes(a,b),true);assert.equal(precedes(b,a),false);
  assert.equal(precedes({id:'x'},a),false);
  await f.handler(f.event(b));await f.handler(f.event(a));assert.equal(f.sent.size,3);
  assert.equal(f.plans.get('a').coincidences,0);assert.equal(f.plans.get('b').coincidences,1);
});
test('missing/foreign event versions are ignored and Telegram names cannot inject extra lines',async()=>{
  const f=fixture([]);assert.deepEqual(await f.handler({}),{skipped:true});
  assert.deepEqual(await f.handler(f.event(trip('a',1,{version:'other'}))),{skipped:true});
  const text=compact.calendarSummary({driverName:'Ana\nFake notice',serviceDate:'2026-09-14'});
  assert.equal(text.split('\n').length,3);assert.match(text,/Ana Fake notice/);
});
