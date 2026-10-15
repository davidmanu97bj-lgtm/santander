import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {receiptCycle,currentCycleReceipts,receiptRecordedAtMs,recentActivitiesMarkup} from '../explora-ui.js';

const cut=Date.parse('2026-10-10T15:00:00Z');
const close=overrides=>({id:'close',closureKind:'facturacion',closureMode:'settlement_only',status:'completed',remainingAmount:0,cutoffAtMs:cut,createdAtMs:cut,completedAtMs:cut+10000,...overrides});
const receipt=(id,time,extra={})=>({id,createdAtMs:time,method:'cash',type:'payment',_receiptGroupKey:`payment:${id}`,amount:100,...extra});
const ids=rows=>rows.map(row=>row.id);

test('nuevo y antiguo reinician comprobantes al corte incluido, sin modificar el historial',()=>{
  for(const closure of [close({closureWorkflowVersion:'period_proof_automatic_v1'}),close({closureMode:'on_demand',status:'closed'}),close({status:'completed',reviewStatus:'approved'})]){
    const rows=[receipt('old',cut-1),receipt('boundary',cut),receipt('new',cut+1)];
    const before=structuredClone({rows,closure});
    assert.deepEqual(ids(currentCycleReceipts(rows,receiptCycle([closure]))),['new']);
    assert.deepEqual({rows,closure},before,'Presentation never writes or removes source documents');
  }
  assert.deepEqual(ids(currentCycleReceipts([receipt('first',cut)],receiptCycle([]))),['first']);
});

test('pendientes, pagos parciales, rechazos y cierres de otro módulo no reinician',()=>{
  const invalid=[{status:'requested'},{status:'awaiting_admin_review',reviewStatus:'pending'},
    {status:'partial',reviewStatus:'approved'},{status:'partially_paid'},
    {status:'completed',remainingAmount:100},{status:'rejected'},{deleted:true},{rollbackRestored:true},{isSimulated:true},
    {status:'requested',paymentStatus:'paid'},
    {cutoffActive:false},{closureStatus:'cancelled'},{closureKind:'gastos'},
    {closureKind:'caja_chica'},{closureKind:'uber'}];
  for(const extra of invalid)assert.equal(receiptCycle([close(extra)]).cutoffAtMs,0,JSON.stringify(extra));
  assert.equal(receiptCycle([close({status:'approved',remainingAmount:0})]).cutoffAtMs,cut);
});

test('el normalizador real conserva el cierre antiguo finalizado sin confundir su saldo sintético con un pago parcial',()=>{
  const source=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
  const start=source.indexOf('function normalizeClosureRecord('),end=source.indexOf('\n}',start)+2;
  const normalize=vm.runInNewContext(`(${source.slice(start,end)})`,{recordProofUrl:()=>'',recordProofPath:()=>'',recordDayKey:()=>''});
  const base={closureKind:'facturacion',closureMode:'on_demand',cutoffAtMs:cut,requestedAmount:1000};
  const rows=[receipt('old',cut-1),receipt('new',cut+1)];
  for(const status of ['closed','paid','completed']){
    const raw={...base,status},normalized=normalize('legacy',raw);
    assert.equal(normalized.remainingAmount,1000,'Financial fallback is unchanged');
    assert.equal(normalized.paidAmountTotal,0,'Financial fallback is unchanged');
    assert.equal(normalized._receiptCycleBalanceKnown,false);
    assert.deepEqual(ids(currentCycleReceipts(rows,receiptCycle([normalized]))),['new']);
    assert.equal(receiptCycle([{receiptCycleRecord:normalized,kind:'closure'}]).cutoffAtMs,cut,'Same rule for admin presentation');
    assert.equal(raw.remainingAmount,undefined,'Persisted source is not mutated');
  }
  const legacyPaid=normalize('legacy-paid',{closureMode:'on_demand',closureKind:'facturacion',status:'closed',
    paymentStatus:'paid',paid:true,completed:true,amountDueFromDriver:1000,amountDueToDriver:0,cutoffAtMs:cut});
  assert.equal(legacyPaid.remainingAmount,1000);
  assert.equal(receiptCycle([legacyPaid]).cutoffAtMs,cut);
  for(const extra of [{status:'partial'},{status:'partially_paid'},
    {status:'closed',remainingAmount:25},{status:'completed',paidAmountTotal:100},
    {status:'paid',amountPaid:100},{status:'closed',billingSettlementPaymentTotal:100},
    {status:'approved'},{status:'requested',paid:true}]){
    assert.equal(receiptCycle([normalize('partial',{...base,...extra})]).cutoffAtMs,0,JSON.stringify(extra));
  }
  assert.equal(receiptCycle([normalize('approved',{...base,status:'approved',paidAmountTotal:1000})]).cutoffAtMs,cut);
  assert.equal(receiptCycle([normalize('modern',{...base,status:'completed',remainingAmount:0,closureWorkflowVersion:'period_proof_automatic_v1'})]).cutoffAtMs,cut);
});

