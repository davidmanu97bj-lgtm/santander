import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {MemoryStore} from '../tools/preview/memory-store.mjs';
const require=createRequire(import.meta.url);
const {registerAdminUberWeek,confirmAdminUberWeek,createAdminUberWeekFunction,validateInput}=require('../functions/admin-uber-weekly.js');
const policy=require('../functions/uber-weekly-policy.js');
const {calculateTeamRealtimeSettlementBalance:balance,calculateOpenBillingBalance}=require('../functions/telegram-billing-balance.js');
const {quoteFromInput,confirmPeriodClosure,periodQuote}=require('../functions/period-closure.js');
const {createUberSubmissionFunction}=require('../functions/uber-submission.js');
const {buildMonthlyReport}=require('../functions/monthly-report.js');
const uid='driver-test',now=Date.parse('2026-10-02T15:00:00Z');
const input=(cashAmount=6000,transferAmount=4000)=>({driverUid:uid,weekStartDate:'2026-09-21',weekCloseDate:'2026-09-28',cashAmount,transferAmount,totalAmount:cashAmount+transferAmount,sourceReference:'Fleet semana 21 septiembre',amountBasis:'net_after_uber_commission',cashRecipient:'driver',digitalRecipient:'explora',reconciled:true});
const register=(db,data=input(),extra={})=>registerAdminUberWeek({db,adminUid:'admin-test',input:data,now,businessId:'test-business',...extra});
const registerAccepted=async(db,data=input())=>{const pending=await register(db,data);return confirmAdminUberWeek({db,driverUid:uid,input:{closureId:pending.id},now:now+1});};
const rows=db=>({records:[],expenses:[],debts:[],closures:[],uberWeeks:[...db.data].filter(([path])=>path.startsWith('uber_weekly_closures/')).map(([path,row])=>({...row,id:path.split('/')[1]}))});

test('Fleet admin: cash, digital, mixto y cero aplican una sola caja10% y desglosan la misma contribución',async()=>{
  for(const [cash,digital,expected] of [[10000,0,6000],[0,10000,-4000],[6000,4000,2000],[0,0,0],[100.05,0,60.04],[100,.17,59.94],[100,1.95,59.23]]) {
    const db=new MemoryStore(),result=await registerAccepted(db,input(cash,digital)),data=rows(db),quote=quoteFromInput(uid,data);
    assert.equal(result.record.settlementRuleVersion,policy.VERSION);
    assert.equal(balance(data).balance,expected);
    assert.equal(calculateOpenBillingBalance(data).netToDriver,-expected||0);
    assert.equal(result.record.settlementImpact,expected);
    assert.equal(quote.balance,expected);
    assert.equal(quote.summary.cash,cash);assert.equal(quote.summary.digital,digital);
    assert.equal(quote.summary.cashbox,policy.calculate(input(cash,digital)).cashbox);
    assert.equal(quote.presentation.uber.balance,expected);
    assert.equal(quote.presentation.uber.unavailableCount,0);
    assert.equal(quote.presentation.uber.recordCount,1);
  }
});

test('Fleet admin: concurrencia y retry son idempotentes; distintos importes no sobrescriben',async()=>{
  const db=new MemoryStore();
  const results=await Promise.all(Array.from({length:8},()=>register(db)));
  assert.equal(results.filter(row=>!row.alreadyRegistered).length,1);assert.equal(db.data.size,1);
  const before=JSON.stringify([...db.data]);
  await assert.rejects(register(db,input(2000,8000)),/ya tiene un cierre/);
  const retry=await register(db,input(),{now:now+14*86400000});assert.equal(retry.alreadyRegistered,true);
  assert.equal(JSON.stringify([...db.data]),before);
});

