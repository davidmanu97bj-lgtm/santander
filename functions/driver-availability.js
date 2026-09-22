"use strict";
const {HttpsError}=require('firebase-functions/v2/https');
const {createHash}=require('node:crypto');
const NUMBERS=Object.freeze([28,57,104,31,15,154,43,134]);
const ZONES=Object.freeze(['Ciudad','Aeropuerto','Brasil','Paraguay']);
const ADMIN_UID='2LziyTTdFcZzSOhK3hLbAKs2U4s2';
/** Persistent claims doc — not rotated at midnight. Calendar day docs stay unused for claims. */
const CLAIMS_DOC_ID='active';
const dayKey=ms=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Argentina/Buenos_Aires',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(ms));
function activeProfile(p){return p&&p.active!==false&&p.activo!==false&&!p.deleted&&!p.isDeleted&&!p.eliminado&&!/inactiv|disabled|eliminad|deleted/.test(String(p.status||p.estado||'').toLowerCase());}
function nameFor(p){return String(p.displayName||p.nombreCompleto||p.nombre||p.username||'Chofer').replace(/[\r\n]+/g,' ').trim().slice(0,100);}
function normalizePhone(country,value){
 const cc=String(country),raw=String(value||'').trim();
 if(!['54','55','595'].includes(cc)||!/^[+\d\s().-]+$/.test(raw))throw new HttpsError('invalid-argument','Revisá el país y el número de WhatsApp.');
 let digits=raw.replace(/\D/g,'');
 if(raw.startsWith('+')||digits.startsWith('00')){if(digits.startsWith('00'))digits=digits.slice(2);if(!digits.startsWith(cc))throw new HttpsError('invalid-argument','El número no coincide con el país.');digits=digits.slice(cc.length);}
 else if((cc==='54'&&digits.length===13||cc==='55'&&digits.length>=12||cc==='595'&&digits.length===12)&&digits.startsWith(cc))digits=digits.slice(cc.length);
 if(cc==='54'&&/^[1-9]\d{9}$/.test(digits))digits='9'+digits;
 const valid=cc==='54'?/^9[1-9]\d{9}$/.test(digits):cc==='55'?/^[1-9]\d{9,10}$/.test(digits):/^9\d{8}$/.test(digits);
 if(!valid)throw new HttpsError('invalid-argument',cc==='54'?'Ingresá el código de área y el número, sin 0 ni 15.':'Revisá el código de área y el número.');
 return cc+digits;
}
function createAvailabilityService({db,now=Date.now,adminUid=ADMIN_UID}){
 const stateRef=uid=>db.collection('driver_availability').doc(uid);
 async function profile(tx,uid){
  const [d,u]=await Promise.all([tx.get(db.collection('choferes').doc(uid)),tx.get(db.collection('usuarios').doc(uid))]);
  const p={...d.data(),...u.data()};
  const active=d.exists&&activeProfile(d.data())&&(!u.exists||activeProfile(u.data()))&&uid!==adminUid&&!/^(admin|administrador|owner|superadmin)$/i.test(p.role||p.rol||'');
  return {active,name:nameFor(p)};
 }
 const caller=request=>{if(!request.auth?.uid)throw new HttpsError('unauthenticated','Iniciá sesión.');return request.auth.uid;};
 async function syncDriver(uid){
  return db.runTransaction(async tx=>{const [p,s]=await Promise.all([profile(tx,uid),tx.get(stateRef(uid))]);const current=s.data()||{};
   if(!p.active&&!s.exists)return;
   if(current.active===p.active&&current.name===p.name)return;
   tx.set(stateRef(uid),{uid,name:p.name,active:p.active,...(!s.exists?{status:'unknown',zone:'',number:null,numberDay:'',revision:0,phone:''}:{}),updatedAtMs:now()},{merge:true});
  });
 }
 async function bootstrap(request){
  const uid=caller(request);await db.runTransaction(async tx=>{if(uid!==adminUid&&!(await profile(tx,uid)).active)throw new HttpsError('permission-denied','Esta cuenta no está activa.');});
  // Resolve the current roster; no personal or financial profile data is exposed.
  const roster=await db.collection('choferes').get();
  await Promise.all(roster.docs.map(d=>syncDriver(d.id)));
  const day=dayKey(now());await ensureDay(day);
  return {day,serverTime:now(),isAdmin:uid===adminUid};
 }
 async function ensureDay(day=dayKey(now())){
  return db.runTransaction(async tx=>{
   const ref=db.collection('driver_availability_days').doc(CLAIMS_DOC_ID),legacyRef=db.collection('driver_availability_days').doc(day);
   const [s,legacy]=await Promise.all([tx.get(ref),tx.get(legacyRef)]);
   if(!s.exists){
    const seed=legacy.data()?.claims||{};
    tx.create(ref,{day,claims:seed,createdAtMs:now(),persistent:true});
   }else if(s.data().day!==day){
    // Advance the calendar label only — never wipe claims at midnight.
    tx.set(ref,{day},{merge:true});
   }
   return day;
  });
 }
 async function savePhone(request){
  const actor=caller(request),uid=String(request.data?.uid||actor);
  if(actor!==uid&&actor!==adminUid)throw new HttpsError('permission-denied','Solo el administrador puede editar otro número.');
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(uid))throw new HttpsError('invalid-argument','Chofer inválido.');
  const phone=normalizePhone(request.data?.country,request.data?.phone);
  return db.runTransaction(async tx=>{const [p,s]=await Promise.all([profile(tx,uid),tx.get(stateRef(uid))]);
   if(!p.active)throw new HttpsError('permission-denied','Esta cuenta no está activa.');
   const current=s.data()||{};
   if(current.phone&&actor!==adminUid&&current.phone!==phone)throw new HttpsError('permission-denied','Solo el administrador puede editar tu WhatsApp.');
   if(current.phone===phone)return {saved:true};
   tx.set(stateRef(uid),{uid,name:p.name,active:true,...(!s.exists?{status:'unknown',zone:'',number:null,numberDay:'',revision:0}:{}),phone,phoneUpdatedAtMs:now(),phoneUpdatedBy:actor},{merge:true});
   tx.create(db.collection('availability_phone_audit').doc(),{uid,actor,phone,previousPhone:current.phone||null,createdAtMs:now()});
   return {saved:true};
  });
 }
 async function change(request){
  const uid=caller(request),data=request.data||{},status=data.status,zone=data.zone,number=data.number??null,id=String(data.operationId||'');
  if(!['free','busy'].includes(status)||!ZONES.includes(zone)||number!==null&&(!NUMBERS.includes(number)||status!=='free'||!['Ciudad','Aeropuerto'].includes(zone))||!/^[-a-zA-Z0-9]{16,100}$/.test(id)||!Number.isSafeInteger(data.expectedRevision))throw new HttpsError('invalid-argument','Selección de disponibilidad inválida.');
  const fingerprint=createHash('sha256').update(JSON.stringify({status,zone,number,expectedRevision:data.expectedRevision})).digest('hex');
  return db.runTransaction(async tx=>{
   const stamp=now(),day=dayKey(stamp),ref=stateRef(uid),claimsRef=db.collection('driver_availability_days').doc(CLAIMS_DOC_ID),eventRef=db.collection('driver_availability_events').doc(uid+'_'+id);
   const [p,s,d,event]=await Promise.all([profile(tx,uid),tx.get(ref),tx.get(claimsRef),tx.get(eventRef)]);
   if(!p.active)throw new HttpsError('permission-denied','Esta cuenta no está activa.');
   if(event.exists){if(event.data().fingerprint!==fingerprint)throw new HttpsError('already-exists','La operación ya fue usada.');return event.data().result;}
   const current=s.data()||{},revision=Number(current.revision)||0;
   if(!current.phone)throw new HttpsError('failed-precondition','Primero cargá tu WhatsApp.');
   if(data.expectedRevision!==revision)throw new HttpsError('aborted','Tu estado cambió en otro dispositivo. Volvé a seleccionar.');
   const claims={...(d.data()?.claims||{})};
   const lastClaim=Number(current.lastClaimAtMs)||Math.max(0,...Object.values(claims).filter(c=>c.uid===uid).map(c=>Number(c.claimedAtMs)||0));
   if(number!==null&&lastClaim&&stamp-lastClaim<30*60*1000)throw new HttpsError('resource-exhausted','Podés adjudicar otro número en '+Math.ceil((lastClaim+30*60*1000-stamp)/60000)+' min.',{nextClaimAtMs:lastClaim+30*60*1000});
   // A reservation belongs only to the current occupied assignment; released when free or busy-without-number.
   for(const [reserved,claim] of Object.entries(claims)){if(claim.uid===uid)delete claims[reserved];}
   if(number!==null){if(claims[number])throw new HttpsError('already-exists','Ese número ya fue elegido. Seleccioná otro.');claims[number]={uid,claimedAtMs:claims[number]?.claimedAtMs||stamp};}
   const effectiveStatus=number!==null?'busy':status;
   const result={uid,status:effectiveStatus,zone,number,...(number!==null?{lastClaimAtMs:stamp}:lastClaim?{lastClaimAtMs:lastClaim}:{}),numberDay:number!==null?day:'',revision:revision+1,updatedAtMs:stamp};
   const same=current.status===effectiveStatus&&current.zone===zone&&(current.number??null)===number;
   tx.set(ref,{...result,name:p.name,active:true},{merge:true});
   tx.set(claimsRef,{day,claims,createdAtMs:d.data()?.createdAtMs||stamp,persistent:true});
   const name=p.name.toLocaleUpperCase('es-AR');
   const text=number!==null?name+' SE ADJUDICO EL '+number:effectiveStatus==='free'?name+' ESTA LIBRE':name+' ESTA OCUPADO';
   tx.create(eventRef,{uid,day,text,notify:!same,fingerprint,result,createdAtMs:stamp});
   return result;
  });
 }
 return {bootstrap,syncDriver,savePhone,change,ensureDay};
}
module.exports={createAvailabilityService,dayKey,normalizePhone,activeProfile,NUMBERS,ZONES,ADMIN_UID,CLAIMS_DOC_ID};
