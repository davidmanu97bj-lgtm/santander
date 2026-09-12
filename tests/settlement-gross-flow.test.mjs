import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { calculateTeamRealtimeSettlementBalance, calculateOpenBillingBalance } = require('../functions/telegram-billing-balance.js');
const appSource = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
// Run the shipped, top-level functions; omit Firebase initialization and UI listeners.
// In app.js top-level function closing braces occupy their own unindented line.
const declarations = [...appSource.matchAll(/^(?:async )?function \w+\([^\n]*/gm)].map(match => {
  const end = appSource.indexOf('\n}', match.index);
  assert.ok(end > match.index, `Unclosed function: ${match[0]}`);
  return appSource.slice(match.index, end + 2);
}).join('\n');
const rule = 'gross_cash_digital_cashbox_5_v1';
const payment = (method, amount, modern = true, extra = {}) => ({
  id:`${method}-${amount}`, method, paymentMethod:method, amount, createdAtMs:1000,
  driverUid:'test-driver', ...(modern ? {settlementRuleVersion:rule} : {}), ...extra
});
function frontend(input) {
  return vm.runInNewContext(`${declarations}\n({balance:settlementModel().balance, admin:adminBillingBalanceForDriver({uid:'test-driver'}), cashbox:openCashboxAmount(), preview:previewDefinition('digital',10000).delta, receipts:buildUnifiedReceipts()})`, {
    payments:input.records || [], closures:input.closures || [], expenses:input.expenses || [], debts:[], advances:[], debtPayments:[], uberClosures:[],
    adminPayments:input.records || [], adminAllClosures:input.closures || [], adminExpenses:input.expenses || [], adminDebts:[], adminUberClosures:[], money:value => `$${value}`
  }, {timeout:1000});
}
function assertBalance(input, expected, {legacyAnchor = false} = {}) {
  const front = frontend(input);
  assert.equal(front.balance, expected, 'conductor');
  assert.equal(front.admin, expected, 'administrador');
  assert.equal(calculateTeamRealtimeSettlementBalance(input).balance, expected, 'saldo del servidor');
  if (!legacyAnchor) assert.equal(calculateOpenBillingBalance(input).netToDriver, expected ? -expected : 0, 'notificación');
  return front;
}

test('los nuevos cobros aplican el bruto completo y el 5% por separado', () => {
  assertBalance({records:[payment('cash',10000)]}, 10500);
  const digital = assertBalance({records:[payment('digital',10000)]}, -9500);
  assert.equal(digital.cashbox, 500);
  assert.equal(digital.preview, -9500);
  assert.equal(digital.receipts.length, 2);
  assert.equal(digital.receipts.find(row => row.type === 'cashbox_receipt').amount, 500);
  assertBalance({records:[payment('cash',10000),payment('digital',10000)]}, 1000);
});

test('los cobros anteriores retienen su regla incluso al mezclarlos con nuevos', () => {
  const old = payment('digital',10000,false);
  assertBalance({records:[old]}, -5000);
  const mixed = assertBalance({records:[old,payment('digital',10000,true,{id:'new'})]}, -14500);
  assert.equal(mixed.cashbox, 500);
  assert.equal(mixed.receipts.length, 3);
  assert.equal(old.settlementRuleVersion, undefined);
});

test('el 50% de los gastos reduce deuda y puede invertir quién paga', () => {
  const records = [payment('cash',10000)];
  assertBalance({records, expenses:[{amount:10000,driverUid:'test-driver',createdAtMs:2000,autoApplyToBilling:true}]}, 5500);
  assertBalance({records, expenses:[{amount:30000,driverUid:'test-driver',createdAtMs:2000,autoApplyToBilling:true}]}, -4500);
});

test('un cierre pagado permanece saldado y el cobro siguiente usa la regla nueva', () => {
  const records = [payment('digital',10000,false), payment('cash',5000,false,{id:'paid',type:'settlement_adjustment',adjustmentDirection:'explora_to_driver',createdAtMs:2000})];
  const closures = [{driverUid:'test-driver',closureKind:'facturacion',closureMode:'settlement_only',status:'completed',paidAmountTotal:5000,createdAtMs:2000}];
  assertBalance({records,closures}, 0);
  assertBalance({records:[...records,payment('digital',10000,true,{id:'new',createdAtMs:3000})],closures}, -9500);
});

test('respeta las bases de migración y las fotografías históricas al aplicar la nueva regla', () => {
  const records = [payment('digital',20000,false), payment('digital',10000,true,{id:'new',createdAtMs:3000})];
  const closures = [{driverUid:'test-driver',closureKind:'facturacion',closureMode:'on_demand',status:'closed',cutoffAtMs:2000}];
  assertBalance({records,closures}, -9500, {legacyAnchor:true});
  assertBalance({records:[...records,payment('cash',100,false,{id:'anchor',type:'reimbursement_compensation',settlementAfter:2000,createdAtMs:2000})]}, -7500, {legacyAnchor:true});
});

test('correcciones y bajas recalculan desde el bruto sin duplicar la caja chica', () => {
  assertBalance({records:[payment('digital',20000,true,{cashboxAmount:500,principalMovementAmount:-10000})]}, -19000);
  assertBalance({records:[payment('digital',20000,true,{deleted:true})]}, 0);
  assertBalance({records:[payment('digital',10000,true,{excludeFromCashbox:true})]}, -10000);
});

test('el ejemplo del usuario produce 0 → 100000 → 105000 → 5000 → 10000', () => {
  const input = {records:[payment('cash',100000,true,{telegramSettlementBeforeBalance:0,telegramSettlementAfterBalance:105000}),payment('digital',100000,true,{createdAtMs:2000,telegramSettlementBeforeBalance:105000,telegramSettlementAfterBalance:10000})]};
  const result = assertBalance(input,10000);
  const ordered = [...result.receipts].sort((a,b)=>a.createdAtMs-b.createdAtMs || b._sortPriority-a._sortPriority);
  const timeline=vm.runInNewContext(`${declarations}\nreceipts.map(receiptBalanceSnapshot)`,{receipts:ordered});
  assert.deepEqual(JSON.parse(JSON.stringify(timeline)),[
    {before:0,after:100000,movementImpact:100000},
    {before:100000,after:105000,movementImpact:5000},
    {before:105000,after:5000,movementImpact:-100000},
    {before:5000,after:10000,movementImpact:5000}
  ]);
});

test('gasto 50000 y reintegro 25000 muestran dos pasos y compensan solo 25000', () => {
  const input = {records:[payment('cash',100000),payment('digital',100000)],expenses:[{id:'expense',amount:50000,driverUid:'test-driver',createdAtMs:2000,autoApplyToBilling:true,receiptFlowVersion:'gross_expense_reimbursement_50_v1',telegramSettlementBeforeBalance:10000,telegramSettlementAfterBalance:-15000}]};
  const result=assertBalance(input,-15000);
  const rows=result.receipts.filter(row=>row.method==='expense');
  const timeline=vm.runInNewContext(`${declarations}\nreceipts.map(receiptBalanceSnapshot)`,{receipts:rows});
  assert.deepEqual(JSON.parse(JSON.stringify(timeline)),[
    {before:-40000,after:-15000,movementImpact:25000},
    {before:10000,after:-40000,movementImpact:-50000}
  ]);
  assert.equal(timeline[0].after,result.balance,'el Después de la primera tarjeta coincide con el resultado actual');
});

test('más recientes muestra primero caja o reintegro y más antiguos muestra primero su operación', () => {
  const result = frontend({records:[payment('cash',100000),payment('digital',100000)],expenses:[{id:'expense',amount:50000,createdAtMs:1000,receiptFlowVersion:'gross_expense_reimbursement_50_v1'}]});
  for (const order of ['newest','oldest']) {
    const rows=vm.runInNewContext(`${declarations}\nsortUnifiedReceipts(receipts,order)`,{receipts:result.receipts,order});
    assert.equal(rows.length,6);
    for (let i=0;i<rows.length;i+=2) {
      assert.equal(rows[i]._sortPriority,order === 'newest' ? 1 : 2);
      assert.equal(rows[i+1]._sortPriority,order === 'newest' ? 2 : 1);
      assert.equal(rows[i]._receiptGroupKey,rows[i+1]._receiptGroupKey);
    }
    const page=vm.runInNewContext(`${declarations}\nvisibleReceiptRows(receipts,3)`,{receipts:rows});
    assert.equal(page.length,4,'la paginación mantiene completa la última pareja');
  }
});
