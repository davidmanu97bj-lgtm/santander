// Optional integration with the REAL Admin SDK + Firestore/Auth emulators.
// Never runs against production. No credentials or service-account key required.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const host=process.env.FIRESTORE_EMULATOR_HOST;
const authHost=process.env.FIREBASE_AUTH_EMULATOR_HOST;
const project=process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || '';
test('SDK real y Rules en emuladores: concurrencia, idempotencia y denegación de escritura directa',
 {skip:!host?'Requiere npm run test:ledger:emulator (Firestore + Auth locales).':false},async t=>{
  assert.match(host,/^(127\.0\.0\.1|localhost):\d+$/,'Emulador local obligatorio');
  assert.match(authHost || '',/^(127\.0\.0\.1|localhost):\d+$/,'Auth local obligatorio');
  assert.match(project,/^demo-/,'Solo proyecto demo, nunca producción');
  const require=createRequire(new URL('../functions/package.json',import.meta.url));
  const {initializeApp,deleteApp}=require('firebase-admin/app');
  const {getFirestore,Timestamp,FieldValue,Filter}=require('firebase-admin/firestore');
  const {HttpsError}=require('firebase-functions/v2/https');
  const {createSettlementLedger}=require('./settlement-ledger');
  const {createSettlementApi}=require('./settlement-api');
  const app=initializeApp({projectId:project},'ledger-integration-'+Date.now());
  const db=getFirestore(app);t.after(async()=>{await db.terminate();await deleteApp(app);});
  const signup=await fetch(`http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo`,{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({returnSecureToken:true})});
  assert.equal(signup.status,200);const {localId:uid,idToken}=await signup.json();
  await db.doc(`choferes/${uid}`).set({uid,authUid:uid,role:'driver',active:true,displayName:'Emulator'});
  const now=Date.now(),anchorId=`${uid}_anchor`;
  await db.doc(`billing_records/${anchorId}`).set({driverUid:uid,type:'reimbursement_compensation',settlementAfter:1406876,createdAt:Timestamp.fromMillis(now-5000),createdAtMs:now-5000});
  const ledger=createSettlementLedger({db,Timestamp,FieldValue,Filter,HttpsError});
  const review=await ledger.review(uid);assert.equal(review.balance,1406876);
  await ledger.activate(uid,review.sourceHash,'emulator-admin');
  const api=createSettlementApi({db,ledger,Timestamp,FieldValue,HttpsError,onCall:(_opts,fn)=>fn,
    assertAdmin:async()=>{throw new HttpsError('permission-denied','not admin');},assertViewer:async()=>uid});
  const payment=(id,method,amount)=>({auth:{uid},data:{requestId:`${uid}_${id}`,writes:[{path:`billing_records/${uid}_${id}`,kind:'create',
    data:{driverUid:uid,method,type:method==='cash'?'billing':'payment',amount}}]}});
  const digital=payment('digital','digital',85000),cash=payment('cash','cash',32500);
  await Promise.all([api.commit(digital),api.commit(cash)]);
  await api.commit(digital);
  const account=(await db.doc(`driver_settlement_accounts/${uid}`).get()).data();
  assert.equal(account.balance,1360251);assert.equal(account.sequence,2);
  const entries=(await db.collection('driver_settlement_entries').where('driverUid','==',uid).get()).docs
    .map(d=>d.data()).sort((a,b)=>a.sequence-b.sequence);
  assert.equal(entries.length,2);assert.equal(entries[0].before,1406876);
  assert.equal(entries[1].before,entries[0].after);assert.equal(entries[1].after,1360251);
  for(const collection of ['billing_records','gastos','uber_weekly_closures','cierres_semanales','deudas_choferes',
    'deuda_pagos','prestamos_operativos','deuda_movimientos','driver_settlement_accounts','driver_settlement_entries']){
    const denied=await fetch(`http://${host}/v1/projects/${project}/databases/(default)/documents/${collection}/raw_${uid}`,{
      method:'PATCH',headers:{Authorization:`Bearer ${idToken}`,'Content-Type':'application/json'},
      body:JSON.stringify({fields:{driverUid:{stringValue:uid},amount:{integerValue:'999'}}})});
    assert.equal(denied.status,403,`Rules must deny raw write to ${collection}`);
  }
  const read=await fetch(`http://${host}/v1/projects/${project}/databases/(default)/documents/driver_settlement_accounts/${uid}`,{
    headers:{Authorization:`Bearer ${idToken}`}});
  assert.equal(read.status,200);
});
