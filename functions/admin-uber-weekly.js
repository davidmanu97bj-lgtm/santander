'use strict';
const {createHash}=require('node:crypto');
const {HttpsError,onCall}=require('firebase-functions/v2/https');
const policy=require('./uber-weekly-policy');
const {eligibleUberWeek}=require('./uber-proof');
const {readInputs,WORKFLOW:PERIOD_WORKFLOW}=require('./period-closure');
const {calculateTeamRealtimeSettlementBalance}=require('./telegram-billing-balance');
const fail=(message,code='invalid-argument')=>{throw new HttpsError(code,message);};
const inactive=row=>row.deleted===true||row.isDeleted===true||row.eliminado===true||/reject|rechaz|cancel|anulad|deleted|eliminad/.test(String(row.reviewStatus||row.status||'').toLowerCase());
function validateInput(input={}, {allowUndeclaredReconciliation=false}={}) {
  const driverUid=String(input.driverUid||'');
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(driverUid))fail('Seleccioná un chofer válido.');
  for(const field of ['cashAmount','transferAmount','totalAmount']) {
    const value=input[field];
    if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>100000000||Math.abs(value*100-Math.round(value*100))>0.00001)
      fail('Ingresá importes conciliados no negativos, con hasta dos decimales. Un saldo digital negativo requiere conciliar la comisión antes de registrar.');
  }
  if(Math.round(input.cashAmount*100)+Math.round(input.transferAmount*100)!==Math.round(input.totalAmount*100))fail('Efectivo más digital debe coincidir con el total conciliado.');
  if(input.amountBasis!=='net_after_uber_commission'||input.cashRecipient!=='driver'||input.digitalRecipient!=='explora'||
    (input.reconciled!==true&&!(allowUndeclaredReconciliation&&input.reconciled===undefined)))
    fail('Confirmá los importes netos conciliados, el efectivo del chofer y lo digital recibido por Explora.');
  const sourceReference=String(input.sourceReference||'').trim();
  if(sourceReference.length<3||sourceReference.length>300)fail('Ingresá una referencia de Fleet de entre 3 y 300 caracteres.');
  const weekStartDate=String(input.weekStartDate||''),weekCloseDate=String(input.weekCloseDate||'');
  for(const date of [weekStartDate,weekCloseDate])if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||Number.isNaN(Date.parse(date+'T12:00:00Z'))||new Date(date+'T12:00:00Z').toISOString().slice(0,10)!==date)fail('La semana no es válida.');
  if(new Date(weekStartDate+'T12:00:00Z').getUTCDay()!==1||Date.parse(weekCloseDate)-Date.parse(weekStartDate)!==7*86400000)fail('La semana debe ir de lunes a lunes, durante siete días.');
  return {driverUid,weekStartDate,weekCloseDate,cashAmount:input.cashAmount,transferAmount:input.transferAmount,totalAmount:input.totalAmount,
    amountBasis:input.amountBasis,cashRecipient:input.cashRecipient,digitalRecipient:input.digitalRecipient,reconciled:input.reconciled===true,sourceReference};
}
// The short admin form declares two amounts. The server supplies custody and
// week metadata; it never treats a missing reconciliation checkbox as consent.
function normalizeAdminInput(input={},now=Date.now()) {
  const eligible=eligibleUberWeek(new Date(now));
  const cashAmount=input.cashAmount,transferAmount=input.transferAmount;
  const totalAmount=(Math.round(cashAmount*100)+Math.round(transferAmount*100))/100;
  const data=validateInput({...input,cashAmount,transferAmount,
    totalAmount:input.totalAmount===undefined?totalAmount:input.totalAmount,
    weekStartDate:input.weekStartDate===undefined?eligible?.start:input.weekStartDate,
    weekCloseDate:input.weekCloseDate===undefined?eligible?.close:input.weekCloseDate,
    amountBasis:input.amountBasis===undefined?'net_after_uber_commission':input.amountBasis,
    cashRecipient:input.cashRecipient===undefined?'driver':input.cashRecipient,
    digitalRecipient:input.digitalRecipient===undefined?'explora':input.digitalRecipient,
    sourceReference:input.sourceReference===undefined?'Carga manual del administrador':input.sourceReference},{allowUndeclaredReconciliation:true});
  return {...data,totalAmount};
}
const awaitingDriver=record=>policy.isNew(record)&&record.settlementWorkflowVersion===policy.WORKFLOW&&
  record.adminConfirmed===true&&record.driverConfirmationRequired===true&&record.driverConfirmed!==true&&
  record.reviewStatus==='awaiting_driver_confirmation'&&!inactive(record);