test('cualquier cierre histórico de la misma semana bloquea el alta, incluyendo aliases y pendientes',async()=>{
  for(const owner of ['driverUid','choferUid','uid','ownerUid','driverId','choferId','userUid']) {
    for(const status of ['completed','approved','pending_admin_review','awaiting_driver_confirmation']) {
      const legacy={[owner]:uid,weekStartDate:input().weekStartDate,status,amount:123,createdAtMs:now-1000};
      const db=new MemoryStore({'uber_weekly_closures/legacy':legacy}),before=JSON.stringify([...db.data]);
      await assert.rejects(register(db),/ya fue cargada/);assert.equal(JSON.stringify([...db.data]),before);
    }
  }
});

test('no transforma importes negativos, no finitos o con más de dos decimales y valida custodia/conciliación',async()=>{
  for(const change of [{transferAmount:-1},{cashAmount:Infinity},{cashAmount:NaN},{cashAmount:'6000'},{cashAmount:0.001},{totalAmount:9999},{totalAmount:100000001},{reconciled:false},{amountBasis:'gross'},{digitalRecipient:'driver'},{cashRecipient:'explora'},{sourceReference:' '},{driverUid:'../other'},{weekStartDate:'2026-02-30'}]) {
    const db=new MemoryStore();await assert.rejects(register(db,{...input(),...change}));assert.equal(db.data.size,0);
  }
  assert.throws(()=>validateInput({...input(),transferAmount:-1}),/saldo digital negativo/);
  for(const [start,close] of [['2026-09-28','2026-10-05'],['2026-09-14','2026-09-21'],['2026-09-22','2026-09-29']]) {
    const db=new MemoryStore();await assert.rejects(register(db,{...input(),weekStartDate:start,weekCloseDate:close}));assert.equal(db.data.size,0);
  }
});

test('callable autoriza antes de leer datos y rechaza chofer, anónimo, perfil admin e inactivo',async()=>{
  for(const role of ['anonymous','driver']) {
    const db=new MemoryStore();let profileReads=0;
    const fn=createAdminUberWeekFunction({db,assertAdmin:async()=>{throw Error('permission denied '+role);},getProfile:async()=>{profileReads++;}});
    await assert.rejects(fn.run({data:input()}),/permission denied/);assert.equal(profileReads,0);assert.equal(db.data.size,0);
  }
  for(const profileData of [{role:'admin'},{rol:'administrador'},{disabled:true},{active:false},{deleted:true}]) {
    const db=new MemoryStore();const fn=createAdminUberWeekFunction({db,assertAdmin:async()=> 'admin-test',getProfile:async()=>({exists:true,id:uid,data:()=>profileData})});
    await assert.rejects(fn.run({data:input()}),/chofer habilitado/);assert.equal(db.data.size,0);
  }
  const fn=createAdminUberWeekFunction({db:new MemoryStore(),assertAdmin:async()=> 'admin-test',getProfile:async()=>({exists:true,id:uid,data:()=>({role:'driver'})}),isEligibleProfile:()=>false});
  await assert.rejects(fn.run({data:input()}),/chofer habilitado/);
});

test('perfil y auth UID convergen a un ID; todos los alias históricos bloquean un duplicado semanal',async()=>{
  const profile={exists:true,id:'profile-legacy',data:()=>({authUid:uid,uid,driverId:'driver-legacy',role:'driver'})};
  const factory=db=>createAdminUberWeekFunction({db,assertAdmin:async()=> 'admin-test',getProfile:async()=>profile,businessId:'test',now:()=>now});
  const db=new MemoryStore(),fn=factory(db);
  const first=await fn.run({data:{...input(),driverUid:profile.id}});
  const second=await fn.run({data:input()});
  assert.equal(first.id,second.id);assert.equal(second.alreadyRegistered,true);assert.equal(first.record.driverUid,uid);assert.equal(db.data.size,1);
  for(const alias of ['profile-legacy','driver-legacy'])for(const field of ['driverUid','uid','operatorUid']) {
    const legacy={[field]:alias,weekStartDate:input().weekStartDate,status:'completed',amount:500,createdAtMs:now-1};
    const store=new MemoryStore({'uber_weekly_closures/old':legacy});
    await assert.rejects(factory(store).run({data:input()}),/ya fue cargada/);assert.equal(store.data.size,1);
  }
});

