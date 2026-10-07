import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Exercise the shipped functions, not reimplementations of the ownership rules.
const source=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
function shippedFunction(name) {
  let start=source.indexOf(`function ${name}(`);
  assert.ok(start>=0,`${name} exists in app.js`);
  if(source.slice(start-6,start)==='async ')start-=6;
  const end=source.indexOf('\n}',start);
  assert.ok(end>start,`${name} has a body`);
  return source.slice(start,end+2);
}
const functionNames=['adminDriverLabel','adminDriverIsActive','adminDriverIsAdministrator',
  'adminDriverIdentitySet','adminRecordIdentityValues','adminRecordBelongsToDriver',
  'adminScopedRecordOwner','adminScopedRecordBelongsToDriver','adminClosurePaymentUid','adminDriverById',
  'lockAdminDriverSelection','driverFromAdminControl','adminReceiptWaiver',
  'adminWorkspaceState','adminOpenDebtItemsForDriver','closureRemaining',
  'closureDriverPaymentMethod','normalizeClosureRecord','approveDriverClosurePayment'];
const profiles=()=>[
  {id:'profile-a',uid:'auth-a',authUid:'auth-a',nombre:'Javier Allende',active:true},
  {id:'profile-b',uid:'auth-b',authUid:'auth-b',nombre:'Ramiro Sotar',active:true},
  {id:'admin',uid:'admin',role:'admin',nombre:'Administrador',active:true}
];
function fixture(drivers=profiles()) {
  const controls=new Map();
  const context={
    adminDrivers:drivers,EXPLORA_ADMIN_UIDS:new Set(['admin']),
    auth:{currentUser:{uid:'admin'}},adminAllowed:true,
    $:id=>controls.get(id),serverTimestamp:()=>({serverTimestamp:true}),
    dashboardLoad:{complete:()=>true,errors:new Set()},
    adminPayments:[],adminExpenses:[],adminDebts:[],adminDebtPayments:[],
    adminUberClosures:[],adminAllClosures:[],
    movementIsDeleted:r=>Boolean(r.deleted),isSettlementAdjustment:r=>r.type==='settlement_adjustment',
    isReimbursementCompensation:()=>false,recordTimestampMs:r=>r.createdAtMs||0,
    recordProofUrl:r=>r.proofUrl||'',recordProofPath:r=>r.proofPath||'',recordDayKey:r=>r.dayKey||'2026-10-07',
    debtImpactsSettlement:r=>r.type==='admin_debt',classifyRecordedCharge:()=>({label:'Viaje'}),
    adminBillingBalanceForDriver:d=>d.id==='profile-a'?12345:0
  };
  context.isAdminProfile=()=>context.adminAllowed;
  vm.createContext(context);
  vm.runInContext(functionNames.map(shippedFunction).join('\n'),context);
  return {context,controls};
}

function closureFixture(row,{current=row}={}) {
  const f=fixture(),c=f.context,records=new Map([['cierres/'+row.id,structuredClone(current)]]);
  let nextId=0,queue=Promise.resolve();
  Object.assign(c,{
    db:{},ROOT_COLLECTIONS:{closures:'cierres',payments:'cobros'},
    collection:(_,name)=>({path:name}),
    doc:(parent,collection,id)=>({path:collection?`${collection}/${id}`:`${parent.path}/generated-${++nextId}`}),
    currentProfile:{displayName:'Administrador'},BUSINESS_ID:'test-only',
    localDayKey:()=> '2026-10-07',currentWeeklyPeriodId:()=> 'qa-week',
    parseMoneyInput:Number,money:String,deleteField:()=>null,
    setTimeout:()=>0,console:{error(){}},renderAdminClosures(){},
    adminDismissedPendingActionIds:new Set(),adminPendingAction:null,
    selectedAdminClosureId:row.id,adminClosureScopeUid:'profile-a',closures:[structuredClone(row)]
  });
  c.runTransaction=(_,callback)=>{
    const execute=async()=>{
      const writes=[];
      const result=await callback({
        get:async ref=>({exists:()=>records.has(ref.path),data:()=>structuredClone(records.get(ref.path))}),
        set:(ref,data)=>writes.push({path:ref.path,data}),update:(ref,data)=>writes.push({path:ref.path,data,merge:true})
      });
      for(const write of writes)records.set(write.path,write.merge?{...records.get(write.path),...write.data}:write.data);
      return result;
    };
    const result=queue.then(execute,execute);queue=result.catch(()=>{});return result;
  };
  for(const id of ['adminPaymentForm','confirmAdminPayment','adminPaymentAmount','adminCloseNoReceipt','adminCloseProof','adminPaymentStatus'])
    f.controls.set(id,{value:id==='adminPaymentAmount'?'1000':'',checked:id==='adminCloseNoReceipt',disabled:false,textContent:'',className:'',files:[],addEventListener:(_event,callback)=>{c.paymentSubmit=callback;}});
  const start=source.indexOf('$("adminPaymentForm")?.addEventListener("submit", async event => {');
  assert.ok(start>=0);const end=source.indexOf('\n});',start)+4;
  vm.runInContext(source.slice(start,end),c);
  return {...f,records};
}

