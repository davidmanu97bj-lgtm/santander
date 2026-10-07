// Optional integration test: start the Firestore emulator with firestore.rules.
// EXPLORA_FIREBASE_CLIENT_ROOT points to a package.json with the Firebase client SDK.
// This script deliberately refuses a non-local emulator or a non-demo project.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import path from 'node:path';
const endpoint=process.env.FIRESTORE_EMULATOR_HOST||'127.0.0.1:49199';
const projectId=process.env.GCLOUD_PROJECT||'demo-explora-admin-20261007';
assert.match(endpoint,/^127\.0\.0\.1:\d+$/);assert.match(projectId,/^demo-/);
assert.ok(process.env.EXPLORA_FIREBASE_CLIENT_ROOT,'Set EXPLORA_FIREBASE_CLIENT_ROOT to a folder containing package.json and firebase.');
const require=createRequire(path.join(process.env.EXPLORA_FIREBASE_CLIENT_ROOT,'package.json'));
const {initializeApp,deleteApp}=require('firebase/app');
const {getFirestore,connectFirestoreEmulator,doc,setDoc,updateDoc,getDoc,serverTimestamp,Timestamp,deleteField}=require('firebase/firestore');
const [host,port]=endpoint.split(':');
function client(uid,admin=false){
  const app=initializeApp({projectId,apiKey:'local-only'},uid);
  const db=getFirestore(app);connectFirestoreEmulator(db,host,Number(port),{mockUserToken:{sub:uid,user_id:uid,admin}});
  return {app,db};
}
const admin=client('receipt-admin',true),driver=client('receipt-driver'),rows=[];
const owner={driverUid:'receipt-driver',choferUid:'receipt-driver',uid:'receipt-driver',ownerUid:'receipt-driver',driverId:'receipt-driver',operatorUid:'receipt-driver'};
const waiver=()=>({...owner,amount:100,receiptStatus:'waived_by_admin',receiptRequired:false,receiptWaived:true,
  receiptWaivedByUid:'receipt-admin',receiptWaivedByRole:'admin',receiptWaivedAt:serverTimestamp(),receiptWaivedAtMs:Date.now(),
  proofUrl:'',proofPath:'',receiptUrl:'',receiptPath:''});
const suffix=Date.now();
async function check(name,fn){await fn();rows.push(name);console.log('PASS '+name);}
async function denied(fn){await assert.rejects(fn,error=>error.code==='permission-denied');}
try{
  await setDoc(doc(admin.db,'choferes','receipt-driver'),{active:true});
  for(const name of ['billing_records','cobros','gastos','cierres_semanales','deuda_pagos','pagos_semanales','pagos']){
    const id=`admin-waiver-${suffix}`;
    await check(`${name}: admin waiver persists with server timestamp`,async()=>{
      await setDoc(doc(admin.db,name,id),waiver());
      const record=(await getDoc(doc(admin.db,name,id))).data();assert.equal(record.receiptStatus,'waived_by_admin');assert.ok(record.receiptWaivedAt.toMillis()>0);
      await updateDoc(doc(admin.db,name,id),{updatedAt:serverTimestamp()});
    });
    await check(`${name}: driver cannot forge waiver`,()=>denied(()=>setDoc(doc(driver.db,name,`driver-waiver-${suffix}`),{...waiver(),receiptWaivedByUid:'receipt-driver'})));
    await check(`${name}: admin cannot impersonate waiver actor`,()=>denied(()=>setDoc(doc(admin.db,name,`wrong-actor-${suffix}`),{...waiver(),receiptWaivedByUid:'receipt-driver'})));
  }
  await check('client timestamp is rejected',()=>denied(()=>setDoc(doc(admin.db,'gastos',`client-time-${suffix}`),{...waiver(),receiptWaivedAt:Timestamp.fromMillis(1)})));
  await check('fake attached link alongside waiver is rejected',()=>denied(()=>setDoc(doc(admin.db,'gastos',`link-${suffix}`),{...waiver(),proofUrl:'https://example.test/fake.pdf'})));
  await check('receipt waiver cannot be removed by driver',()=>denied(()=>updateDoc(doc(driver.db,'cobros',`admin-waiver-${suffix}`),{
    receiptStatus:'uploaded',receiptWaived:deleteField(),receiptWaivedByUid:deleteField(),receiptWaivedByRole:deleteField(),receiptWaivedAt:deleteField(),receiptWaivedAtMs:deleteField()
  })));
  await check('administrator can replace waiver with a real attachment',async()=>{
    await updateDoc(doc(admin.db,'gastos',`admin-waiver-${suffix}`),{receiptStatus:'uploaded',receiptRequired:true,
      receiptWaived:deleteField(),receiptWaivedByUid:deleteField(),receiptWaivedByRole:deleteField(),receiptWaivedAt:deleteField(),receiptWaivedAtMs:deleteField(),
      proofUrl:'https://example.test/real.pdf',receiptUrl:'https://example.test/real.pdf',proofPath:'gastos/receipt-driver/op/real.pdf',receiptPath:'gastos/receipt-driver/op/real.pdf'});
  });
  const charge={...owner,settlementRuleVersion:'net_wallets_cashbox_10_v1',type:'billing',method:'digital',paymentMethod:'digital',status:'completed',amount:100,monto:100,grossAmount:100,
    createdAt:serverTimestamp(),invoiceRequest:{version:'arca_c_v1'},source:'app',proofPath:'billing_receipts/receipt-driver/day/proof.jpg',proofUrl:'https://example.test/proof.jpg'};
  await check('ordinary driver digital charge still requires and accepts proof',async()=>{
    await setDoc(doc(driver.db,'billing_records',`driver-charge-${suffix}`),charge);
    await denied(()=>setDoc(doc(driver.db,'billing_records',`driver-noproof-${suffix}`),{...charge,proofPath:'',proofUrl:''}));
  });
  console.log(JSON.stringify({projectId,endpoint,passed:rows.length,tests:rows},null,2));
}finally{await Promise.all([deleteApp(admin.app),deleteApp(driver.app)]);}
