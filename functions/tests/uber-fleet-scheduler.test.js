'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const createScheduler=require('../uber-fleet-scheduler');

test('installed scheduler runs without browser and disabled deployment reads no data or secrets',async()=>{
  const prior=process.env.UBER_FLEET_SYNC_ENABLED;
  delete process.env.UBER_FLEET_SYNC_ENABLED;
  try{
    const {uberFleetObserveAutomatically:fn}=createScheduler({db:{runTransaction(){throw Error('Unexpected transaction');},collection(){return {doc(){return {get(){throw Error('Unexpected database read');}};}};}}});
    assert.equal(fn.__endpoint.scheduleTrigger.schedule,'every 5 minutes');
    assert.deepEqual(fn.__endpoint.secretEnvironmentVariables||[],[]);
    await fn.run({});
  }finally{if(prior===undefined)delete process.env.UBER_FLEET_SYNC_ENABLED;else process.env.UBER_FLEET_SYNC_ENABLED=prior;}
});

test('runtime stop switch prevents credentials and transport even when deployment is enabled',async()=>{
  const prior=process.env.UBER_FLEET_SYNC_ENABLED;process.env.UBER_FLEET_SYNC_ENABLED='true';
  let reads=0;
  try{
    const db={runTransaction(){throw Error('Unexpected transaction');},collection(name){return {doc(id){return {async get(){assert.equal(name,'uber_fleet_shadow_settings');assert.equal(id,'automatic');reads++;return {data:()=>({enabled:false})};}};}};}};
    await createScheduler({db}).uberFleetObserveAutomatically.run({});
    assert.equal(reads,1);
  }finally{if(prior===undefined)delete process.env.UBER_FLEET_SYNC_ENABLED;else process.env.UBER_FLEET_SYNC_ENABLED=prior;}
});
