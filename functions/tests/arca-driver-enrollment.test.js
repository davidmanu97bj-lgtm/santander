'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const {prepareArcaDriverEnrollment}=require('../arca-driver-enrollment');
const {buildInvoice}=require('../arca-invoice');
const {enabled}=require('../arca-worker');
const {DOMESTIC_EXEMPT_POLICY,generalPolicyReady}=require('../arca-policy');

const NOW=Date.parse('2026-10-15T15:00:00Z');
const SETTINGS='arca_settings/current';
const union=Symbol('arrayUnion');
const FieldValue={serverTimestamp:()=>NOW,arrayUnion:(...values)=>({[union]:values})};
const config={enabled:true,environment:'production',regime:'general',invoiceType:6,
  approvedDriverUids:['existing-driver'],taxPolicy:DOMESTIC_EXEMPT_POLICY,
  domesticTaxiExemptionVerified:true,exclusivePointOfSale:true,homologationPassed:true,
  registrationVerified:true,generalHomologationPassed:true,invoiceAEnabled:true,
  invoiceAHomologationPassed:true,pointEmissionType:'CAE - Ri Iva',pointOfSale:3,
  cuit:'20123456786',legalName:'EMISOR SINTETICO',address:'Domicilio sintético',
  grossIncomeId:'Dato sintético',activityStart:'2024-01-01',activeFrom:'2026-10-01T00:00:00-03:00'};

// In-memory optimistic transactions: reject reads after writes, retry conflicts,
// stage every write until commit, and implement only the array transform used here.
function memoryDb() {
  const data=new Map(),versions=new Map();
  const snapshot=ref=>({exists:data.has(ref.path),data:()=>data.get(ref.path)});
  const db={data,retries:0,failRead:'',failCommit:false,
    collection:name=>({doc:id=>{const ref={id,path:`${name}/${id}`};ref.get=async()=>snapshot(ref);return ref;}}),
    runTransaction:async callback=>{
      for(let attempt=0;attempt<10;attempt++) {
        const reads=new Map(),writes=[];
        const result=await callback({
          get:async ref=>{
            assert.equal(writes.length,0,'Firestore transactions require all reads before writes');
            if(db.failRead===ref.path)throw new Error('READ_FAILED');
            reads.set(ref.path,versions.get(ref.path)||0);return snapshot(ref);
          },
          create:(ref,row)=>writes.push({kind:'create',ref,row}),
          set:(ref,row,options)=>writes.push({kind:'set',ref,row,merge:options?.merge}),
          update:(ref,row)=>writes.push({kind:'update',ref,row})
        });
        if([...reads].some(([path,version])=>(versions.get(path)||0)!==version)) {db.retries++;continue;}
        if(db.failCommit)throw new Error('COMMIT_FAILED');
        const staged=new Map(data);
        for(const {kind,ref,row,merge} of writes) {
          if(kind==='create'&&staged.has(ref.path))throw new Error('ALREADY_EXISTS');
          if(kind==='update'&&!staged.has(ref.path))throw new Error('NOT_FOUND');
          const previous=staged.get(ref.path)||{},next=kind==='update'||merge?{...previous}:{};
          for(const [key,value] of Object.entries(row))next[key]=value?.[union]
            ? [...(previous[key]||[]),...value[union].filter(item=>!(previous[key]||[]).includes(item))] : value;
          staged.set(ref.path,next);
        }
        for(const {ref} of writes) {data.set(ref.path,staged.get(ref.path));versions.set(ref.path,(versions.get(ref.path)||0)+1);}
        return result;
      }
      throw new Error('TOO_MANY_RETRIES');
    }
  };
  return db;
}

