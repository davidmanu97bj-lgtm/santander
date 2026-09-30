"use strict";
const {createHash}=require('node:crypto');
const {analyzeFleetImport,CSV_TEMPLATES}=require('./uber-fleet-core');

const COLLECTIONS=Object.freeze({trips:'uber_fleet_shadow_trips',imports:'uber_fleet_shadow_imports',settings:'uber_fleet_shadow_settings'});
const MAX_CONTEXT=1000, MAX_IMPORT=100;
class FleetServiceError extends Error {constructor(code,message){super(message);this.code=code;}}
const fail=message=>{throw new FleetServiceError('invalid-argument',message);};
const rows=snap=>snap.docs.map(doc=>({id:doc.id,...doc.data()}));
const clean=value=>JSON.parse(JSON.stringify(value));
const fingerprint=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function bounded(read,query,label){
  const result=await read(query.limit(MAX_CONTEXT+1));
  if(result.size>MAX_CONTEXT)throw new FleetServiceError('resource-exhausted',`El historial supera los ${MAX_CONTEXT} ${label} admitidos por esta primera versión. Se necesita ampliar la conciliación histórica antes de continuar; no se modificó ningún saldo.`);
  return rows(result);
}
function validateInput(input){
  if(!input||typeof input!=='object')fail('Faltan los datos de la importación.');
  if(input.mode&&input.mode!=='shadow')fail('Solo está habilitada la comparación sin movimientos reales.');
  if(typeof input.fleetId!=='string'||! /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(input.fleetId))fail('Ingresá el identificador de tu flota de Uber, sin espacios.');
  for(const key of ['tripsCsv','paymentsCsv'])if(typeof input[key]!=='string'||Buffer.byteLength(input[key],'utf8')>2_000_000)fail('Cada reporte debe ser un CSV de hasta 2 MB.');
  if(!input.tripsCsv.trim())fail('Cargá el reporte de viajes.');
  if(!input.driverMappings||Array.isArray(input.driverMappings)||typeof input.driverMappings!=='object'||Object.keys(input.driverMappings).length>40)fail('Revisá la asociación de choferes.');
  for(const [uberId,mapping]of Object.entries(input.driverMappings)){
    if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(uberId)||!mapping||typeof mapping.driverUid!=='string'||!mapping.driverUid||mapping.driverUid.includes('/')||!['explora','driver','unknown'].includes(mapping.digitalRecipient))fail('Cada ID de Uber debe asociarse a un chofer y un destinatario de los cobros digitales.');
  }
  return {fleetId:input.fleetId,tripsCsv:input.tripsCsv,paymentsCsv:input.paymentsCsv,driverMappings:input.driverMappings};
}