async function registerAdminUberWeek({db,adminUid,input,driverAliases=[],driverName='Chofer',businessId,now=Date.now()}) {
  if(!adminUid)fail('Sólo el administrador puede registrar la semana.','permission-denied');
  const data=normalizeAdminInput(input,now);
  const fingerprint=createHash('sha256').update(JSON.stringify(data)).digest('hex');
  const id=`uber_${data.driverUid}_${data.weekStartDate}_admin_fleet`;
  const ref=db.collection('uber_weekly_closures').doc(id);
  return db.runTransaction(async tx=>{
    const existing=await tx.get(ref);
    if(existing.exists) {
      const record=existing.data();
      if(record.inputFingerprint===fingerprint&&(policy.confirmed(record)||awaitingDriver(record))&&!inactive(record))return {id,record,alreadyRegistered:true};
      fail('Esta semana ya tiene un cierre. No se modifica ni se vuelve a contabilizar.','already-exists');
    }
    const eligible=eligibleUberWeek(new Date(now));
    if(!eligible||data.weekStartDate!==eligible.start||data.weekCloseDate!==eligible.close)fail('Sólo se puede registrar la semana pendiente habilitada.','failed-precondition');
    const rows=await readInputs(db,tx,data.driverUid);
    // Aliases come from the server-resolved driver profile, never from request data.
    const aliases=[...new Set([data.driverUid,...driverAliases])].filter(alias=>typeof alias==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(alias));
    const queries=[];
    for(const alias of aliases)for(const field of ['driverUid','choferUid','uid','ownerUid','driverId','choferId','userUid','operatorUid']) {
      if(alias===data.driverUid&&field!=='operatorUid')continue; // Already read by readInputs.
      queries.push(tx.get(db.collection('uber_weekly_closures').where(field,'==',alias)));
    }
    const aliasWeeks=(await Promise.all(queries)).flatMap(snapshot=>snapshot.docs.map(doc=>doc.data()));
    if([...rows.uberWeeks,...aliasWeeks].some(row=>!inactive(row)&&(row.weekStartDate===data.weekStartDate||row.weekCloseDate===data.weekCloseDate||row.weekId===data.weekStartDate||row.weekKey===data.weekStartDate)))
      fail('Esta semana ya fue cargada o tiene un cierre pendiente. Conservamos el registro anterior.','already-exists');
    const amounts=policy.calculate(data),model=calculateTeamRealtimeSettlementBalance(rows),before=model.balance;
    if(now<=model.effectiveCutoffMs)fail('El período fue cerrado o ajustado. Actualizá los saldos antes de registrar.','failed-precondition');
    const record={...data,closureId:id,choferUid:data.driverUid,uid:data.driverUid,driverId:data.driverUid,operatorUid:data.driverUid,
      createdByUid:adminUid,createdByRole:'admin',approvedByUid:adminUid,driverName,operatorName:driverName,...(businessId?{businessId}:{}),
      weekId:data.weekStartDate,weekKey:data.weekStartDate,amount:amounts.total,
      uberCashAmount:amounts.cash,uberTransferAmount:amounts.digital,digitalAmount:amounts.digital,
      cashboxRate:.10,cashboxAmount:amounts.cashbox,uberCashboxAmount:amounts.cashbox,settlementImpact:amounts.balance,
      settlementRuleVersion:policy.VERSION,settlementWorkflowVersion:policy.WORKFLOW,sourceModule:'admin_fleet_weekly',sourceProvider:'uber_fleet_manual',
      adminConfirmed:true,driverConfirmationRequired:true,driverConfirmed:false,verifiedAutomatically:false,
      reviewStatus:'awaiting_driver_confirmation',status:'awaiting_driver_confirmation',locked:true,inputFingerprint:fingerprint,
      settlementBeforeAdminDecision:before,settlementAfterAdminDecision:before,
      projectedSettlementAfterBalance:policy.roundMoney(before+amounts.balance),
      registeredAt:new Date(now),registeredAtMs:now,
      createdAt:new Date(now),updatedAt:new Date(now),createdAtMs:now,updatedAtMs:now};
    tx.create(ref,record);
    return {id,record,alreadyRegistered:false};
  });
}
async function confirmAdminUberWeek({db,driverUid,input={},now=Date.now()}) {
  if(!driverUid)fail('Iniciá sesión para aceptar el cierre.','unauthenticated');
  const id=String(input.closureId||'');
  if(!/^[A-Za-z0-9_-]{1,220}$/.test(id))fail('El cierre de Uber no es válido.');
  const ref=db.collection('uber_weekly_closures').doc(id);
  return db.runTransaction(async tx=>{
    const snapshot=await tx.get(ref);
    if(!snapshot.exists)fail('El cierre de Uber no existe.','not-found');
    const record=snapshot.data();
    if(record.driverUid!==driverUid)fail('Este cierre no pertenece a tu cuenta.','permission-denied');
    if(record.driverConfirmationRequired!==true||!policy.isNew(record)||record.settlementWorkflowVersion!==policy.WORKFLOW)
      fail('Este cierre conserva su confirmación anterior.','failed-precondition');
    if(policy.confirmed(record)&&record.driverConfirmed===true&&!inactive(record))
      return {id,record,alreadyConfirmed:true,balance:record.telegramSettlementAfterBalance};
    if(!awaitingDriver(record)||record.isSimulated===true||record.createdBySimulation===true||record.verificationMode==='simulation')
      fail('Este cierre ya no está pendiente de tu aceptación.','failed-precondition');
    const rows=await readInputs(db,tx,driverUid);
    const model=calculateTeamRealtimeSettlementBalance(rows);
    const cutoff=Math.max(model.effectiveCutoffMs||0,...rows.closures.filter(row=>row.closureWorkflowVersion===PERIOD_WORKFLOW&&row.status==='completed').map(row=>Number(row.createdAtMs)||row.createdAt?.toMillis?.()||0));
    if(now<cutoff)fail('El período fue ajustado. Actualizá los saldos y volvé a aceptar.','failed-precondition');
    const effectiveAtMs=Math.max(now,cutoff+1);
    // createdAt is the effective ledger timestamp in older clients. Keep the
    // original registration separately so accepting after an anchor is included.
    const update={driverConfirmed:true,driverConfirmedByUid:driverUid,
      driverConfirmedAt:new Date(now),driverConfirmedAtMs:now,reviewStatus:'completed',status:'completed',
      registeredAt:record.registeredAt||record.createdAt||new Date(record.createdAtMs||now),
      registeredAtMs:Number(record.registeredAtMs||record.createdAtMs||now),
      createdAt:new Date(effectiveAtMs),createdAtMs:effectiveAtMs,completedAt:new Date(effectiveAtMs),completedAtMs:effectiveAtMs,updatedAt:new Date(effectiveAtMs),updatedAtMs:effectiveAtMs,
      settlementBeforeConfirmation:model.balance,telegramSettlementBeforeBalance:model.balance};
    const completed={...record,...update};
    const after=calculateTeamRealtimeSettlementBalance({...rows,uberWeeks:rows.uberWeeks.map(row=>row.id===id?{...completed,id}:row)}).balance;
    Object.assign(update,{settlementAfterConfirmation:after,settlementAfterAdminDecision:after,
      telegramSettlementAfterBalance:after,telegramSettlementPayer:after>.5?'driver':after<-.5?'explora':'balanced'});
    tx.update(ref,update);
    return {id,record:{...record,...update},alreadyConfirmed:false,balance:after};
  });
}
function createAdminUberWeekFunction({db,assertAdmin,getProfile,businessId,isEligibleProfile,now=()=>Date.now()}) {
  return onCall({region:'southamerica-east1',timeoutSeconds:120,memory:'256MiB'},async request=>{
    const adminUid=await assertAdmin(request);
    const nowMs=now();
    const input=normalizeAdminInput(request.data||{},nowMs);
    const profile=await getProfile(input.driverUid);
    if(!profile?.exists)fail('El chofer no existe.','not-found');
    const data=profile.data()||{};
    if(data.deleted===true||data.isDeleted===true||data.disabled===true||data.active===false||
      /admin|administrador/.test(String(data.role||data.rol||'').toLowerCase())||
      (isEligibleProfile&&!isEligibleProfile(profile.id,data)))fail('El perfil debe corresponder a un chofer habilitado.','failed-precondition');
    const canonicalUid=String(data.authUid||data.uid||profile.id||input.driverUid);
    const driverAliases=[profile.id,data.authUid,data.uid,data.driverUid,data.driverId,data.choferUid,data.choferId,input.driverUid];
    return registerAdminUberWeek({db,adminUid,input:{...request.data,driverUid:canonicalUid},driverAliases,businessId,now:nowMs,driverName:String(data.displayName||data.nombreCompleto||data.nombre||data.name||data.username||'Chofer')});
  });
}
function createDriverConfirmAdminUberWeekFunction({db,assertViewer,now=()=>Date.now()}) {
  return onCall({region:'southamerica-east1',timeoutSeconds:120,memory:'256MiB'},async request=>{
    const driverUid=await assertViewer(request);
    return confirmAdminUberWeek({db,driverUid,input:request.data||{},now:now()});
  });
}
function adminUberConfirmationTelegramText(record={}) {
  const clean=value=>String(value||'').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim();
  const money=value=>new Intl.NumberFormat('es-AR',{style:'currency',currency:'ARS',minimumFractionDigits:0,maximumFractionDigits:2}).format(Number(value)||0);
  const amounts=policy.calculate(record),balance=Number(record.telegramSettlementAfterBalance)||0;
  const acceptedAt=Number(record.driverConfirmedAtMs||0);
  return ['🚘 Uber aceptado por el chofer',`Chofer: ${clean(record.driverName||record.operatorName||'Chofer')}`,
    `Semana: ${clean(record.weekStartDate)} al ${clean(record.weekCloseDate)}`,'',
    `Efectivo: ${money(amounts.cash)}`,`Digital: ${money(amounts.digital)}`,
    `Total Uber: ${money(amounts.total)}`,`Caja chica 10%: ${money(amounts.cashbox)}`,'',
    balance>.5?`Estado: Chofer debe ${money(balance)}`:balance<-.5?`Estado: Explora debe ${money(-balance)}`:'Estado: Equilibrado',
    ...(acceptedAt>0?[`Aceptado: ${new Intl.DateTimeFormat('es-AR',{timeZone:'America/Argentina/Buenos_Aires',dateStyle:'short',timeStyle:'short'}).format(new Date(acceptedAt))}`]:[])].join('\n');
}
module.exports={registerAdminUberWeek,confirmAdminUberWeek,createAdminUberWeekFunction,createDriverConfirmAdminUberWeekFunction,validateInput,normalizeAdminInput,adminUberConfirmationTelegramText};
