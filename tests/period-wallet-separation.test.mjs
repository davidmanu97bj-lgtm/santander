import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {MemoryStore} from '../tools/preview/memory-store.mjs';

const require=createRequire(import.meta.url);
const {quoteFromInput,periodQuote,confirmPeriodClosure}=require('../functions/period-closure.js');
const policy=require('../functions/period-policy.js');
const fleetPolicy=require('../functions/uber-weekly-policy.js');
const uid='driver-test';
const base={driverUid:uid,createdAtMs:1000};
const fleet=(id,cash,digital,extra={})=>({...base,id,cashAmount:cash,transferAmount:digital,amount:cash+digital,totalAmount:cash+digital,
  settlementRuleVersion:fleetPolicy.VERSION,settlementWorkflowVersion:fleetPolicy.WORKFLOW,adminConfirmed:true,reviewStatus:'completed',...extra});
const record=(id,method,amount,extra={})=>({...base,id,method,amount,settlementRuleVersion:policy.VERSION,...extra});
const expense=(id,expensePaymentMethod,amount,expenseType='combustible')=>({...base,id,expensePaymentMethod,amount,expenseType,
  settlementRuleVersion:policy.VERSION,receiptFlowVersion:'gross_expense_policy_v3'});
const legacy=(id,amount,version=policy.VERSION)=>({...base,id,amount,grossAmount:amount,settlementRuleVersion:version,
  settlementWorkflowVersion:'v85_verified_direct',verifiedAutomatically:true,reviewStatus:'completed'});
const input=extra=>({records:[],expenses:[],uberWeeks:[],closures:[],debts:[],...extra});
const fixtures={
  requested:()=>input({uberWeeks:[fleet('fleet',21100,22959)]}),
  equal:()=>input({uberWeeks:[fleet('fleet',10000,10000)]}),
  mixed:()=>input({records:[record('cash','cash',12000),record('digital','digital',8000),record('no-box','cash',1000,{excludeFromCashbox:true})],
    expenses:[expense('fuel','cash',1200),expense('fine','digital',800,'multa')],uberWeeks:[fleet('fleet',5000,7000),legacy('legacy',6000)]}),
  old:()=>input({uberWeeks:[legacy('old',10000,'uber_gross_cash_cashbox_5_v1')]}),
  cents:()=>input({uberWeeks:[fleet('one',100.01,0),fleet('two',100.01,0)]}),
  small:()=>input({uberWeeks:[fleet('fleet',.7,0)]}),
  smallMixed:()=>input({uberWeeks:[fleet('fleet',.7,0)],records:[record('cash','cash',.7)]})
};
// Captured from c65e070 before adding presentation metadata. The fingerprint
// includes the complete authoritative summary, balance, cutoff and source IDs.
const baseline={
  requested:{quoteId:'34b0b7912b8c6655c04d50e6c4e477d2797a76897629d74e140f351bd89faf69',balance:3476.4},
  equal:{quoteId:'883ac85f5065cb31834d06bae18ec0d2a1cc8a76c7f930995b3e96935c45ac62',balance:2000},
  mixed:{quoteId:'83e91202646a56bb37903662a5ec5678196c9958affb09bf6c8cb99c2c384ee0',balance:8500},
  old:{quoteId:'3a1224c81f783f3692bf18efdfb921e8857d35504cd10f46a1447918c6ae33c0',balance:10500},
  cents:{quoteId:'5c87e9b61a783881d0f4b9d90f02fac892dc6bd431a1cda44e7999048e9259af',balance:120.02},
  small:{quoteId:'c4b4015c703a6a8ef8617e708777e439cc84f06de37f36e0165f6a7682757a61',balance:0},
  smallMixed:{quoteId:'18d4c14279e3f708466091b89437914aa40f0c4b91974a584d98e529acf11a77',balance:.84}
};
const zeroOrdinary={cash:0,digital:0,cashExpense:0,digitalExpense:0,netCash:0,netDigital:0,gross:0,cashbox:0,walletDifference:0,walletTarget:0};
function displayedBalance(q) {
  const {ordinary,uber,previousBalance,roundingAdjustment}=q.presentation;
  return policy.round(ordinary.walletDifference+uber.walletDifference+ordinary.cashbox+uber.cashboxInPeriod+
    q.summary.responsibilityAdjustment+q.summary.externalDebt+previousBalance+roundingAdjustment);
}
function freeze(value) {
  if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}
  return value;
}

