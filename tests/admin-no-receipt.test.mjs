import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {buildAdminDigitalExpense} from '../admin-digital-expense.js';
import {MemoryStore} from '../tools/preview/memory-store.mjs';
const require=createRequire(import.meta.url);
const expensePolicy=require('../functions/expense-policy');
const periodPolicy=require('../functions/period-policy');
const {calculateTeamRealtimeSettlementBalance}=require('../functions/telegram-billing-balance');
const monthly=require('../functions/admin-monthly-documents');
const rules=fs.readFileSync(new URL('../firestore.rules',import.meta.url),'utf8');

const request={driver:{id:'javier',name:'Javier'},actor:{uid:'admin',name:'Administrador',role:'admin'},amount:12500,
  detail:'Gasto pagado por Explora',typeId:'combustible',operation:{operationId:'op1',createdAtMs:10000},
  fingerprint:'operation-fingerprint',businessId:'explora',dayKey:'2026-10-07'};
test('Sin comprobante es explícito, auditable y conserva el cálculo de cada clase de gasto',()=>{
  for(const typeId of ['combustible','canon','cubiertas']){
    const bare=buildAdminDigitalExpense({...request,typeId,withoutReceipt:true},expensePolicy,periodPolicy);
    const attached=buildAdminDigitalExpense({...request,typeId,proofUrl:'https://example.test/proof.pdf',proofPath:'gastos/javier/op1/proof.pdf',file:{name:'proof.pdf',type:'application/pdf'}},expensePolicy,periodPolicy);
    assert.equal(bare.receiptStatus,'waived_by_admin');assert.equal(bare.receiptRequired,false);
    assert.equal(bare.receiptWaivedByUid,'admin');assert.equal(bare.receiptWaivedByRole,'admin');assert.equal(bare.receiptWaivedAtMs,10000);
    for(const key of ['proofUrl','proofPath','receiptUrl','receiptPath'])assert.equal(bare[key],'');
    assert.equal(bare.billingImpactAmount,attached.billingImpactAmount);
    assert.equal(calculateTeamRealtimeSettlementBalance({expenses:[bare]}).balance,calculateTeamRealtimeSettlementBalance({expenses:[attached]}).balance);
    assert.equal(bare.idempotencyKey,attached.idempotencyKey);
    assert.equal(bare.submissionFingerprint,attached.submissionFingerprint);
  }
});
test('no permite ausencia implícita, usuario chofer, fecha faltante ni un archivo junto a Sin comprobante',()=>{
  const build=extra=>buildAdminDigitalExpense({...request,...extra},expensePolicy,periodPolicy);
  assert.throws(()=>build({}),/Adjuntá/);
  assert.throws(()=>build({withoutReceipt:true,actor:{uid:'javier',role:'driver'}}),/administrador/);
  assert.throws(()=>build({withoutReceipt:true,file:{name:'old.pdf'}}),/sin un archivo/);
  assert.throws(()=>build({withoutReceipt:true,proofUrl:'https://example.test/old.pdf'}),/sin un archivo/);
  assert.throws(()=>build({withoutReceipt:true,operation:{operationId:'op1'}}),/fecha/);
});

// Execute the receipt guard predicates extracted from the actual Rules source.
// This tests their decisions, not the Firebase Rules compiler or emulator.
function predicate(name){
  const start=rules.indexOf(`    function ${name}(`);assert.ok(start>=0,name);
  return rules.slice(start,rules.indexOf('\n    }',start)+6).replace(/(data\.get\('receiptWaivedAtMs', 0\)) is number/g,'typeof $1 === "number"');
}
function list(values){return {hasAny:keys=>keys.some(key=>values.includes(key))};}
function dataMap(data){return {...data,get:(key,fallback)=>Object.hasOwn(data,key)?data[key]:fallback,keys:()=>list(Object.keys(data)),
  diff:previous=>({affectedKeys:()=>list([...new Set([...Object.keys(data),...Object.keys(previous)])].filter(key=>!['get','keys','diff'].includes(key)&&data[key]!==previous[key]))})};}