test('centavos exactos: variantes de diez centavos, múltiples nuevas semanas e historial anclado',()=>{
  const records=[];
  for(let cents=0;cents<200;cents++) {
    const row={id:'cent-'+cents,...input(100+cents/100,(17+cents*10)/100),createdAtMs:now,settlementRuleVersion:policy.VERSION,settlementWorkflowVersion:policy.WORKFLOW,adminConfirmed:true,status:'completed'};
    const expected=policy.calculate(row).balance;
    assert.equal(balance({uberWeeks:[row]}).balance,expected,JSON.stringify(row));
    assert.equal(quoteFromInput(uid,{records:[],expenses:[],debts:[],closures:[],uberWeeks:[row]}).balance,expected);
    records.push(row);
  }
  const expected=records.reduce((sum,row)=>sum+Math.round(policy.calculate(row).balance*100),0)/100;
  assert.equal(balance({uberWeeks:records}).balance,expected);
  const anchor={id:'anchor',type:'reimbursement_compensation',settlementAfter:125.12,createdAtMs:now-1};
  const old={id:'old',amount:99999,cashAmount:99999,createdAtMs:now-2};
  assert.equal(balance({records:[anchor],uberWeeks:[old,...records]}).balance,policy.roundMoney(expected+125.12));
});

test('nuevo workflow requiere confirmación admin y queda fuera si eliminado o simulado',()=>{
  const record={...input(),amount:10000,grossAmount:10000,createdAtMs:now,settlementRuleVersion:policy.VERSION,settlementWorkflowVersion:policy.WORKFLOW,adminConfirmed:true,status:'completed'};
  for(const extra of [{adminConfirmed:false},{status:'pending'},{deleted:true},{isSimulated:true},{settlementWorkflowVersion:'legacy'}])assert.equal(balance({uberWeeks:[{...record,...extra}]}).balance,0);
});

test('historial se conserva sin desglose inventado, y combinar billeteras no duplica caja Uber',async()=>{
  const db=new MemoryStore(),legacy={id:'legacy',driverUid:uid,grossAmount:5000,amount:5000,cashAmount:5000,transferAmount:0,createdAtMs:now-1000,settlementRuleVersion:'net_wallets_cashbox_10_v1',settlementWorkflowVersion:'v85_verified_direct',verifiedAutomatically:true,reviewStatus:'completed'};
  await registerAccepted(db);const data=rows(db);data.uberWeeks.push(legacy);data.records.push({id:'payment',method:'digital',amount:5000,createdAtMs:now,settlementRuleVersion:'net_wallets_cashbox_10_v1'});
  const before=JSON.stringify(data),quote=quoteFromInput(uid,data);
  assert.equal(quote.balance,3000);assert.equal(quote.presentation.uber.balance,5000);
  assert.equal(quote.presentation.uber.total,15000);assert.equal(quote.presentation.uber.unavailableTotal,5000);
  assert.equal(quote.presentation.uber.cash,6000);assert.equal(quote.presentation.uber.digital,4000);
  assert.equal(quote.summary.cashbox,2000);assert.equal(JSON.stringify(data),before);
});

test('cierre de período compensa alta Fleet y posterior consulta no vuelve a cobrar ni mostrar la semana',async()=>{
  const db=new MemoryStore();await registerAccepted(db);
  const quote=await periodQuote({db,uid});
  await confirmPeriodClosure({db,uid,input:{quoteId:quote.quoteId,proofPath:`cierres_semanales/period/${uid}/${quote.quoteId}/proof.png`},proofMetadata:async()=>({size:100,contentType:'image/png',url:'https://example.test/proof'}),now:now+1000});
  const after=await periodQuote({db,uid});assert.equal(after.balance,0);assert.equal(after.presentation.uber.recordCount,0);
});