test('presentation metadata preserves every baseline financial quote and never mutates its inputs',()=>{
  for(const [name,make] of Object.entries(fixtures)) {
    const data=make(),before=structuredClone(data),q=quoteFromInput(uid,freeze(data));
    assert.equal(q.quoteId,baseline[name].quoteId,name);
    assert.equal(q.balance,baseline[name].balance,name);
    assert.equal(q.amount,Math.abs(baseline[name].balance),name);
    assert.equal(displayedBalance(q),q.balance,name);
    assert.deepEqual(data,before,name);
  }
});

test('44,059 Uber separates a -929.50 wallet transfer and 4,405.90 cashbox from the 3,476.40 closing balance',()=>{
  const q=quoteFromInput(uid,fixtures.requested()),u=q.presentation.uber;
  assert.deepEqual(q.presentation.ordinary,zeroOrdinary);
  assert.equal(u.cash,21100);assert.equal(u.digital,22959);assert.equal(u.total,44059);
  assert.equal(u.walletDifference,-929.5);assert.equal(u.walletTarget,22029.5);
  assert.equal(u.cashboxInPeriod,4405.9);assert.equal(u.cashboxGrossInPeriod,44059);
  assert.equal(u.balance,3476.4);assert.equal(q.balance,3476.4);
  assert.equal(q.presentation.previousBalance,0);assert.equal(u.unavailableCount,0);
});

test('equal Uber wallets need no wallet transfer while retaining the 10% cashbox',()=>{
  const q=quoteFromInput(uid,fixtures.equal()),u=q.presentation.uber;
  assert.equal(u.walletDifference,0);assert.equal(u.walletTarget,10000);
  assert.equal(u.cashboxInPeriod,2000);assert.equal(u.cashboxGrossInPeriod,20000);
  assert.equal(q.balance,2000);assert.deepEqual(q.presentation.ordinary,zeroOrdinary);
});

test('ordinary receipts and expenses exclude every Uber week; unavailable legacy 10% remains in prior balance',()=>{
  const q=quoteFromInput(uid,fixtures.mixed()),{ordinary,uber}=q.presentation;
  assert.deepEqual(ordinary,{cash:13000,digital:8000,cashExpense:1200,digitalExpense:800,netCash:11800,netDigital:7200,
    gross:21000,cashbox:2000,walletDifference:2300,walletTarget:9500});
  assert.equal(uber.walletDifference,-1000);assert.equal(uber.walletTarget,6000);
  assert.equal(uber.cashboxInPeriod,1200);assert.equal(uber.cashboxGrossInPeriod,12000);
  assert.equal(uber.unavailableCount,1);assert.equal(uber.unavailableTotal,6000);
  assert.equal(q.presentation.previousBalance,3600);assert.equal(q.presentation.roundingAdjustment,0);
  // Existing Uber fields retain their former meaning and values for other callers.
  assert.deepEqual(Object.fromEntries(['cash','digital','total','cashbox','balance','recordCount','unavailableTotal','unavailableCount'].map(key=>[key,uber[key]])),
    {cash:5000,digital:7000,total:18000,cashbox:1800,balance:3800,recordCount:2,unavailableTotal:6000,unavailableCount:1});
  assert.deepEqual(q.summary,{cash:24000,digital:15000,cashExpense:1200,digitalExpense:800,netCash:22800,netDigital:14200,gross:39000,
    cashbox:3800,walletDifference:4300,responsibilityAdjustment:400,previousBalance:0,externalDebt:0,externalDebtRows:[],
    debtRows:[{id:'fine',label:'Multa',amount:800}],driverExpenseTotal:800,exploraExpenseTotal:0});
});

test('unknown 5% history does not produce a negative ordinary cashbox or a duplicate 10% charge',()=>{
  const q=quoteFromInput(uid,fixtures.old()),{ordinary,uber}=q.presentation;
  assert.deepEqual(ordinary,zeroOrdinary);
  assert.equal(uber.cash,0);assert.equal(uber.digital,0);assert.equal(uber.walletDifference,0);assert.equal(uber.walletTarget,0);
  assert.equal(uber.cashbox,500);assert.equal(uber.cashboxInPeriod,0);assert.equal(uber.cashboxGrossInPeriod,0);
  assert.equal(uber.unavailableCount,1);assert.equal(uber.unavailableTotal,10000);
  assert.equal(q.summary.cashbox,0);assert.equal(q.presentation.previousBalance,10500);
  assert.equal(displayedBalance(q),10500);
});

