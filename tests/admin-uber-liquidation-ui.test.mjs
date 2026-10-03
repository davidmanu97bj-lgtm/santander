import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {adminUberInput,adminUberWeek,parseUberNetAmount,adminUberReview,isPendingAdminUberConfirmation,driverUberConfirmationMarkup} from '../admin-uber-liquidation-ui.js';
import {periodMarkup,periodBreakdown} from '../period-ui.js';
const require=createRequire(import.meta.url);
const ExploraUberWeeklyPolicy=require('../functions/uber-weekly-policy.js');
const ExploraPeriodPolicy=require('../functions/period-policy.js');
const ExploraExpensePolicy=require('../functions/expense-policy.js');
const {quoteFromInput}=require('../functions/period-closure.js');
const {calculateTeamRealtimeSettlementBalance}=require('../functions/telegram-billing-balance.js');
const source=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
const declarations=[...source.matchAll(/^(?:async )?function \w+\([^\n]*/gm)].map(m=>source.slice(m.index,source.indexOf('\n}',m.index)+2)).join('\n');
const week={weekStartDate:'2026-09-21',weekCloseDate:'2026-09-28'};
const values={driverUid:'test-driver',cash:'6.000',digital:'4.000',total:'10.000',sourceReference:'Fleet semana 21 septiembre',reconciled:true};
const row=(cashAmount,transferAmount,extra={})=>({id:'fleet',driverUid:'test-driver',createdAtMs:1000,settlementRuleVersion:ExploraUberWeeklyPolicy.VERSION,settlementWorkflowVersion:ExploraUberWeeklyPolicy.WORKFLOW,adminConfirmed:true,reviewStatus:'completed',cashAmount,transferAmount,grossAmount:cashAmount+transferAmount,amount:cashAmount+transferAmount,...extra});
const input=(extra={})=>({records:[],expenses:[],uberWeeks:[],closures:[],debts:[],...extra});
function browserBalances(data) {
  return Array.from(vm.runInNewContext(`${declarations}\n[settlementModel().balance,adminBillingBalanceForDriver({uid:'test-driver'})]`,{
    ExploraUberWeeklyPolicy,ExploraPeriodPolicy,ExploraExpensePolicy,payments:data.records,expenses:data.expenses,uberClosures:data.uberWeeks,closures:data.closures,debts:data.debts,advances:[],debtPayments:[],adminPayments:data.records,adminExpenses:data.expenses,adminUberClosures:data.uberWeeks,adminAllClosures:data.closures,adminDebts:data.debts}));
}

test('admin sólo carga dos importes y el total se calcula sin una referencia ni un check',()=>{
  assert.deepEqual(adminUberInput({driverUid:'test-driver',cash:'6.000',digital:'4.000'},week),{driverUid:'test-driver',...week,cashAmount:6000,transferAmount:4000,totalAmount:10000});
  assert.equal(adminUberInput({...values,total:'999'},week).totalAmount,10000,'El total editable viejo no se usa');
  assert.equal(adminUberInput({...values,cash:'0,10',digital:'0,20'},week).totalAmount,.3);
  assert.equal(parseUberNetAmount('1.234,56'),1234.56);
  assert.equal(adminUberInput({...values,cash:'0',digital:'0',total:'0'},week).totalAmount,0);
  assert.deepEqual(adminUberWeek(new Date('2026-10-02T12:00:00Z')),week);
  assert.deepEqual(adminUberWeek(new Date('2026-09-28T12:00:00Z')),{weekStartDate:'2026-09-14',weekCloseDate:'2026-09-21'});
});

test('el formulario rechaza importe vacío/negativo, falta de chofer y total excesivo',()=>{
  for(const changes of [{digital:''},{cash:'-1'},{digital:'-1'},{cash:'1,001'},{cash:'NaN'},{driverUid:''},{cash:'60.000.000',digital:'60.000.000'}])assert.throws(()=>adminUberInput({...values,...changes},week));
  assert.throws(()=>parseUberNetAmount('-1'),/negativo.*Fleet/);
});

test('nuevo Uber: ambos clientes y servidor coinciden para efectivo, digital, mixto y cero',()=>{
  for(const [cash,digital,expected] of [[10000,0,6000],[0,10000,-4000],[6000,4000,2000],[0,0,0],[.01,.01,0],[100,.17,59.94],[100,1.95,59.23]]) {
    const data=input({uberWeeks:[row(cash,digital)]});
    assert.deepEqual(browserBalances(data),[expected,expected]);
    assert.equal(calculateTeamRealtimeSettlementBalance(data).balance,expected);
    const quote=quoteFromInput('test-driver',data);
    assert.equal(quote.balance,expected);
    assert.equal(quote.presentation.uber.cash,cash);assert.equal(quote.presentation.uber.digital,digital);
  }
});

test('tarjeta Uber debajo de Digital muestra dirección y no altera el cierre ni duplica la caja',()=>{
  for(const [cash,digital,message] of [[10000,0,'Pasale'],[0,10000,'Explora te pasa'],[0,0,'Sin importe pendiente']]) {
    const data=input({uberWeeks:[row(cash,digital)]}),quote=quoteFromInput('test-driver',data),before=JSON.stringify(quote);
    const html=periodMarkup(quote),sections=html.split('</section>');
    assert.match(sections[1],/>Digital<\/h2>/);assert.match(sections[2],/>UBER<\/h2>/);
    assert.ok(sections[2].includes(message));assert.match(sections[2],/se suman una sola vez/);
    assert.doesNotMatch(sections[2],/Caja chica de Uber incluida/);
    assert.equal(quote.presentation.uber.walletDifference,(cash-digital)/2);
    assert.equal(quote.presentation.ordinary.cash,0);assert.equal(quote.presentation.ordinary.digital,0);
    assert.match(sections[2],/Total cobrado efectivo/);assert.match(sections[2],/Total cobrado digital/);
    assert.equal(periodBreakdown(quote).lines.reduce((sum,line)=>sum+line.balance,0),quote.balance);
    assert.equal(quote.summary.cashbox,(cash+digital)*.1);
    periodMarkup(quote);assert.equal(JSON.stringify(quote),before,'renderizar repetidamente es sólo lectura');
  }
});

test('Uber compensa caja, billeteras y gastos sin alterar recibos anteriores',()=>{
  const base={driverUid:'test-driver',settlementRuleVersion:ExploraPeriodPolicy.VERSION,createdAtMs:1000};
  const data=input({uberWeeks:[row(6000,4000)],records:[{...base,id:'digital',method:'digital',amount:10000}],expenses:[{...base,id:'expense',expenseType:'combustible',expensePaymentMethod:'cash',receiptFlowVersion:ExploraExpensePolicy.version,amount:2000}]});
  assert.deepEqual(browserBalances(data),[-3000,-3000]);
  assert.equal(quoteFromInput('test-driver',data).balance,-3000);
  const legacy=row(10000,0,{id:'legacy',settlementRuleVersion:ExploraPeriodPolicy.VERSION,settlementWorkflowVersion:'v85_verified_direct',verifiedAutomatically:true});
  const quote=quoteFromInput('test-driver',input({uberWeeks:[legacy,row(0,10000)]}));
  assert.equal(quote.balance,2000);assert.equal(quote.presentation.uber.unavailableTotal,10000);
  assert.match(periodMarkup(quote),/Desglose no disponible para liquidaciones anteriores/);
});

test('los centavos de Fleet coinciden en los dos clientes, el servidor y la vista previa, también tras un ancla',()=>{
  for(let digitalCents=0;digitalCents<200;digitalCents++) {
    const entry=row(100,digitalCents/100),expected=ExploraUberWeeklyPolicy.calculate(entry).balance;
    const data=input({uberWeeks:[entry]});
    assert.deepEqual(browserBalances(data),[expected,expected],String(digitalCents));
    assert.equal(calculateTeamRealtimeSettlementBalance(data).balance,expected,String(digitalCents));
    assert.equal(quoteFromInput('test-driver',data).presentation.uber.balance,expected,String(digitalCents));
  }
  for(const digital of [.17,1.95]) {
    const legacy=row(10000,0,{settlementRuleVersion:ExploraPeriodPolicy.VERSION,settlementWorkflowVersion:'v85_verified_direct',verifiedAutomatically:true});
    const newer=row(100,digital,{id:'newer',createdAtMs:3000});
    const records=[{id:'anchor',driverUid:'test-driver',type:'reimbursement_compensation',settlementAfter:7500,createdAtMs:2000}];
    const data=input({records,uberWeeks:[legacy,newer]}),expected=7500+ExploraUberWeeklyPolicy.calculate(newer).balance;
    assert.deepEqual(browserBalances(data),[expected,expected]);
    assert.equal(calculateTeamRealtimeSettlementBalance(data).balance,expected);
  }
});

test('Uber futuro no confirmado o simulado queda fuera también en clientes',()=>{
  for(const extra of [{adminConfirmed:false},{reviewStatus:'pending_admin_review'},{deleted:true},{isSimulated:true}])assert.deepEqual(browserBalances(input({uberWeeks:[row(6000,4000,extra)]})),[0,0]);
});

test('historial de nuevo Uber separa principal y caja sin repetir impacto',()=>{
  const context={ExploraUberWeeklyPolicy,ExploraPeriodPolicy,ExploraExpensePolicy};
  const receipt={...row(6000,4000),method:'uber',amount:10000,settlementBeforeAdminDecision:100,settlementAfterAdminDecision:2100};
  const calculate=item=>vm.runInNewContext(`${declarations}\nreceiptBalanceSnapshot(item)`,{...context,item});
  const principal=calculate({...receipt,type:'uber_receipt'}),cashbox=calculate({...receipt,type:'cashbox_receipt',amount:1000,_cashboxGrossAmount:10000});
  assert.equal(principal.movementImpact,1000);assert.equal(cashbox.movementImpact,1000);assert.equal(principal.after,cashbox.before);assert.equal(cashbox.after,2100);
  assert.match(adminUberReview(ExploraUberWeeklyPolicy.calculate({cashAmount:0,transferAmount:10000})),/El chofer revisa y acepta/);
});

test('confirmación del chofer muestra efectivo, digital, total y 10% sin alterar históricos',()=>{
  const pending=row(21100,22959,{driverConfirmationRequired:true,driverConfirmed:false,reviewStatus:'awaiting_driver_confirmation'});
  assert.equal(isPendingAdminUberConfirmation(pending),true);
  for(const extra of [{driverConfirmed:true},{deleted:true},{driverConfirmationRequired:false},{reviewStatus:'completed'},{adminConfirmed:false}])assert.equal(isPendingAdminUberConfirmation({...pending,...extra}),false);
  const html=driverUberConfirmationMarkup(pending,ExploraUberWeeklyPolicy);
  for(const text of ['21.100','22.959','44.059','4.405,9','Al aceptar'])assert.ok(html.includes(text),text);
  assert.doesNotMatch(html,/45%|5%|Sin transferencia/);
});
