import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {classifyRecordedCharge, REMIS_NUMBERS, buildOpsBoard} from '../ops-salidas.js';

test('recorded number and private choice use explicit fields only, without mutating records', () => {
  for (const number of REMIS_NUMBERS) {
    for (const remisNumber of [number, String(number)]) {
      const row=Object.freeze({remisNumber,viajePrivado:false,isPrivateTrip:false});
      assert.deepEqual(classifyRecordedCharge(row), {kind:'remis',label:`Nº remis ${number}`});
    }
  }
  for (const flags of [{viajePrivado:true,isPrivateTrip:true},{viajePrivado:true},{isPrivateTrip:true}]) {
    assert.deepEqual(classifyRecordedCharge({...flags,remisNumber:null}), {kind:'private',label:'Viaje privado'});
  }
  assert.equal(classifyRecordedCharge({remisNumber:134}).label,'Nº remis 134');
  for (const row of [{},{remisNumber:null,viajePrivado:false,isPrivateTrip:false},
    {driverName:'Remis 134',detail:'Viaje privado',amount:134,createdAtMs:134,invoiceRequest:{remisNumber:134}}]) {
    assert.deepEqual(classifyRecordedCharge(row), {kind:'unclassified',label:'Sin clasificar'});
  }
});

test('contradictory flags and invalid fields are review states, never silently coerced', () => {
  for (const row of [
    {viajePrivado:true,isPrivateTrip:false},{viajePrivado:false,isPrivateTrip:true},
    {remisNumber:134,viajePrivado:true,isPrivateTrip:true},
    {remisNumber:134,viajePrivado:'false'},{isPrivateTrip:1},
    ...[0,-1,999,134.5,'1.34e2','0x86','invalid',' ',[],{},true].map(remisNumber=>({remisNumber})),
    {remisNumber:'invalid',viajePrivado:true}
  ]) assert.deepEqual(classifyRecordedCharge(row), {kind:'review',label:'Por revisar'},JSON.stringify(row));
});

test('Movimientos view model carries classification only for travel charges and preserves financial values', () => {
  const source=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
  const start=source.indexOf('function adminWorkspaceState()');
  const payments=[
    {id:'number',method:'cash',amount:100,remisNumber:134,viajePrivado:false,isPrivateTrip:false},
    {id:'private',method:'digital',amount:200,remisNumber:null,viajePrivado:true,isPrivateTrip:true},
    {id:'legacy',method:'cash',amount:300},
    {id:'conflict',method:'digital',amount:400,viajePrivado:true,isPrivateTrip:false},
    {id:'adjustment',method:'cash',amount:500,adjustmentDirection:'driver_to_explora',remisNumber:134}
  ];
  const before=structuredClone(payments);
  const context={classifyRecordedCharge,auth:{currentUser:{}},isAdminProfile:()=>true,dashboardLoad:{complete:()=>true},
    adminDrivers:[],adminPayments:payments,adminExpenses:[{id:'expense',amount:50}],adminDebts:[],adminDebtPayments:[],adminUberClosures:[{id:'uber',amount:600}],adminAllClosures:[],
    adminDriverIsAdministrator:()=>false,adminDriverIsActive:()=>true,movementIsDeleted:()=>false,
    recordTimestampMs:()=>123,recordProofUrl:()=>'',isSettlementAdjustment:r=>Boolean(r.adjustmentDirection),isReimbursementCompensation:()=>false};
  vm.createContext(context);vm.runInContext(source.slice(start,source.indexOf('\n}',start)+2),context);
  const rows=context.adminWorkspaceState().movements;
  assert.deepEqual(Array.from(rows.slice(0,4),r=>r.chargeClassification.label),['Nº remis 134','Viaje privado','Sin clasificar','Por revisar']);
  assert.deepEqual(Array.from(rows,r=>r.amount),[100,200,300,400,500,50,600]);
  for (const row of rows.slice(4)) assert.equal(row.chargeClassification,undefined);
  assert.deepEqual(payments,before);
});

test('Ops presents the linked charge independently of administrative disposition and never infers missing charge data', () => {
  const exits=[
    {id:'external',remisNumber:57,markedAtMs:100,disposition:'external_cover',paymentId:'private'},
    {id:'linked',remisNumber:134,markedAtMs:100,paymentId:'number'},
    {id:'missing',remisNumber:134,markedAtMs:100,paymentId:'unavailable'},
    {id:'conflict',remisNumber:134,markedAtMs:100,paymentId:'contradictory'},
    {id:'legacy',remisNumber:134,markedAtMs:100,paymentId:'old'}
  ];
  const payments=[{id:'private',createdAtMs:200,viajePrivado:true,isPrivateTrip:true},
    {id:'number',remisNumber:134,createdAtMs:200,viajePrivado:false,isPrivateTrip:false},
    {id:'contradictory',remisNumber:134,createdAtMs:200,viajePrivado:true,isPrivateTrip:false},
    {id:'old',createdAtMs:200}];
  const board=buildOpsBoard({exits,payments,dayKey:'2026-09-30'});
  assert.deepEqual(board.rows.map(r=>r.chargeClassification.label),['Por revisar','Viaje privado','Sin clasificar','Nº remis 134','Sin clasificar']);
  assert.equal(board.rows.find(r=>r.id==='external').status,'excluded');
  assert.equal(board.rows.find(r=>r.id==='linked').status,'matched');
  assert.deepEqual(board.automaticLinks,[]);
});
