"use strict";
const {randomUUID}=require('node:crypto');
const {buildInvoice,matchesAuthorized,authorizationFromResponse}=require('./arca-invoice');
const {configuredInvoiceType,generalPolicyReady,internationalBEnabled,invoiceTypeOf,pointMatches}=require('./arca-policy');
const LEASE_MS=180000;
const JOBS='arca_invoices',SERIES='arca_series';
function enabled(config) {
  return config?.enabled===true && ['homologation','production'].includes(config.environment) &&
    (config.regime==='monotributo'||generalPolicyReady(config)) && config.exclusivePointOfSale===true &&
    (config.environment!=='production'||(config.homologationPassed===true&&config.registrationVerified===true&&
      (config.regime!=='general'||config.generalHomologationPassed===true)));
}
const seriesKey=c=>`${c.environment}_${c.cuit}_${Number(c.pointOfSale)}_${configuredInvoiceType(c)}`;
async function enqueueInvoice(db,id,config,now=Date.now()) {
  const jobRef=db.collection(JOBS).doc(id),paymentRef=db.collection('billing_records').doc(id);
  await db.runTransaction(async tx=>{
    const [existing,source]=await Promise.all([tx.get(jobRef),tx.get(paymentRef)]);
    if(existing.exists||!source.exists)return;
    const payment=source.data(),invoice=buildInvoice(payment,config,new Date(now));if(!invoice)return;
    const created=payment.createdAt?.toMillis?.();
    const cutoff=Date.parse(config.activeFrom||'');
    const active=enabled(config)&&Number.isFinite(created)&&Number.isFinite(cutoff)&&created>=cutoff;
    const status=!active?'disabled':invoice.issues.length?'review':'queued';
    tx.create(jobRef,{...invoice,paymentId:id,driverUid:String(payment.driverUid||''),status,createdAtMs:now,updatedAtMs:now,number:null,cae:null,caeExpires:null,seriesKey:seriesKey(config),leaseUntil:0});
  });
}
async function processInvoice({db,id,config,client,now=()=>Date.now()}) {
  if(!enabled(config))return;
  const ref=db.collection(JOBS).doc(id),series=db.collection(SERIES).doc(seriesKey(config));
  const owner=randomUUID();
  const job=await db.runTransaction(async tx=>{
    const [snap,s]=await Promise.all([tx.get(ref),tx.get(series)]);
    if(!snap.exists)return null;const j=snap.data(),lock=s.data()||{};
    if(!['queued','reserved','sent','uncertain'].includes(j.status)||j.seriesKey!==series.id||j.environment!==config.environment||j.leaseUntil>now())return null;
    if(invoiceTypeOf(j)!==configuredInvoiceType(config)||Number(j.issuer?.pointOfSale)!==Number(config.pointOfSale)||String(j.issuer?.cuit)!==String(config.cuit))return null;
    if(config.regime==='general'&&(j.issuerRegime!=='general'||j.taxPolicy!==config.taxPolicy||j.issues?.length))return null;
    if(config.regime==='general'&&!config.approvedDriverUids.includes(j.driverUid))return null;
    if(config.regime==='general'&&j.scope==='international'&&(!internationalBEnabled(config,new Date(now()))||j.internationalTaxPolicy!==config.internationalTaxPolicy))return null;
    // An uncertain request blocks this entire point/type series until reconciled.
    if(lock.activeId&&lock.activeId!==id)return null;
    tx.set(series,{activeId:id},{merge:true});
    tx.update(ref,{owner,leaseUntil:now()+LEASE_MS,updatedAtMs:now()});return j;
  });
  if(!job)return;
  const type=invoiceTypeOf(job);
  async function update(data,release=false) {
    return db.runTransaction(async tx=>{
      const [snap,s]=await Promise.all([tx.get(ref),tx.get(series)]);
      if(snap.data()?.owner!==owner||s.data()?.activeId!==id)return false;
      tx.update(ref,{...data,updatedAtMs:now()});if(release)tx.set(series,{activeId:null},{merge:true});return true;
    });
  }
  async function finish(result) { await update({...result,leaseUntil:0},true); }
  try {
    if(job.status==='sent'||job.status==='uncertain') {
      const record=await client.consult(job.issuer.pointOfSale,job.number,type);
      if(record&&matchesAuthorized(record,job.detail,job.issuer.pointOfSale,type))await finish({status:'authorized',cae:String(record.CodAutorizacion),caeExpires:String(record.FchVto),reconciled:true});
      else await update({status:'uncertain',issue:record?'number_conflict':'awaiting_reconciliation',leaseUntil:0});
      return; // Never send again after an ambiguous response, even if ARCA currently returns not found.
    }
    let points;
    try { points=await client.points(); }
    catch(error) {
      // Homologation returned 602 without a point list while authorizing C successfully.
      // This exception is specific to testing and never relaxes production validation.
      if(type===11&&config.environment==='homologation'&&error.code==='ARCA_REJECTED_REQUEST'&&error.details?.length===1&&error.details[0].code==='602')points=null;
      else throw error;
    }
    if(points!==null&&!points.some(p=>pointMatches(p,config))) {
      await finish({status:'review',issue:'point_of_sale_unavailable'});return;
    }
    const number=await client.last(job.issuer.pointOfSale,type)+1;
    if(!Number.isSafeInteger(number)||number>99999999)throw new Error('ARCA_INVALID_NUMBER');
    const detail={...job.detail,CbteDesde:number,CbteHasta:number};
    // Freeze numbering BEFORE sending. A crashed process resumes by consulting that number.
    if(!await update({status:'sent',detail,number,sentAtMs:now()}))return;
    job.status='sent';
    const result=authorizationFromResponse(await client.authorize(job.issuer.pointOfSale,detail,type),detail,job.issuer.pointOfSale,type);
    await finish(result);
  } catch(error) {
    await update({status:job.status==='sent'||job.status==='uncertain'?'uncertain':'queued',issue:job.status==='sent'||job.status==='uncertain'?'awaiting_reconciliation':'connection_pending',leaseUntil:0});
    // Tokens, signed payloads, SOAP and customer details must never be logged.
  }
}
module.exports={enqueueInvoice,processInvoice,enabled,seriesKey};
