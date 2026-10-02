import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {calculateTeamRealtimeSettlementBalance}=require('../functions/telegram-billing-balance.js');
const {quoteFromInput}=require('../functions/period-closure.js');
const {VERSION}=require('../functions/period-policy.js');
const base={driverUid:'driver-test',createdAtMs:1000,settlementRuleVersion:VERSION};
const uber=(cash,digital,extra={})=>({...base,id:'uber',grossAmount:cash+digital,amount:cash+digital,cashAmount:cash,transferAmount:digital,settlementWorkflowVersion:'v85_verified_direct',verifiedAutomatically:true,reviewStatus:'completed',...extra});
const payment=(method,amount)=>({...base,id:method,method,amount});
const input=(extra={})=>({records:[],expenses:[],uberWeeks:[],debts:[],closures:[],...extra});
const balance=data=>calculateTeamRealtimeSettlementBalance(input(data)).balance;

// Lock the existing Uber rule; digital Uber is not the ordinary digital wallet.
test('Uber vigente: efectivo, digital, mixto y cero conservan el cálculo autoritativo',()=>{
  for(const [cash,digital,expected] of [[10000,0,6000],[0,10000,-5000],[6000,4000,1600],[0,0,0]]) {
    assert.equal(balance({uberWeeks:[uber(cash,digital)]}),expected);
  }
});

test('Uber compensa billeteras y gastos sin duplicar su caja chica',()=>{
  const uberWeeks=[uber(10000,0)];
  assert.equal(balance({uberWeeks,records:[payment('digital',10000)]}),2000);
  assert.equal(balance({uberWeeks,records:[payment('cash',10000)]}),12000);
  const expense=(expenseType,expensePaymentMethod,amount)=>({...base,id:'expense',expenseType,expensePaymentMethod,amount,receiptFlowVersion:'gross_expense_policy_v3'});
  assert.equal(balance({uberWeeks,records:[payment('digital',10000)],expenses:[expense('combustible','cash',4000)]}),0);
  assert.equal(balance({uberWeeks,expenses:[expense('cubiertas','cash',2000)]}),4000);
  assert.equal(balance({uberWeeks,expenses:[expense('multa','digital',2000)]}),8000);
});

test('Uber pendiente, rechazado, simulado o eliminado no se liquida',()=>{
  for(const extra of [{reviewStatus:'pending_admin_review'},{reviewStatus:'rejected'},{verifiedAutomatically:false},{deleted:true},{isSimulated:true}]) {
    assert.equal(balance({uberWeeks:[uber(10000,0,extra)]}),0);
  }
  for(const [workflow,flag] of [['v84_driver_submission_admin_review','adminConfirmed'],['v82_admin_driver_confirmation','driverConfirmed']]) {
    assert.equal(balance({uberWeeks:[uber(10000,0,{settlementWorkflowVersion:workflow,reviewStatus:'approved',[flag]:false})]}),0);
    assert.equal(balance({uberWeeks:[uber(10000,0,{settlementWorkflowVersion:workflow,reviewStatus:'approved',[flag]:true})]}),6000);
  }
});

test('consulta sin Uber conserva resumen, saldo e identidad de cierre anteriores',()=>{
  const quote=quoteFromInput('driver-test',input({records:[payment('cash',10000)]}));
  assert.equal(quote.balance,6000);
  assert.equal(quote.quoteId,'8fdd2d287ff81ea69f6a499d3258d021bfc649f684030105222cc527d56d3875');
  assert.deepEqual(quote.summary,{cash:10000,digital:0,cashExpense:0,digitalExpense:0,netCash:10000,netDigital:0,gross:10000,cashbox:1000,walletDifference:5000,responsibilityAdjustment:0,previousBalance:0,externalDebt:0,externalDebtRows:[],debtRows:[],driverExpenseTotal:0,exploraExpenseTotal:0});
});

test('Uber anterior a una compensación permanece dentro del saldo anclado',()=>{
  const records=[{id:'anchor',driverUid:'driver-test',type:'reimbursement_compensation',settlementAfter:7500,createdAtMs:2000}];
  assert.equal(balance({records,uberWeeks:[uber(10000,0)]}),7500);
  assert.equal(balance({records,uberWeeks:[uber(10000,0),uber(0,10000,{id:'new',createdAtMs:3000})]}),2500);
});

test('una liquidación Uber ya registrada conserva su identidad de cierre y su cálculo',()=>{
  const data=input({uberWeeks:[uber(10000,0)]}),before=JSON.stringify(data);
  const quote=quoteFromInput('driver-test',data);
  assert.equal(quote.quoteId,'5ab1a8a7f4bc1e88488f9bad620d02f8ed70b62319ab40115155504231a0d975');
  assert.equal(quote.balance,6000);
  assert.equal(quote.summary.cash,10000);
  assert.equal(quote.summary.digital,0);
  assert.equal(quote.summary.cashbox,1000);
  assert.equal(quote.summary.previousBalance,0);
  assert.equal(JSON.stringify(data),before,'la consulta no cambia los datos');
});
