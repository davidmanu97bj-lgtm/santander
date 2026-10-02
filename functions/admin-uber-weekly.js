'use strict';
const {createHash}=require('node:crypto');
const {HttpsError,onCall}=require('firebase-functions/v2/https');
const policy=require('./uber-weekly-policy');
const {eligibleUberWeek}=require('./uber-proof');
const {readInputs}=require('./period-closure');
const {calculateTeamRealtimeSettlementBalance}=require('./telegram-billing-balance');
const fail=(message,code='invalid-argument')=>{throw new HttpsError(code,message);};
const inactive=row=>row.deleted===true||row.isDeleted===true||row.eliminado===true||/reject|rechaz|cancel|anulad|deleted|eliminad/.test(String(row.reviewStatus||row.status||'').toLowerCase());
function validateInput(input={}) {
  const driverUid=String(input.driverUid||'');
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(driverUid))fail('Seleccioná un chofer válido.');
  for(const field of ['cashAmount','transferAmount','totalAmount']) {
    const value=input[field];
    if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>100000000||Math.abs(value*100-Math.round(value*100))>0.00001)
      fail('Ingresá importes conciliados no negativos, con hasta dos decimales. Un saldo digital negativo requiere conciliar la comisión antes de registrar.');
  }
  if(Math.round(input.cashAmount*100)+Math.round(input.transferAmount*100)!==Math.round(input.totalAmount*100))fail('Efectivo más digital debe coincidir con el total conciliado.');
  if(input.amountBasis!=='net_after_uber_commission'||input.cashRecipient!=='driver'||input.digitalRecipient!=='explora'||input.reconciled!==true)
    fail('Confirmá los importes netos conciliados, el efectivo del chofer y lo digital recibido por Explora.');
  const sourceReference=String(input.sourceReference||'').trim();
  if(sourceReference.length<3||sourceReference.length>300)fail('Ingresá una referencia de Fleet de entre 3 y 300 caracteres.');
  const weekStartDate=String(input.weekStartDate||''),weekCloseDate=String(input.weekCloseDate||'');
  for(const date of [weekStartDate,weekCloseDate])if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||Number.isNaN(Date.parse(date+'T12:00:00Z'))||new Date(date+'T12:00:00Z').toISOString().slice(0,10)!==date)fail('La semana no es válida.');
  if(new Date(weekStartDate+'T12:00:00Z').getUTCDay()!==1||Date.parse(weekCloseDate)-Date.parse(weekStartDate)!==7*86400000)fail('La semana debe ir de lunes a lunes, durante siete días.');
  return {driverUid,weekStartDate,weekCloseDate,cashAmount:input.cashAmount,transferAmount:input.transferAmount,totalAmount:input.totalAmount,
    amountBasis:input.amountBasis,cashRecipient:input.cashRecipient,digitalRecipient:input.digitalRecipient,reconciled:true,sourceReference};
}
async function registerAdminUberWeek({db,adminUid,input,driverAliases=[],driverName='Chofer',businessId,now=Date.now()}) {
  if(!adminUid)fail('Sólo el administrador puede registrar la semana.','permission-denied');
  const data=validateInput(input);
  const fingerprint=createHash('sha256').update(JSON.stringify(data)).digest('hex');
  const id=`uber_${data.driverUid}_${data.weekStartDate}_admin_fleet`;
  const ref=db.collection('uber_weekly_closures').doc(id);
  return db.runTransaction(async tx=>{
    const existing=await tx.get(ref);
    if(existing.exists) {
      const record=existing.data();
      if(record.inputFingerprint===fingerprint&&policy.confirmed(record)&&!inactive(record))return {id,record,alreadyRegistered:true};
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
      createdByUid:adminUid,createdByRole:'admin',approvedByUid:adminUid,driverName,operatorName:driverName,businessId,
      weekId:data.weekStartDate,weekKey:data.weekStartDate,amount:amounts.total,
      uberCashAmount:amounts.cash,uberTransferAmount:amounts.digital,digitalAmount:amounts.digital,
      cashboxRate:.10,cashboxAmount:amounts.cashbox,uberCashboxAmount:amounts.cashbox,settlementImpact:amounts.balance,
      settlementRuleVersion:policy.VERSION,settlementWorkflowVersion:policy.WORKFLOW,sourceModule:'admin_fleet_weekly',sourceProvider:'uber_fleet_manual',
      adminConfirmed:true,verifiedAutomatically:false,reviewStatus:'completed',status:'completed',locked:true,inputFingerprint:fingerprint,
      settlementBeforeAdminDecision:before,settlementAfterAdminDecision:policy.calculate(data).balance+before,
      createdAt:new Date(now),updatedAt:new Date(now),createdAtMs:now,updatedAtMs:now};
    const after=calculateTeamRealtimeSettlementBalance({...rows,uberWeeks:[...rows.uberWeeks,record]}).balance;
    record.settlementAfterAdminDecision=after;
    tx.create(ref,record);
    return {id,record,alreadyRegistered:false};
  });
}
function createAdminUberWeekFunction({db,assertAdmin,getProfile,businessId,isEligibleProfile,now=()=>Date.now()}) {
  return onCall({region:'southamerica-east1',timeoutSeconds:120,memory:'256MiB'},async request=>{
    const adminUid=await assertAdmin(request);
    const input=validateInput(request.data||{});
    const profile=await getProfile(input.driverUid);
    if(!profile?.exists)fail('El chofer no existe.','not-found');
    const data=profile.data()||{};
    if(data.deleted===true||data.isDeleted===true||data.disabled===true||data.active===false||
      /admin|administrador/.test(String(data.role||data.rol||'').toLowerCase())||
      (isEligibleProfile&&!isEligibleProfile(profile.id,data)))fail('El perfil debe corresponder a un chofer habilitado.','failed-precondition');
    const canonicalUid=String(data.authUid||data.uid||profile.id||input.driverUid);
    const driverAliases=[profile.id,data.authUid,data.uid,data.driverUid,data.driverId,data.choferUid,data.choferId,input.driverUid];
    return registerAdminUberWeek({db,adminUid,input:{...input,driverUid:canonicalUid},driverAliases,businessId,now:now(),driverName:String(data.displayName||data.nombreCompleto||data.nombre||data.name||data.username||'Chofer')});
  });
}
module.exports={registerAdminUberWeek,createAdminUberWeekFunction,validateInput};