test('el driverUid explícito prevalece frente a otro UID o creador del registro',()=>{
  const {context:c}=fixture();
  const row={driverUid:'auth-b',uid:'auth-a',ownerUid:'auth-a',createdByUid:'admin',driverName:'Javier Allende'};
  assert.equal(c.adminScopedRecordOwner(row).id,'profile-b');
  assert.equal(c.adminScopedRecordBelongsToDriver(row,c.adminDrivers[0]),false);
  assert.equal(c.adminScopedRecordBelongsToDriver(row,c.adminDrivers[1]),true);
  assert.equal(c.adminScopedRecordOwner({driverUid:'unknown',uid:'auth-a'}),null,'No fallback if authoritative UID is unknown');
  assert.equal(c.adminScopedRecordOwner({createdByUid:'auth-a'}),null,'The creator is not the driver owner');
});

test('resuelve alias históricos inequívocos y omite los conflictos sin driverUid',()=>{
  const {context:c}=fixture();
  assert.equal(c.adminScopedRecordOwner({operatorUid:'auth-a'}).id,'profile-a');
  assert.equal(c.adminScopedRecordOwner({choferId:'profile-b'}).id,'profile-b');
  assert.equal(c.adminScopedRecordOwner({uid:'auth-a',operatorUid:'auth-b'}),null);
  assert.equal(c.adminScopedRecordOwner({driverUid:'admin',operatorUid:'auth-a'}),null,'Administrator is not assigned as a driver');
  assert.equal(c.adminScopedRecordOwner({operatorName:'Javier Allende'}).id,'profile-a');
});

test('no mezcla homónimos ni asigna un alias duplicado a la primera tarjeta',()=>{
  const drivers=profiles();drivers[1].nombre='Javier Allende';
  const {context:c}=fixture(drivers);
  assert.equal(c.adminScopedRecordOwner({operatorName:'Javier Allende'}),null);
  assert.equal(c.adminScopedRecordOwner({driverUid:'auth-b',operatorName:'Javier Allende'}).id,'profile-b');
  c.adminDrivers[1].authUid='auth-a';
  assert.equal(c.adminScopedRecordOwner({driverUid:'auth-a'}),null);
});

test('el pago de cierre rechaza operador contradictorio o propietario incompleto',()=>{
  const {context:c}=fixture();
  assert.equal(c.adminClosurePaymentUid({driverUid:'auth-a',operatorUid:'auth-a'}),'auth-a');
  assert.equal(c.adminClosurePaymentUid({operatorUid:'profile-a'}),'profile-a','Preserves an existing owner identifier');
  assert.equal(c.adminClosurePaymentUid({driverUid:'auth-a',operatorUid:'profile-a'}),'profile-a','Equivalent aliases belong to one profile');
  for(const row of [{driverUid:'auth-a',operatorUid:'auth-b'},{driverUid:'missing',operatorUid:'auth-a'},{operatorName:'Javier Allende'},{}])
    assert.throws(()=>c.adminClosurePaymentUid(row),/contradictorios o incompletos/);
});

