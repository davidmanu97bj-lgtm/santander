'use strict';
// Callable boundary: clients supply business fields, never authoritative balances.
const { FINANCIAL, OWNER_FIELDS, ownerOf, digest, VERSION, round } = require('./settlement-ledger');
const expensePolicy = require('./expense-policy');
const AMOUNT_KEYS=['amount','monto','valor','finalPrice','grossAmount'];
const SERVER_FIELDS=/^(financial(?:LedgerVersion|Sequence|EntryId|Revision|OriginVersion|OriginalSnapshot)|telegramSettlement|settlementBeforeAdminDecision|settlementAfterAdminDecision)/;

function createSettlementApi({db,ledger,onCall,HttpsError,Timestamp,FieldValue,assertAdmin,assertViewer}) {
  const fail=(code,message,details)=>{throw new HttpsError(code,message,details);};
  const validPath=path=> typeof path==='string' && path.split('/').length===2 && FINANCIAL.has(path.split('/')[0])
    && /^[^/\u0000-\u001f]{1,220}$/.test(path.split('/')[1]);
  function decode(value,depth=0) {
    if(depth>20) fail('invalid-argument','Documento demasiado anidado.');
    if(value===null || typeof value==='string' || typeof value==='boolean') return value;
    if(typeof value==='number') {if(!Number.isFinite(value))fail('invalid-argument','Número inválido.');return value;}
    if(Array.isArray(value)) return value.map(x=>decode(x,depth+1));
    if(!value || typeof value!=='object') fail('invalid-argument','Campo inválido.');
    if(value.$financialType==='serverTimestamp') return FieldValue.serverTimestamp();
    if(value.$financialType==='delete') return FieldValue.delete();
    if(value.$financialType==='timestamp' && Number.isFinite(value.milliseconds)) return Timestamp.fromMillis(value.milliseconds);
    const out={};
    for(const [key,child] of Object.entries(value)) {
      if(['__proto__','constructor','prototype'].includes(key)) fail('invalid-argument','Campo inválido.');
      out[key]=decode(child,depth+1);
    }
    return out;
  }
  const scrub=data=>Object.fromEntries(Object.entries(data).filter(([key])=>!SERVER_FIELDS.test(key)));
  function positive(value,max=100000000) {
    if(typeof value!=='number' || !Number.isFinite(value) || value<=0 || value>max || Math.abs(round(value)-value)>.000001)
      fail('invalid-argument','El importe debe ser positivo, con un máximo de dos decimales.');
    return value;
  }
  function own(data,uid,aliases=[uid]) {
    if(!aliases.includes(ownerOf(data))) fail('permission-denied','No podés modificar la cuenta de otro chofer.');
    for(const key of OWNER_FIELDS) if(data[key] && !aliases.includes(data[key])) fail('permission-denied','La identidad del movimiento no coincide.');
  }
  function assertNoEconomicOverrides(data) {
    if(data.verificationMode === 'simulation') fail('permission-denied','No se admiten movimientos simulados.');
    for(const field of ['deleted','isDeleted','eliminado','isSimulated','createdBySimulation','excludeFromCashbox','cashboxExcluded',
      'cajaChicaEliminada','ignoreCashbox','noCashbox','suppressTelegram','excludeFromBillingSettlement','internalSettlementAdjustment',
      'simulated','simulation','simulacion','isSimulation','simulationId','simulationRunId','simulationSessionId','sandbox','testOnly']) {
      if(data[field]) fail('permission-denied','No podés excluir ni anular un movimiento.');
    }
    for(const field of ['settlementAfter','settlementBefore','cutoffActive','cashboxOffsetApplied','cashboxOffsetUsed','billingOffsetAmount']) {
      if(data[field]!==undefined) fail('permission-denied','Un chofer no puede definir una base contable.');
    }
  }
  function validateDriverMutation(mutation,old,uid,aliases) {
    const collection=mutation.path.split('/')[0], data=mutation.data;
    if(old) own(old,uid,aliases);
    if(old && mutation.kind==='set' && mutation.merge!==true) fail('permission-denied','Un cambio de estado no puede reemplazar el comprobante completo.');
    if(mutation.kind==='delete') fail('permission-denied','Solo Admin puede anular movimientos.');
    if(!old) own(data,uid,aliases);
    if(old && collection==='deudas_choferes') {
      const allowed=['acknowledgedByDriver','acknowledgedAt','updatedAt'];
      if(Object.keys(data).some(key=>!allowed.includes(key)) || old.driverConfirmationRequired!==true || data.acknowledgedByDriver!==true)
        fail('permission-denied','Solo podés aceptar la deuda pendiente.');
      return;
    }
    if(old && collection==='prestamos_operativos') {
      if(Object.keys(data).some(key=>!['remainingAmount','repaidAmount','status','updatedAt'].includes(key)))
        fail('permission-denied','Solo se admite devolución de adelantos junto a un cobro digital.');
      return; // Cross-document allocation validation follows, in this transaction.
    }
    if(old) fail('permission-denied','Un comprobante confirmado no puede ser editado por el chofer.');
    assertNoEconomicOverrides(data.internalManagement === true ? {...data,internalSettlementAdjustment:false} : data);
    if(collection==='billing_records') {
      const amount=positive(data.amount);
      for(const key of AMOUNT_KEYS) if(data[key]!==undefined && data[key]!==amount) fail('invalid-argument','Los importes del cobro no coinciden.');
      if(data.internalManagement===true) {
        if(data.type!=='settlement_adjustment' || !['driver_to_explora','explora_to_driver'].includes(data.adjustmentDirection)
          || data.sourceModule!=='gestion') fail('invalid-argument','Movimiento de Gestión inválido.');
        if(typeof data.proofPath!=='string' || !data.proofPath.startsWith(`billing_receipts/${uid}/`) || !/^https:\/\//.test(data.proofUrl || ''))
          fail('invalid-argument','Falta el comprobante de Gestión.');
        Object.assign(data,{affectsBillingSettlement:true,internalSettlementAdjustment:true,status:'completed',advanceRepaymentAmount:0,advanceAllocations:[]});
      } else {
        if(!['cash','digital'].includes(data.method) || !['billing','payment'].includes(data.type) || data.adjustmentDirection
          || data.affectsBillingSettlement) fail('invalid-argument','Tipo de cobro inválido.');
        Object.assign(data,{settlementRuleVersion:'gross_cash_digital_cashbox_5_v1',grossAmount:amount,
          principalMovementAmount:data.method==='cash'?amount:-amount,cashboxRate:.05,cashboxAmount:amount*.05,
          cashboxBeneficiary:'explora',moneyHolder:data.method==='cash'?'driver':'explora',status:'completed'});
        for(const key of ['paymentMethod','metodoPago','financialCategory']) data[key]=data.method;
      }
      return;
    }
    if(collection==='gastos') {
      const amount=positive(data.amount), type=expensePolicy.find(data.expenseType);
      if(!type || data.receiptFlowVersion!==expensePolicy.version) fail('invalid-argument','Actualizá la app para registrar este gasto.');
      if(typeof data.proofPath!=='string' || !data.proofPath.startsWith(`gastos/${uid}/`) || !/^https:\/\//.test(data.proofUrl || ''))
        fail('invalid-argument','Falta el comprobante del gasto.');
      const rate=type.refundRate;
      Object.assign(data,{amount,monto:amount,tipo:type.id,category:type.id,expenseLabel:type.label,expenseResponsibility:type.group,
        reimbursementRate:rate,driverExpenseRate:1-rate,sharedRate:1-rate,porcentajeCompartido:(1-rate)*100,
        autoApplyToBilling:true,billingImpactMode:'expense_policy',billingImpactAmount:amount*(1-rate),
        telegramExpenseLoadedAmount:amount,telegramExpenseRecognizedAmount:amount*rate,
        receiptUrl:data.proofUrl,receiptPath:data.proofPath,status:'active'});
      return;
    }
    if(collection==='cierres_semanales') {
      if(data.closureMode!=='settlement_only' || data.createdByRole!=='driver' || data.reviewStatus!=='pending'
        || !['awaiting_admin_review','awaiting_admin_payment'].includes(data.status) || Number(data.paidAmountTotal)!==0)
        fail('permission-denied','El cierre necesita confirmación del administrador.');
      if(data.autoClosesCashbox || data.cashboxClosedWithBilling || data.cashboxAutoClosed
          || data.affectsTabs?.includes('caja_chica')) fail('permission-denied','El pedido no puede cerrar la caja.');
      Object.assign(data,{paidAmountTotal:0,closureMode:'settlement_only',reviewStatus:'pending',
        autoClosesCashbox:false,cashboxClosedWithBilling:false,cashboxAutoClosed:false,affectsTabs:['chofer','explora']});
      return;
    }
    if(collection==='prestamos_operativos') {
      const principal=positive(data.principalAmount,400000);
      if(data.type!=='cash_advance' || data.approvalStatus!=='pending' || data.status!=='pending_admin_approval'
        || Number(data.remainingAmount)!==0 || Number(data.repaidAmount)!==0) fail('permission-denied','El adelanto necesita aprobación del administrador.');
      Object.assign(data,{amount:principal,originalAmount:principal,interestPercent:40,interestAmount:Math.round(principal*.4),
        totalDebt:principal+Math.round(principal*.4),requestedTotalDebt:principal+Math.round(principal*.4)});
      return;
    }
    fail('permission-denied','Esta operación solo puede realizarla el servidor o Admin.');
  }

  const options={region:'southamerica-east1',timeoutSeconds:180,memory:'512MiB',maxInstances:12};
  const commit=onCall(options,async request=>{
    let admin=false,uid;
    try {uid=await assertAdmin(request);admin=true;} catch(error) {
      if(!['permission-denied','unauthenticated'].includes(error.code)) throw error;
      uid=await assertViewer(request);
    }
    const input=request.data || {};
    if(!Array.isArray(input.writes) || input.writes.length<1 || input.writes.length>40 || !Array.isArray(input.reads || []))
      fail('invalid-argument','Operación financiera inválida.');
    if(JSON.stringify(input).length>650000) fail('invalid-argument','La operación es demasiado grande.');
    const requestId=String(input.requestId || '');
    const context={actorUid:uid,requestId,requestHash:digest(input),reason:admin?String(input.reason || '').slice(0,280):''};
    const response=await ledger.runTransaction(async tx=>{
      const driverIdentity = !admin ? await ledger.identityInTransaction(tx,uid) : null;
      const original=new Map();
      const paths=new Set([...input.writes.map(w=>w.path),...(input.reads || []).map(r=>r.path)]);
      for(const path of paths) {
        if(!validPath(path)) fail('permission-denied','Colección financiera no permitida.');
        const snap=await tx.get(db.doc(path));
        if(!admin && snap.exists) own(snap.data(),uid,driverIdentity.aliases);
        original.set(path,snap);
      }
      for(const read of input.reads || []) {
        const snap=original.get(read.path),version=Number(snap.data()?.financialRevision || 0);
        if(snap.exists!==read.exists || version!==Number(read.revision || 0))
          fail('aborted','El movimiento cambió mientras lo confirmabas. Reintentando con sus datos actualizados.',{reason:'read-conflict'});
      }
      const decoded=[];
      for(const item of input.writes) {
        if(!['set','update','create','delete'].includes(item.kind)) fail('invalid-argument','Tipo de escritura inválido.');
        const old=original.get(item.path).exists?original.get(item.path).data():null;
        const data=item.kind==='delete'?null:scrub(decode(item.data || {}));
        // Retry of a stable receipt id after a lost callable response: no second
        // entry and no replacement of its confirmed snapshots.
        if(old && item.kind==='set' && item.merge!==true && data?.idempotencyKey
          && old.idempotencyKey===data.idempotencyKey && old.submissionFingerprint===data.submissionFingerprint) continue;
        const mutation={...item,data};
        if(!admin) validateDriverMutation(mutation,old,uid,driverIdentity.aliases);
        else {
          if(!old && !ownerOf(data)) fail('invalid-argument','Falta el chofer del movimiento.');
          if(item.path.startsWith('uber_weekly_closures/') && !old) fail('permission-denied','Uber debe registrarse desde su verificación del servidor.');
          if(old?.settlementWorkflowVersion==='v85_verified_direct') fail('permission-denied','Usá la acción específica de Uber para modificarlo.');
          if(old?.invoiceRequest?.version==='arca_c_v1') fail('failed-precondition','La corrección del cobro fiscal requiere revisión fiscal.');
          if(data?.amount!==undefined) positive(data.amount);
        }
        decoded.push(mutation);
      }
      if(!admin) {
        const newAdvances=decoded.filter(w=>w.path.startsWith('prestamos_operativos/') && !original.get(w.path).exists);
        if(newAdvances.length>1) fail('invalid-argument','Solo se admite una solicitud de adelanto a la vez.');
        if(newAdvances.length) {
          const snapshot=await tx.get(db.collection('prestamos_operativos').where('driverUid','==',uid));
          if(snapshot.docs.some(d=>/pending/.test(String(d.data().approvalStatus || d.data().status || ''))))
            fail('already-exists','Ya tenés una solicitud de adelanto pendiente.');
        }
        const charges=decoded.filter(w=>w.path.startsWith('billing_records/') && !original.get(w.path).exists);
        const advanceWrites=decoded.filter(w=>w.path.startsWith('prestamos_operativos/') && original.get(w.path).exists);
        if(charges.length>1) fail('invalid-argument','Confirmá un cobro por operación.');
        const digital=charges.find(w=>w.data.method==='digital' && !w.data.internalManagement);
        const allocations=digital?.data.advanceAllocations || [];
        if(!Array.isArray(allocations) || allocations.length>30) fail('invalid-argument','Devoluciones de adelanto inválidas.');
        const total=allocations.reduce((sum,a)=>sum+positive(a.amount,4000000),0);
        if(advanceWrites.length!==allocations.length || (total && (!digital || total>Math.floor(digital.data.amount*.5))))
          fail('permission-denied','La devolución del adelanto debe corresponder al cobro digital.');
        if(digital && Number(digital.data.advanceRepaymentAmount || 0)!==total) fail('invalid-argument','La devolución del adelanto no coincide.');
        const seen=new Set();
        for(const allocation of allocations) {
          if(seen.has(allocation.advanceId)) fail('invalid-argument','Adelanto duplicado.'); seen.add(allocation.advanceId);
          const path=`prestamos_operativos/${allocation.advanceId}`,change=advanceWrites.find(w=>w.path===path),old=original.get(path)?.data();
          if(!change || !old || /pending|reject|cancel/.test(String(old.status || old.approvalStatus || '')))
            fail('permission-denied','El adelanto no está aprobado.');
          const remaining=Number(old.remainingAmount || 0),paid=Number(old.repaidAmount || 0);
          if(allocation.amount>remaining || change.data.remainingAmount!==round(remaining-allocation.amount)
            || change.data.repaidAmount!==round(paid+allocation.amount)) fail('aborted','El saldo del adelanto cambió.');
          change.data.status=change.data.remainingAmount<=.5?'paid':'active';
        }
      }
      context.validateProjected=({before,rows,writes,originals,nextRows})=>{
        if(admin) return;
        for(const write of writes) {
          const next=nextRows.get(write.ref.path),old=originals.get(write.ref.path),collection=write.ref.path.split('/')[0];
          if(!old && collection==='prestamos_operativos' && Math.abs(before)>=50000)
            fail('failed-precondition','La diferencia confirmada debe ser menor a $50.000 para pedir un adelanto.');
          if(!old && collection==='cierres_semanales') {
            if(rows.closures.some(c=>/awaiting_admin|pending_admin/.test(String(c.status || ''))))
              fail('already-exists','Ya tenés un cierre pendiente.');
            const amount=Math.abs(before),direction=before>.5?'driver_to_explora':before<-.5?'explora_to_driver':'';
            if(!direction || next.paymentDirection!==direction || Math.abs(Number(next.settlementAmount)-amount)>.005
              || Math.abs(Number(next.requestedAmount)-amount)>.005)
              fail('failed-precondition','El saldo confirmado cambió. Volvé a abrir el cierre antes de enviarlo.');
            if(direction==='driver_to_explora') {positive(next.requestedPaymentAmount);if(next.requestedPaymentAmount>amount)fail('invalid-argument','El pago supera el saldo.');}
          }
        }
      };
      for(const item of decoded) {
        const ref=db.doc(item.path);
        if(item.kind==='delete') tx.delete(ref);
        else if(item.kind==='create') tx.create(ref,item.data);
        else if(item.kind==='update') tx.update(ref,item.data);
        else tx.set(ref,item.data,item.merge===true?{merge:true}:undefined);
      }
      return {ok:true};
    },context);
    // Callable payload contains only serializable account summaries (no SDK refs).
    return {ok:true,accounts:response.accounts || [],entries:response.entries || [],noop:response.noop===true};
  });
  const review=onCall(options,async request=>{
    await assertAdmin(request);
    return ledger.review(String(request.data?.driverUid || ''));
  });
  const activate=onCall(options,async request=>{
    const uid=await assertAdmin(request);
    if(request.data?.confirmReviewed!==true) fail('failed-precondition','Confirmá que revisaste el saldo inicial.');
    return ledger.activate(String(request.data?.driverUid || ''),request.data?.sourceHash,uid);
  });
  return {commit,review,activate};
}
module.exports={createSettlementApi};