test('usa el corte real anterior a la confirmación y creación antes que fecha o edición del gasto',()=>{
  const cycle=receiptCycle([close({cutoffAtMs:undefined,cutoffAt:{seconds:cut/1000},requestedAtMs:cut+100})]);
  assert.equal(cycle.cutoffAtMs,cut);
  const old=receipt('old-expense',cut-100,{method:'expense',type:'expense_receipt',_receiptGroupKey:'expense:old-expense',updatedAt:new Date(cut+90000)});
  const late=receipt('late-expense',cut+50,{method:'expense',type:'expense_receipt',_receiptGroupKey:'expense:late-expense',expenseDate:new Date(cut-86400000),fechaISO:'2026-09-01'});
  assert.deepEqual(ids(currentCycleReceipts([old,late,receipt('new-trip',cut+10,{date:'2026-09-01'})],cycle)),['late-expense','new-trip']);
  assert.equal(receiptRecordedAtMs(late),cut+50);
  assert.equal(receiptRecordedAtMs({createdAt:{seconds:cut/1000,nanoseconds:1000000}}),cut+1);
});

test('los IDs incluidos y el pago de cierre permanecen en el historial aunque tengan fecha posterior',()=>{
  const cycle=receiptCycle([close({includedBillingIds:['included'],includedExpenseIds:['expense']})]);
  const rows=[receipt('included',cut+100),receipt('included_cashbox',cut+100,{type:'cashbox_receipt',_receiptGroupKey:'payment:included'}),
    receipt('closing-proof',cut+200,{type:'settlement_adjustment',closureId:'close'}),
    receipt('expense',cut+300,{_receiptGroupKey:'expense:expense',method:'expense'}),
    receipt('expense',cut+400),receipt('other-proof',cut+400,{closureId:'pending-close'}),
    receipt('unknown',0)];
  assert.deepEqual(ids(currentCycleReceipts(rows,cycle)),['expense','other-proof','unknown']);
  assert.equal(receiptCycle([close({id:'old',cutoffAtMs:cut-100}),close(),close({id:'pending',status:'requested',cutoffAtMs:cut+1000})]).cutoffAtMs,cut);
});

test('render del chofer aplica período actual, paginación e historial sin modificar el armado de documentos',()=>{
  const source=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
  const start=source.indexOf('function render() {'),end=source.indexOf('\n}',start)+2;
  const nodes=new Map(),node=id=>{if(!nodes.has(id))nodes.set(id,{textContent:'',innerHTML:'',dataset:{},classList:{contains:()=>true,toggle(){}}});return nodes.get(id);};
  const rows=[receipt('old',cut-1),receipt('new',cut+1)],rendered=[];
  const context={$:node,auth:{currentUser:{uid:'driver'}},isAdminProfile:()=>false,renderDriverLoadState:()=>true,
    syncDriverDebtConfirmationModal(){},syncUberDriverConfirmationModal(){},settlementModel:()=>({balance:0}),closures:[close()],
    receiptCycle,currentCycleReceipts,receiptRecordedAtMs,buildUnifiedReceipts:()=>rows,isCashboxReceipt:()=>false,
    receiptSortOrder:'newest',receiptScope:'current',RECENT_RECEIPTS_LIMIT:1,visibleReceiptCount:1,visibleReceiptRows:(r,n)=>r.slice(0,n),
    setMoney(){},renderWalletStatus(){},settlementPreviewCopy:()=>({label:'Al día'}),renderUberPendingBadge(){},
    renderList:(_id,r)=>rendered.push(ids(r)),sortUnifiedReceipts:r=>r,recentActivitiesMarkup,money:String,
    window:{setTimeout(){}},maybeShowDriverDebtConfirmation(){},maybeShowUberDriverConfirmation(){}};
  vm.createContext(context);vm.runInContext(source.slice(start,end),context);
  context.render();assert.deepEqual(rendered.pop(),['new']);assert.equal(node('receiptCount').textContent,1);
  context.receiptScope='history';context.render();assert.deepEqual(rendered.pop(),['old']);assert.equal(node('receiptCount').textContent,2);
  assert.equal(node('receiptScopeTitle').textContent,'Historial completo');
  context.receiptScope='current';context.closures=[close({cutoffAtMs:cut+100})];context.render();
  assert.equal(node('receiptCount').textContent,0);assert.match(node('receiptList').innerHTML,/Período nuevo iniciado/);
  assert.match(node('recentActivities').innerHTML,/PERIODO NUEVO INICIADO/);
});