test('selección de deudas para cancelar no incluye un UID contradictorio',()=>{
  const {context:c}=fixture();
  c.adminDebts=[
    {id:'correct',driverUid:'auth-a',type:'admin_debt',amount:300,createdAtMs:10},
    {id:'foreign',driverUid:'auth-b',uid:'auth-a',type:'admin_debt',amount:700,createdAtMs:1},
    {id:'ambiguous',uid:'auth-a',operatorUid:'auth-b',type:'admin_debt',amount:800,createdAtMs:2}
  ];
  assert.deepEqual(Array.from(c.adminOpenDebtItemsForDriver(c.adminDrivers[0]),r=>r.id),['correct']);
});

test('confirmar entrega lee propietario actual en la transacción y evita duplicados',async()=>{
  const row={id:'driver-pay',driverUid:'auth-a',operatorUid:'auth-a',status:'awaiting_admin_review',settlementAmount:1500,requestedPaymentAmount:1000,paymentMethod:'cash'};
  const {context:c,records}=closureFixture(row);
  const results=await Promise.allSettled([c.approveDriverClosurePayment(row),c.approveDriverClosurePayment(row)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);
  const payments=[...records].filter(([p])=>p.startsWith('cobros/'));
  assert.equal(payments.length,1);assert.equal(payments[0][1].driverUid,'auth-a');assert.equal(payments[0][1].amount,1000);
  assert.equal(records.get('cierres/driver-pay').remainingAmount,500);
  const changed=closureFixture(row,{current:{...row,driverUid:'auth-b',operatorUid:'auth-b'}});
  await assert.rejects(changed.context.approveDriverClosurePayment(row),/chofer del cierre cambió/);
  assert.equal(changed.records.size,1);
  const inconsistent=closureFixture(row,{current:{...row,operatorUid:'auth-b'}});
  await assert.rejects(inconsistent.context.approveDriverClosurePayment(row),/contradictorios/);
  assert.equal(inconsistent.records.size,1);
});

test('pago administrativo sin comprobante lee saldo actual y preserva al otro chofer',async()=>{
  const row={id:'admin-pay',driverUid:'auth-a',operatorUid:'auth-a',status:'requested',direction:'explora_pays_driver',settlementAmount:1500,paidAmountTotal:0,remainingAmount:1500};
  const {context:c,records}=closureFixture(row);
  const other={id:'other',driverUid:'auth-b',remainingAmount:5000};records.set('cierres/other',other);
  await c.paymentSubmit({preventDefault(){}});
  const payments=[...records].filter(([p])=>p.startsWith('cobros/'));
  assert.equal(payments.length,1);const payment=payments[0][1];
  assert.equal(payment.driverUid,'auth-a');assert.equal(payment.amount,1000);assert.equal(payment.receiptWaived,true);
  assert.equal(payment.type,'settlement_adjustment');assert.equal(payment.receiptWaivedByUid,'admin');
  assert.equal(records.get('cierres/admin-pay').remainingAmount,500);assert.equal(records.get('cierres/admin-pay').paidAmountTotal,1000);
  assert.deepEqual(records.get('cierres/other'),other);
  // Retrying with the stale visible amount is refused against current remaining balance.
  await c.paymentSubmit({preventDefault(){}});assert.equal([...records.keys()].filter(p=>p.startsWith('cobros/')).length,1);
});

test('pago administrativo falla sin escribir si propietario o importe cambia al confirmar',async()=>{
  const row={id:'admin-pay',driverUid:'auth-a',operatorUid:'auth-a',status:'requested',direction:'explora_pays_driver',settlementAmount:1500,paidAmountTotal:0,remainingAmount:1500};
  for(const current of [
    {...row,driverUid:'auth-b',operatorUid:'auth-b'},
    {...row,operatorUid:'auth-b'},
    {...row,remainingAmount:700,paidAmountTotal:800},
    {...row,status:'completed',remainingAmount:0,paidAmountTotal:1500}
  ]) {
    const f=closureFixture(row,{current});await f.context.paymentSubmit({preventDefault(){}});
    assert.equal(f.records.size,1);assert.deepEqual(f.records.get('cierres/admin-pay'),current);
    assert.match(f.controls.get('adminPaymentStatus').textContent,/No se pudo|contradictorios/);
  }
});

test('bloquea el chofer del formulario y rechaza un cambio de valor fuera de la tarjeta',()=>{
  const {context:c,controls}=fixture();
  const control={value:'profile-b',dataset:{},disabled:false};controls.set('driver',control);
  c.lockAdminDriverSelection('driver','profile-a');
  assert.equal(control.value,'profile-a');assert.equal(control.dataset.driverScope,'profile-a');assert.equal(control.disabled,true);
  assert.equal(c.driverFromAdminControl('driver').id,'profile-a');
  control.value='profile-b';assert.equal(c.driverFromAdminControl('driver'),null);
  control.value='__all__';assert.equal(c.driverFromAdminControl('driver'),null);
  control.value='profile-a';c.adminDrivers=c.adminDrivers.filter(d=>d.id!=='profile-a');
  assert.equal(c.driverFromAdminControl('driver'),null,'Deleted driver cannot silently become first selectable driver');
  assert.throws(()=>c.lockAdminDriverSelection('driver','profile-a'),/disponible/);
});

test('libera el contexto al abrir un selector general y tolera controles retirados',()=>{
  const {context:c,controls}=fixture();
  controls.set('driver',{value:'profile-a',dataset:{driverScope:'profile-a'},disabled:true});
  c.lockAdminDriverSelection('driver');
  assert.equal(controls.get('driver').dataset.driverScope,'');assert.equal(controls.get('driver').disabled,false);
  controls.get('driver').value='profile-b';assert.equal(c.driverFromAdminControl('driver').id,'profile-b');
  assert.equal(c.driverFromAdminControl('missing'),null);
  assert.doesNotThrow(()=>c.lockAdminDriverSelection('missing','profile-a'));
});

test('sin comprobante registra al administrador autenticado y una fecha separada',()=>{
  const {context:c}=fixture();
  const result=c.adminReceiptWaiver({uid:'admin'},1234567);
  assert.equal(result.receiptStatus,'waived_by_admin');assert.equal(result.receiptRequired,false);assert.equal(result.receiptWaived,true);
  assert.equal(result.receiptWaivedByUid,'admin');assert.equal(result.receiptWaivedByRole,'admin');
  assert.equal(result.receiptWaivedAtMs,1234567);assert.equal(result.receiptWaivedAt.serverTimestamp,true);
  assert.ok(!('proofUrl' in result),'Does not invent a receipt');
});

test('sin comprobante rechaza una sesión cerrada, distinta o no administrativa',()=>{
  const {context:c}=fixture();
  for(const actor of [null,{}, {uid:'other'}]) assert.throws(()=>c.adminReceiptWaiver(actor),/administración/);
  c.auth.currentUser=null;assert.throws(()=>c.adminReceiptWaiver({uid:'admin'}),/administración/);
  c.auth.currentUser={uid:'auth-a'};c.adminAllowed=false;
  assert.throws(()=>c.adminReceiptWaiver({uid:'auth-a',role:'admin'}),/administración/,'Role claimed by the caller is insufficient');
});

test('el mapa de la vista conserva fuentes y saldos y asigna un único propietario',()=>{
  const {context:c}=fixture();
  c.adminPayments=[
    Object.freeze({id:'explicit',driverUid:'auth-b',uid:'auth-a',amount:100,method:'cash',createdAtMs:1000,detail:'Explícito'}),
    Object.freeze({id:'ambiguous',uid:'auth-a',operatorUid:'auth-b',amount:200,method:'digital',createdAtMs:2000}),
    Object.freeze({id:'legacy',operatorUid:'auth-a',amount:300,method:'cash',createdAtMs:3000})
  ];
  const before=JSON.stringify(c.adminPayments),driversBefore=JSON.stringify(c.adminDrivers);
  const view=c.adminWorkspaceState();
  assert.equal(view.accounts.length,2);assert.equal(view.accounts.find(d=>d.uid==='profile-a').balance,12345);
  assert.equal(view.movements.find(r=>r.id==='explicit').driverUid,'profile-b');
  assert.equal(view.movements.find(r=>r.id==='ambiguous').driverUid,'');
  assert.equal(view.movements.find(r=>r.id==='legacy').driverUid,'profile-a');
  assert.equal(JSON.stringify(c.adminPayments),before);assert.equal(JSON.stringify(c.adminDrivers),driversBefore);
  c.auth.currentUser=null;assert.equal(c.adminWorkspaceState().movements.length,0);
});