function allowed({admin=false,data,before={}},update=false){
  const context={request:{resource:{data:dataMap(data)},time:12345},resource:{data:dataMap(before)},isAdmin:()=>admin,uid:()=>admin?'admin':'javier'};
  const names=['hasAdminReceiptWaiver','validAdminReceiptWaiver','financialReceiptCreateAllowed','financialReceiptUpdateAllowed'];
  return vm.runInNewContext(names.map(predicate).join('\n')+`;${update?'financialReceiptUpdateAllowed':'financialReceiptCreateAllowed'}()`,context);
}
const waived={receiptWaived:true,receiptStatus:'waived_by_admin',receiptRequired:false,receiptWaivedByUid:'admin',receiptWaivedByRole:'admin',receiptWaivedAt:12345,receiptWaivedAtMs:12345,proofUrl:'',proofPath:'',receiptUrl:'',receiptPath:''};
test('reglas: sólo el administrador autenticado acepta Sin comprobante con auditoría y hora del servidor',()=>{
  assert.equal(allowed({admin:true,data:waived}),true);
  assert.equal(allowed({admin:false,data:waived}),false);
  for(const changes of [{receiptWaivedByUid:'other'},{receiptWaivedAt:12344},{receiptWaivedAtMs:0},{receiptStatus:'uploaded'},{receiptWaived:false},{receiptRequired:true},{proofUrl:'https://example.test/proof.pdf'},{receiptUrl:'https://example.test/proof.pdf'}]){
    assert.equal(allowed({admin:true,data:{...waived,...changes}}),false,JSON.stringify(changes));
  }
  assert.equal(allowed({admin:true,data:{receiptWaived:true}}),false);
  assert.equal(allowed({admin:false,data:{amount:100,receiptStatus:'uploaded'}}),true);
});
test('reglas: actualizaciones ajenas al comprobante lo conservan; el chofer no puede falsificar ni retirar la auditoría',()=>{
  const before={...waived,amount:100};
  assert.equal(allowed({admin:true,before,data:{...before,updatedAt:1}},true),true);
  assert.equal(allowed({admin:false,before,data:{...before,receiptWaivedByUid:'javier'}},true),false);
  assert.equal(allowed({admin:false,before,data:{amount:100}},true),false);
  assert.equal(allowed({admin:false,before:{amount:100},data:{amount:100,...waived}},true),false);
});
test('las colecciones financieras aplican los guardas en creación y actualización',()=>{
  for(const name of ['billing_records','facturaciones','cobros','servicios','receipt_index','payment_operations','gastos','prestamos_operativos','deudas_choferes','deuda_pagos','deuda_movimientos','acumulados_semanales','cierres_semanales','pagos_semanales','pagos']){
    const start=rules.indexOf(`    match /${name}/`),next=rules.indexOf('\n    match /',start+1);
    const body=rules.slice(start,next<0?undefined:next);
    assert.match(body,/allow create: if financialReceiptCreateAllowed\(\)/,name);
    assert.match(body,/allow update: if financialReceiptUpdateAllowed\(\)/,name);
  }
});
test('Contadora por tarjeta devuelve únicamente el chofer elegido y conserva el modo general',async()=>{
  const db=new MemoryStore({'choferes/javier':{nombre:'Javier',active:true},'choferes/ramiro':{nombre:'Ramiro',active:true}});
  const run=monthly({db,assertAdmin:async()=> 'admin'}).adminMonthlyDocuments.run;
  const selected=await run({data:{month:'2026-09',driverUid:'javier',overviewOnly:true}});
  assert.deepEqual(selected.rows.map(row=>row.uid),['javier']);assert.equal(selected.pdf,undefined);
  assert.equal((await run({data:{month:'2026-09'}})).rows.length,2);
  assert.deepEqual((await run({data:{month:'2026-09',driverUid:'missing',overviewOnly:true}})).rows,[]);
  await assert.rejects(run({data:{month:'2026-09',driverUid:'../ramiro',overviewOnly:true}}),/Chofer inválido/);
  const denied=monthly({db:{collection(){throw new Error('Debe bloquear antes de leer');}},assertAdmin:async()=>{throw Error('Solo administradores');}}).adminMonthlyDocuments.run;
  await assert.rejects(denied({data:{month:'2026-09',driverUid:'javier',overviewOnly:true}}),/Solo administradores/);
});