// The only writes in this service are to dedicated shadow collections. It cannot
// create payments, invoices, wallet entries, Telegram jobs, or weekly closures.
function createFleetShadowService({db,assertAdmin,now=()=>Date.now()}){
  async function drivers(){
    const source=await bounded(q=>q.get(),db.collection('choferes'),'choferes');
    return source.filter(d=>d.active!==false&&d.activo!==false&&!d.deleted&&!d.isDeleted&&!['admin','administrador','owner','superadmin'].includes(String(d.role||d.rol||'').toLowerCase())).map(d=>({uid:d.authUid||d.uid||d.id,name:String(d.displayName||d.nombre||d.name||d.username||'Chofer').slice(0,120)}));
  }
  async function status(request){
    await assertAdmin(request);
    const [team,settings,saved]=await Promise.all([drivers(),db.collection(COLLECTIONS.settings).doc('current').get(),db.collection(COLLECTIONS.imports).orderBy('updatedAtMs','desc').limit(10).get()]);
    const configuration=settings.data()||{};
    return {mode:'shadow',liveEnabled:false,apiConnected:false,apiMessage:'Uber debe habilitar la aplicación y sus permisos de flota. Mientras tanto podés comparar reportes CSV.',drivers:team,fleetId:configuration.fleetId||'',driverMappings:configuration.driverMappings||{},history:rows(saved).sort((a,b)=>b.updatedAtMs-a.updatedAtMs).slice(0,10)};
  }
  async function analyze(request){
    const uid=await assertAdmin(request);
    const input=validateInput(request.data);
    const team=await drivers(), validIds=new Set(team.map(d=>d.uid));
    for(const mapping of Object.values(input.driverMappings))if(!validIds.has(mapping.driverUid))fail('Uno de los choferes asociados ya no está activo en Explora.');
    const persist=request.data.persist===true;
    const driverUids=[...new Set(Object.values(input.driverMappings).map(m=>m.driverUid))];
    const run=async tx=>{
      const read=q=>tx?tx.get(q):q.get();
      const [existingTrips,finance]=await Promise.all([
        bounded(read,db.collection(COLLECTIONS.trips).where('fleetId','==',input.fleetId),'viajes previamente comparados'),
        Promise.all(driverUids.map(async driverUid=>{
          const [payments,weeks]=await Promise.all([
            bounded(read,db.collection('billing_records').where('driverUid','==',driverUid),'cobros del chofer'),
            bounded(read,db.collection('uber_weekly_closures').where('driverUid','==',driverUid),'cierres Uber del chofer')
          ]);return {payments,weeks};
        }))
      ]);
      const result=analyzeFleetImport({...input,existingTrips,existingPayments:finance.flatMap(f=>f.payments),weeklyClosures:finance.flatMap(f=>f.weeks),nowMs:now()});
      if(result.trips.length>MAX_IMPORT)fail(`Compará hasta ${MAX_IMPORT} viajes por archivo. Exportá un período más corto desde Uber.`);
      const importId=fingerprint(input);
      const response={...result,mode:'shadow',liveEnabled:false,importId,saved:false};
      if(!persist)return response;
      if(!result.trips.length||result.issues?.some(i=>i.fatal===true||i.severity==='error'))fail('Corregí los errores del archivo antes de guardar la comparación.');
      const importRef=db.collection(COLLECTIONS.imports).doc(importId);
      const earlier=await tx.get(importRef);
      const updatedAtMs=now();
      const differences=[];
      for(const trip of result.trips){
        const before=existingTrips.find(t=>t.id===trip.id);
        // A corrected report is evidence of a difference, not permission to
        // silently overwrite the previously imported facts.
        if(before&&before.sourceHash!==trip.sourceHash){
          differences.push({id:trip.id,tripId:trip.tripId,previousSourceHash:before.sourceHash,sourceHash:trip.sourceHash,amountCents:trip.amountCents,currency:trip.currency,issueCodes:trip.issues.map(i=>i.code)});
          continue;
        }
        tx.set(db.collection(COLLECTIONS.trips).doc(trip.id),clean({...trip,fleetId:input.fleetId,mode:'shadow',isSimulated:true,importId,importedBy:uid,createdAtMs:before?.createdAtMs||updatedAtMs,updatedAtMs}));
      }
      tx.set(importRef,clean({id:importId,fleetId:input.fleetId,mode:'shadow',summary:result.summary,differences,createdAtMs:earlier.data()?.createdAtMs||updatedAtMs,updatedAtMs,importedBy:uid}));
      tx.set(db.collection(COLLECTIONS.settings).doc('current'),clean({fleetId:input.fleetId,driverMappings:input.driverMappings,updatedAtMs,updatedBy:uid,mode:'shadow'}));
      return {...response,saved:true,differenceCount:differences.length};
    };
    return persist?db.runTransaction(run):run(null);
  }
  async function templates(request){await assertAdmin(request);return {mode:'shadow',templates:CSV_TEMPLATES};}
  return {status,analyze,templates};
}
module.exports={createFleetShadowService,FleetServiceError,COLLECTIONS,validateInput};