// Execute the shipped callable with fake Auth/Firestore; never import the entry
// point, initialize Firebase, load credentials or construct an ARCA client.
const source=fs.readFileSync(require.resolve('../index.js'),'utf8');
const createDriverSource=source.slice(source.indexOf('exports.adminCreateDriver ='),source.indexOf('exports.adminUpdateDriver ='));
function callable(db) {
  const accounts=new Map(),cleaned=[],claims=[];
  class HttpsError extends Error {constructor(code,message){super(message);this.code=code;}}
  const context={exports:{},onCall:(_,handler)=>handler,HttpsError,db,FieldValue,prepareArcaDriverEnrollment,
    assertAdmin:async request=>{if(request.auth?.uid!=='admin')throw new HttpsError('permission-denied','Admin requerido');return 'admin';},
    auth:{createUser:async input=>{const uid=`uid_${input.email.split('@')[0]}`;accounts.set(uid,input);return {uid};},
      setCustomUserClaims:async(uid,value)=>claims.push({uid,value})},
    disableAndDeleteAuthUser:async uid=>{accounts.delete(uid);cleaned.push(uid);return true;},
    text:value=>String(value||'').trim(),normalized:value=>String(value||'').trim().toLowerCase(),
    normalizeUsername:value=>String(value||'').trim().toLowerCase(),legacyEmailFromLogin:value=>`${value}@example.test`,
    isValidUsername:()=>true,isReservedUsername:()=>false,isValidPassword:()=>true,isValidEmail:()=>true,
    dateInArgentina:()=> '2026-10-15',ADMIN_AUDIT_COLLECTION:'admin_audit',
    safeErrorMessage:(_,fallback)=>fallback};
  vm.runInNewContext(createDriverSource,context);
  return {run:context.exports.adminCreateDriver,accounts,cleaned,claims};
}
const request=(username='new-driver',extra={})=>({auth:{uid:'admin'},data:{nombre:'Chofer sintético',username,password:'synthetic-password',...extra}});
const currentConfig=(db,patch={})=>db.data.set(SETTINGS,{...config,approvedDriverUids:[...config.approvedDriverUids],...patch});
const audit=(db,uid='uid_new-driver')=>db.data.get(`admin_audit/create_${uid}`);
async function enroll(db,uid) {
  return db.runTransaction(async tx=>{
    const plan=await prepareArcaDriverEnrollment({db,tx,uid,arrayUnion:FieldValue.arrayUnion});
    if(plan.update)tx.update(plan.ref,plan.update);return plan.status;
  });
}

test('el alta real incorpora el UID y sus cobros efectivo/digital, A/B pasan el mismo control fiscal',async()=>{
  const db=memoryDb();currentConfig(db);const original=structuredClone(db.data.get(SETTINGS));
  db.data.set('arca_invoices/historical',{status:'review',issues:['driver_not_authorized_for_invoicing']});
  const h=callable(db),result=await h.run(request()),settings=db.data.get(SETTINGS);
  assert.equal(result.uid,'uid_new-driver');assert.equal(audit(db).arcaEnrollmentStatus,'enrolled');
  assert.deepEqual(settings,{...original,approvedDriverUids:['existing-driver',result.uid]});
  assert.equal(db.data.get(`choferes/${result.uid}`).authUid,result.uid);
  assert.equal(db.data.get('login_aliases/new-driver').uid,result.uid);
  assert.equal(db.data.get(`choferes/${result.uid}`).active,true);
  for(const method of ['cash','digital'])for(const named of [false,true]) {
    const payment={driverUid:result.uid,method,type:method==='cash'?'billing':'payment',status:'completed',amount:10000,
      createdAt:{toMillis:()=>NOW},invoiceRequest:{version:'arca_c_v1',serviceDate:'2026-10-15',scope:'national',
        origin:'Origen sintético',destination:'Destino sintético',distanceKm:20,
        customer:named?{requested:true,name:'Cliente sintético',documentType:'CUIT',documentNumber:'20123456786',vatCondition:'registered'}:{}}};
    assert.ok(buildInvoice(payment,original,new Date(NOW)).issues.includes('driver_not_authorized_for_invoicing'));
    const invoice=buildInvoice(payment,settings,new Date(NOW));
    assert.deepEqual(invoice.issues,[]);assert.equal(invoice.invoiceType,named?1:6);
    assert.equal(buildInvoice({...payment,isSimulated:true},settings,new Date(NOW)),null);
  }
  assert.deepEqual(db.data.get('arca_invoices/historical'),{status:'review',issues:['driver_not_authorized_for_invoicing']});
  assert.equal([...db.data.keys()].filter(key=>key.startsWith('arca_invoices/')).length,1);
});

test('dos altas concurrentes reintentan sin perder autorizados ni duplicar un UID',async()=>{
  const db=memoryDb();currentConfig(db);const h=callable(db);
  const results=await Promise.all([h.run(request('driver-one')),h.run(request('driver-two'))]);
  assert.ok(db.retries>0,'the test must exercise a conflicting transaction');
  assert.deepEqual(new Set(db.data.get(SETTINGS).approvedDriverUids),new Set(['existing-driver',...results.map(row=>row.uid)]));
  assert.equal(await enroll(db,results[0].uid),'already_approved');
  assert.equal(await enroll(db,results[0].uid),'already_approved');
  assert.equal(db.data.get(SETTINGS).approvedDriverUids.length,3);
  for(const row of results)assert.equal(audit(db,row.uid).arcaEnrollmentStatus,'enrolled');
});