test('un corte posterior a la fecha de registro rechaza el alta sin cambiar saldos ni el ancla',async()=>{
  const anchor={driverUid:uid,type:'reimbursement_compensation',settlementAfter:321.45,createdAtMs:now+1000};
  const db=new MemoryStore({'billing_records/anchor':anchor}),before=JSON.stringify([...db.data]);
  await assert.rejects(register(db),/período fue cerrado o ajustado/);
  assert.equal(JSON.stringify([...db.data]),before);
  assert.equal((await periodQuote({db,uid})).balance,321.45);
});

test('legacy driver callable rechaza nuevas altas aunque cliente intente desactivar adminFleetRequired',async()=>{
  const proofId='proof-test',proof={uid,valid:true,weekStartDate:input().weekStartDate,weekCloseDate:input().weekCloseDate};
  const db=new MemoryStore({['uber_proof_checks/'+proofId]:proof});
  const fn=createUberSubmissionFunction({db,businessId:'test',assertViewer:async()=>uid,getProfile:async()=>({data:()=>({})}),getBalance:async()=>({balance:0})});
  const data={settlementRuleVersion:'net_wallets_cashbox_10_v1',verifiedProofId:proofId,adminFleetRequired:false};
  await assert.rejects(fn.run({data}),/administrador debe cargar/);assert.equal(db.data.size,1);
  const id=`uber_${uid}_${proof.weekStartDate}_direct`;
  db.data.set('uber_weekly_closures/'+id,{verifiedProofId:proofId,status:'completed',amount:123});
  const before=JSON.stringify([...db.data]);assert.equal((await fn.run({data})).alreadyRegistered,true);assert.equal(JSON.stringify([...db.data]),before);
});

test('altas directas Firestore están cerradas; la integración conserva la autorización oficial',()=>{
  const rules=fs.readFileSync(new URL('../firestore.rules',import.meta.url),'utf8');
  const block=rules.slice(rules.indexOf('match /uber_weekly_closures/'));
  assert.match(block,/allow create: if false;/);
  const index=fs.readFileSync(new URL('../functions/index.js',import.meta.url),'utf8');
  assert.match(index,/adminRegisterUberWeeklyClosure[\s\S]*?assertAdmin[\s\S]*?teamRealtimeDriverIsActive\(data\)&&!teamRealtimeDriverIsAdmin\(id,data\)/);
});

test('Fleet neto no inventa bruto fiscal; conserva informes históricos y advierte base incompleta',async()=>{
  const oldInput={cobros:[{id:'cash',type:'billing',method:'cash',amount:1000,status:'completed',createdAtMs:now-20*86400000}]};
  const old=buildMonthlyReport({uid,month:'2026-09',now,input:oldInput});
  assert.equal(Object.hasOwn(old,'fiscalComplete'),false);assert.equal(Object.hasOwn(old,'uberNetTotals'),false);
  const db=new MemoryStore();await registerAccepted(db);const week=rows(db).uberWeeks[0];
  const next=buildMonthlyReport({uid,month:'2026-09',now,input:{...oldInput,uber:[week]}});
  assert.deepEqual(next.totals,old.totals);assert.equal(next.fiscalComplete,false);
  assert.deepEqual(next.uberNetTotals,{cash:6000,digital:4000,total:10000,cashbox:1000,recordCount:1});
  assert.match(next.issues.join(' '),/sin bruto fiscal; base mensual incompleta/);
  const row=next.rows.find(row=>row.group==='Uber neto conciliado');assert.equal(row.included,false);assert.equal(row.settled,true);
  assert.equal(buildMonthlyReport({uid,month:'2026-09',now,input:oldInput}).revision,old.revision);
});