test('per-week cent rounding and the ledger tolerance stay outside prior balances when there is no history',()=>{
  const cents=quoteFromInput(uid,fixtures.cents());
  assert.equal(cents.presentation.uber.walletDifference,100.02);
  assert.equal(cents.presentation.uber.cashboxInPeriod,20);
  assert.equal(cents.presentation.previousBalance,0);
  const small=quoteFromInput(uid,fixtures.small());
  assert.equal(small.presentation.uber.walletDifference,.35);assert.equal(small.presentation.uber.cashboxInPeriod,.07);
  assert.equal(small.presentation.previousBalance,0);assert.equal(small.presentation.roundingAdjustment,-.42);
  const combined=quoteFromInput(uid,fixtures.smallMixed());
  assert.equal(combined.balance,.84);assert.equal(combined.presentation.uber.walletDifference,.35);
  assert.equal(combined.presentation.previousBalance,0);assert.equal(combined.presentation.roundingAdjustment,0);
  const historical=quoteFromInput(uid,input({records:[record('cash','cash',1)],uberWeeks:[legacy('old',.1)]}));
  assert.equal(historical.presentation.previousBalance,.06);
  assert.equal(historical.presentation.roundingAdjustment,0);
  assert.equal(displayedBalance(historical),historical.balance);
});

test('cutoffs and eligibility keep pending, rejected, simulated, deleted and previous Uber out of cards',()=>{
  const data=input({records:[{id:'anchor',...base,type:'reimbursement_compensation',settlementAfter:1000,createdAtMs:2000},
    record('old-record','cash',500),record('new-record','digital',100,{createdAtMs:3000})],
    uberWeeks:[fleet('old-fleet',300,500),legacy('old-legacy',1000),fleet('new-fleet',100,50,{createdAtMs:3000}),
      ...[{reviewStatus:'pending_driver_confirmation'},{reviewStatus:'rejected'},{isSimulated:true},{deleted:true}].map((extra,i)=>fleet('excluded-'+i,9999,9999,{createdAtMs:3000,...extra}))]});
  const q=quoteFromInput(uid,data);
  assert.equal(q.cutoffAtMs,2000);assert.equal(q.presentation.ordinary.cash,0);assert.equal(q.presentation.ordinary.digital,100);
  assert.equal(q.presentation.uber.cash,100);assert.equal(q.presentation.uber.digital,50);assert.equal(q.presentation.uber.recordCount,1);
  assert.equal(q.presentation.uber.cashboxInPeriod,15);assert.equal(q.presentation.previousBalance,1000);
  assert.equal(q.presentation.roundingAdjustment,0);assert.equal(displayedBalance(q),q.balance);
});

test('a quote issued before this change still closes and persists only its unchanged settlement summary',async()=>{
  const data=fixtures.mixed(),collections={records:'billing_records',expenses:'gastos',uberWeeks:'uber_weekly_closures',closures:'cierres_semanales',debts:'deudas_choferes'};
  const db=new MemoryStore(Object.fromEntries(Object.entries(data).flatMap(([key,rows])=>rows.map(row=>[`${collections[key]}/${row.id}`,row]))));
  const before=structuredClone([...db.data]),quote=await periodQuote({db,uid});
  assert.equal(quote.quoteId,baseline.mixed.quoteId);
  const request={quoteId:baseline.mixed.quoteId,proofPath:`cierres_semanales/period/${uid}/${baseline.mixed.quoteId}/proof.png`};
  const context={db,uid,input:request,now:2000,proofMetadata:async()=>({size:100,contentType:'image/png',generation:'1',url:'https://example.test/proof.png'})};
  const result=await confirmPeriodClosure(context),closed=db.data.get('cierres_semanales/'+result.id);
  assert.equal(closed.settlementBefore,baseline.mixed.balance);assert.equal(closed.settlementAfter,0);
  assert.deepEqual(closed.settlementSummary,quote.summary);
  assert.equal('presentation' in closed,false);assert.equal('ordinary' in closed.settlementSummary,false);
  for(const [path,row] of before)assert.deepEqual(db.data.get(path),row);
  const afterWrite=structuredClone([...db.data]),after=await periodQuote({db,uid});
  assert.equal(after.balance,0);assert.deepEqual(after.presentation.ordinary,zeroOrdinary);
  assert.equal(after.presentation.uber.recordCount,0);assert.equal(after.presentation.previousBalance,0);
  assert.equal((await confirmPeriodClosure(context)).alreadyClosed,true);
  assert.deepEqual([...db.data],afterWrite,'reading or retrying a completed closure does not rewrite it');
});