test('reasignar vehículo conserva la fase de lecturas anterior a cualquier escritura',async()=>{
  const db=memoryDb();currentConfig(db);
  db.data.set('vehiculos/car',{currentDriverUid:'old-driver',currentDriverDocumentId:'old-profile',patente:'SYN123'});
  db.data.set('choferes/old-profile',{uid:'old-driver',vehicleId:'car'});
  const result=await callable(db).run(request('new-driver',{vehicleId:'car',allowReassign:true}));
  assert.equal(db.data.get('choferes/old-profile').vehicleId,null);
  assert.equal(db.data.get('vehiculos/car').currentDriverUid,result.uid);
  assert.equal(db.data.get(`choferes/${result.uid}`).vehicleId,'car');
  assert.ok(db.data.get(SETTINGS).approvedDriverUids.includes(result.uid));
});

test('configuración ausente o lista ausente/inválida no se crea ni repara; queda auditada',async()=>{
  const cases=[{exists:false,status:'settings_missing'},
    {exists:true,value:undefined,status:'allowlist_missing'},
    ...[null,'old-driver',{},[12],[''],['existing-driver',null]].map(value=>({exists:true,value,status:'allowlist_invalid'}))];
  for(const item of cases) {
    const db=memoryDb();
    if(item.exists){currentConfig(db,{approvedDriverUids:item.value});if(item.value===undefined)delete db.data.get(SETTINGS).approvedDriverUids;}
    const before=structuredClone(db.data.get(SETTINGS));await callable(db).run(request());
    assert.deepEqual(db.data.get(SETTINGS),before);assert.equal(db.data.has(SETTINGS),item.exists);
    assert.equal(audit(db).arcaEnrollmentStatus,item.status);assert.ok(db.data.has('choferes/uid_new-driver'));
  }
});

test('incorporar estando deshabilitado u otro régimen no cambia ninguna política ni activa emisión',async()=>{
  for(const patch of [{enabled:false},{enabled:false,regime:'monotributo',invoiceType:11},{enabled:false,regime:'pending'}]) {
    const db=memoryDb();currentConfig(db,patch);const before=structuredClone(db.data.get(SETTINGS));
    await callable(db).run(request());
    assert.deepEqual(db.data.get(SETTINGS),{...before,approvedDriverUids:[...before.approvedDriverUids,'uid_new-driver']});
    assert.equal(enabled(db.data.get(SETTINGS)),false);
  }
});

test('la primera alta completa una lista vacía y conserva las verificaciones de activación',async()=>{
  for(const active of [false,true]) {
    const db=memoryDb();currentConfig(db,{enabled:active,approvedDriverUids:[]});
    assert.equal(generalPolicyReady(db.data.get(SETTINGS)),false);
    await callable(db).run(request());
    assert.equal(generalPolicyReady(db.data.get(SETTINGS)),true);
    assert.equal(db.data.get(SETTINGS).enabled,active);assert.equal(enabled(db.data.get(SETTINGS)),active);
  }
});

test('fallas de vehículo, lectura fiscal o commit revierten el alta sin autorización parcial',async()=>{
  for(const failure of ['vehicle','read','commit']) {
    const db=memoryDb();currentConfig(db);const before=structuredClone(db.data.get(SETTINGS)),h=callable(db);
    if(failure==='read')db.failRead=SETTINGS;
    if(failure==='commit')db.failCommit=true;
    await assert.rejects(h.run(request('new-driver',failure==='vehicle'?{vehicleId:'missing-car'}:{})));
    assert.deepEqual(db.data.get(SETTINGS),before);
    assert.equal(db.data.has('choferes/uid_new-driver'),false);assert.equal(db.data.has('login_aliases/new-driver'),false);
    assert.equal(db.data.has('admin_audit/create_uid_new-driver'),false);
    assert.equal(h.accounts.size,0);assert.deepEqual(h.cleaned,['uid_new-driver']);
  }
});

test('la incorporación sólo sucede tras validar el administrador y crear su chofer real',async()=>{
  const db=memoryDb();currentConfig(db);const before=structuredClone(db.data.get(SETTINGS)),h=callable(db);
  await assert.rejects(h.run({...request(),auth:{uid:'driver'}}),{code:'permission-denied'});
  await assert.rejects(h.run(request('new-driver',{role:'admin'})),{code:'invalid-argument'});
  db.data.set('login_aliases/new-driver',{uid:'existing-driver'});
  await assert.rejects(h.run(request()),{code:'already-exists'});
  assert.deepEqual(db.data.get(SETTINGS),before);assert.equal(h.accounts.size,0);assert.equal(h.cleaned.length,0);
});
