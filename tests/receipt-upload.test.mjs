import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {prepareReceiptFile, receiptContentType, uploadReceiptFile, runBoundedTransaction, withOperationDeadline} from '../receipt-upload.js';

const photo = (size = 900000, type = 'image/png', name = 'comprobante.png') => new File([new Uint8Array(size)], name, {type});
const microtasks = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };

test('las fotos grandes bajan a 2000 px y JPEG .82; se conserva el texto sin agrandar originales más chicos', async () => {
  let releases = 0, quality;
  const canvas = {getContext:() => ({fillRect(){},drawImage(){}}),toBlob(callback,type,value){quality = value; callback(new Blob([new Uint8Array(120000)],{type}));}};
  const original = photo();
  const result = await prepareReceiptFile(original,{decodeImage:async()=>({image:{},width:4000,height:3000,release(){releases++;}}),createCanvas:()=>canvas});
  assert.equal(canvas.width,2000); assert.equal(canvas.height,1500);
  assert.equal(quality,.82); assert.equal(result.type,'image/jpeg'); assert.equal(result.name,'comprobante.jpg');
  assert.equal(result.size,120000); assert.equal(releases,1); assert.equal(original.size,900000);
  canvas.toBlob = callback => callback(photo(1000000));
  assert.equal(await prepareReceiptFile(original,{decodeImage:async()=>({image:{},width:1200,height:800,release(){}}),createCanvas:()=>canvas}),original);
});

test('PDF y capturas chicas quedan idénticos; MIME vacío se resuelve por nombre; codec no disponible conserva original', async () => {
  const decodeImage = () => { throw new Error('No debe decodificar'); };
  for (const file of [photo(500000,'application/pdf','factura.pdf'),photo(100000),photo(500000,'','factura.pdf')]) {
    assert.equal(await prepareReceiptFile(file,{decodeImage}),file);
  }
  assert.equal(receiptContentType(photo(10,'','foto.JPEG')),'image/jpeg');
  const unsupported = photo(500000,'image/heic','foto.heic');
  assert.equal(await prepareReceiptFile(unsupported,{decodeImage}),unsupported);
  await assert.rejects(prepareReceiptFile(photo(0)),{code:'receipt/invalid-file'});
  await assert.rejects(prepareReceiptFile(photo(15*1024*1024+1)),{code:'receipt/file-too-large'});
});

function uploadHarness(options = {}) {
  let callbacks, canceled = 0, detached = 0, starts = 0, urlReads = 0, metadata;
  const reference = {fullPath:'billing_receipts/driver/day/payment_1.jpg'};
  const task = {snapshot:{ref:reference,bytesTransferred:0,totalBytes:100,state:'running'},
    on(_event, progress, error, complete){callbacks = {progress,error,complete};return()=>{detached++;};},
    cancel(){canceled++;callbacks.error(Object.assign(Error('canceled'),{code:'storage/canceled'}));}};
  const promise = uploadReceiptFile({reference,file:photo(100,'','imagen.jpg'),
    uploadBytesResumable(_reference,_file,meta){starts++;metadata=meta;return task;},
    getDownloadURL:async()=>{urlReads++;return 'https://example.test/proof.jpg';},
    idleTimeoutMs:45,totalTimeoutMs:120,urlTimeoutMs:15,...options});
  return {promise,task,get starts(){return starts;},get canceled(){return canceled;},get detached(){return detached;},get metadata(){return metadata;},get urlReads(){return urlReads;},
    progress(bytes){task.snapshot={...task.snapshot,bytesTransferred:bytes};callbacks.progress(task.snapshot);},
    complete(){callbacks.complete();},error(error){callbacks.error(error);}};
}

test('subida con avance visible confirma enlace y usa MIME explícito una sola vez', async () => {
  const progress = [], upload = uploadHarness({onProgress:value=>progress.push(value)});
  upload.progress(42);upload.progress(100);upload.complete();
  assert.equal((await upload.promise).url,'https://example.test/proof.jpg');
  assert.deepEqual(progress,[0,42,100]);assert.equal(upload.starts,1);assert.equal(upload.urlReads,1);
  assert.equal(upload.metadata.contentType,'image/jpeg');assert.equal(upload.detached,1);assert.equal(upload.canceled,0);
});

test('subida trabada cancela y libera el formulario; no se oculta timeout detrás de storage/canceled', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const upload=uploadHarness();const rejected=assert.rejects(upload.promise,error=>error.code==='operation-timeout'&&error.stage==='upload');
  t.mock.timers.tick(45);await rejected;
  assert.equal(upload.canceled,1);assert.equal(upload.detached,1);assert.equal(upload.urlReads,0);assert.equal(upload.starts,1);
});

test('solo el avance real renueva los 45 segundos; una foto que avanza conserva hasta el límite total', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const upload=uploadHarness();const rejected=assert.rejects(upload.promise,{code:'operation-timeout'});
  t.mock.timers.tick(40);upload.progress(20);
  t.mock.timers.tick(40);upload.progress(40);
  t.mock.timers.tick(39);assert.equal(upload.canceled,0);
  t.mock.timers.tick(1);await rejected;assert.equal(upload.canceled,1);
  const stalled=uploadHarness();const stalledRejection=assert.rejects(stalled.promise,{code:'operation-timeout'});
  t.mock.timers.tick(40);stalled.progress(0);
  t.mock.timers.tick(5);await stalledRejection;assert.equal(stalled.canceled,1);
});

test('permiso rechazado no se reintenta y enlace pendiente tiene su propio límite', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const denied=uploadHarness();const rejection=assert.rejects(denied.promise,{code:'storage/unauthorized'});
  denied.error(Object.assign(Error('No permitido'),{code:'storage/unauthorized'}));await rejection;
  assert.equal(denied.starts,1);assert.equal(denied.urlReads,0);
  const noUrl=uploadHarness({getDownloadURL:()=>new Promise(()=>{})});
  const timeout=assert.rejects(noUrl.promise,{code:'operation-timeout'});noUrl.complete();await microtasks();
  t.mock.timers.tick(15);await timeout;assert.equal(noUrl.canceled,0);
});

test('una transacción cuyo read regresa después del límite no llega a confirmar escrituras tardías', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  let resolveRead,commits=0,attempts;
  const read=new Promise(resolve=>{resolveRead=resolve;});
  const firebaseRun=async(_db,handler,options)=>{attempts=options.maxAttempts;await handler({get:()=>read,set(){}});commits++;};
  const operation=runBoundedTransaction(firebaseRun,{},async tx=>{await tx.get({});tx.set({},{});},45);
  const rejected=assert.rejects(operation,{code:'operation-timeout'});t.mock.timers.tick(45);await rejected;
  resolveRead({});await microtasks();assert.equal(commits,0);assert.equal(attempts,3);
});

const source=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
function declaration(name) {
  const start=source.search(new RegExp(`^(?:async )?function ${name}\\(`,'m'));
  assert.ok(start>=0,name);return source.slice(start,source.indexOf('\n}',start)+2);
}
function chargeHarness({failUpload=false,loseAcknowledgement=false}={}) {
  const nodes=new Map(),stored=new Map(),pending={};let submit,uploads=0,writes=0,confirmations=0;
  const $=id=>{if(!nodes.has(id))nodes.set(id,{value:'',dataset:{step:'3'},disabled:false,classList:{add(){},remove(){}},reset(){},addEventListener(_name,callback){submit=callback;}});return nodes.get(id);};
  $('chargeMode').value='digital';$('chargeAmount').value='32500';$('detail').value='Viaje';
  const context=vm.createContext({$,auth:{currentUser:{uid:'driver'}},validateChargeStep:()=>true,chargeSteps:()=>[3],parseMoneyInput:Number,
    selectedPhotoFile:()=>photo(100),chargeDraftRequest:()=>({origin:'A',destination:'B',distanceKm:1,serviceDate:'2026-10-07'}),advancesLoaded:true,
    acquireSubmissionLock:()=>true,releaseSubmissionLock(){},ExploraPeriodPolicy:{VERSION:'net_wallets_cashbox_10_v1',chargeDelta:()=>-13000},
    readChargeRemisSelection:()=>({viajePrivado:true}),document:{},buildSubmissionFingerprint:async()=> 'same-fingerprint',
    safePendingRegistry:()=>pending,reservePendingOperation:(_kind,_uid,fingerprint)=>pending[fingerprint]??=( {operationId:'same-operation',createdAtMs:1}),
    clearPendingOperation:(_kind,_uid,fingerprint)=>delete pending[fingerprint],db:{},ROOT_COLLECTIONS:{payments:'billing_records'},
    doc:(_db,collection,id)=>({path:`${collection}/${id}`}),getDocFromServer:async reference=>({exists:()=>stored.has(reference.path),data:()=>stored.get(reference.path)}),
    prepareReceiptFile:async file=>file,ref:(_storage,path)=>({path}),storage:{},uploadBytesResumable(){},getDownloadURL(){},
    uploadReceiptFile:async()=>{uploads++;if(failUpload)throw Object.assign(Error('No permitido'),{code:'storage/unauthorized'});return {url:'https://example.test/proof.jpg'};},
    localDayKey:()=> '2026-10-07',advances:[],captureSubmissionBalance:()=>0,normalizedSettlementBalance:value=>value,renderChargePreview(){},
    currentWeeklyPeriodId:()=> 'week',currentDriverName:()=> 'Chofer',serverTimestamp:()=> 'server',BUSINESS_ID:'explora',
    runTransactionWithRetry:async handler=>{const result=await handler({get:async reference=>({exists:()=>stored.has(reference.path),data:()=>stored.get(reference.path)}),set(reference,data){writes++;stored.set(reference.path,data);}});if(loseAcknowledgement)throw Object.assign(Error('ACK perdido'),{code:'unavailable'});return result;},
    planAdvanceRepayment:()=>({allocations:[],totalApplied:0}),syncChargeCustomerFields(){},closeModalAndGoTop(){},money:String,
    confirmCommittedOperation:async()=>{confirmations++;return false;},withOperationDeadline,console:{error(){}},Date});
  vm.runInContext(['firebaseErrorCode','assertSameCommittedOperation','shouldCheckUncertainWrite','receiptSaveError'].map(declaration).join('\n'),context);
  const start=source.indexOf('$("chargeForm")?.addEventListener("submit",');
  vm.runInContext(source.slice(start,source.indexOf('\n});',start)+4),context);
  return {submit:()=>submit({preventDefault(){}}),nodes,stored,pending,get uploads(){return uploads;},get writes(){return writes;},get confirmations(){return confirmations;}};
}

test('fallo de Storage no consulta Firestore ni borra identidad de reintento; libera el botón de cobro',async()=>{
  const app=chargeHarness({failUpload:true});await app.submit();
  assert.equal(app.uploads,1);assert.equal(app.writes,0);assert.equal(app.confirmations,0);
  assert.equal(app.pending['same-fingerprint'].operationId,'same-operation');
  assert.equal(app.nodes.get('saveChargeBtn').disabled,false);assert.match(app.nodes.get('chargeStatus').textContent,/permiso/);
});

test('acuse perdido: reintentar reconoce el mismo cobro confirmado sin volver a subir ni duplicar el movimiento',async()=>{
  const app=chargeHarness({loseAcknowledgement:true});await app.submit();
  assert.equal(app.writes,1);assert.equal(app.uploads,1);assert.equal(app.confirmations,1);
  assert.equal(app.pending['same-fingerprint'].operationId,'same-operation');
  await app.submit();
  assert.equal(app.writes,1);assert.equal(app.uploads,1);assert.equal(app.stored.size,1);
  assert.equal(app.pending['same-fingerprint'],undefined);assert.match(app.nodes.get('chargeStatus').textContent,/una sola vez/);
});

test('gasto: commit anterior entre preflight y reintento se reconoce con una lectura, sin sobrescribir saldo ni informar permisos falsos',async()=>{
  const nodes=new Map(),pending={},stored=new Map();let submit,writes=0,reads=0,originalPayload;
  const $=id=>{if(!nodes.has(id))nodes.set(id,{value:'',dataset:{step:'2'},disabled:false,classList:{add(){}},reset(){},querySelectorAll:()=>[],addEventListener(_event,callback){submit=callback;}});return nodes.get(id);};
  $('expenseAmount').value='10000';$('expenseDetail').value='Combustible';
  const permission=()=>Object.assign(Error('No permitido'),{code:'permission-denied'});
  const context=vm.createContext({$,auth:{currentUser:{uid:'driver'}},validateExpenseStep:()=>true,parseMoneyInput:Number,selectedPhotoFile:()=>photo(100),
    ExploraExpensePolicy:{version:'gross_expense_policy_v3',find:()=>({id:'combustible',label:'Combustible',refundRate:.5,group:'shared'})},
    ExploraPeriodPolicy:{VERSION:'net_wallets_cashbox_10_v1',expenseRate:()=>-.5},acquireSubmissionLock:()=>true,releaseSubmissionLock(){},
    setPhotoPickerDisabled(){},buildSubmissionFingerprint:async()=> 'same-fingerprint',safePendingRegistry:()=>pending,
    reservePendingOperation:(_kind,_uid,fingerprint)=>pending[fingerprint]??={operationId:'same-expense',createdAtMs:1},
    clearPendingOperation:(_kind,_uid,fingerprint)=>delete pending[fingerprint],db:{},ROOT_COLLECTIONS:{expenses:'gastos'},
    doc:(_db,collection,id)=>({path:`${collection}/${id}`}),
    getDocFromServer:async reference=>{reads++;if(!stored.has(reference.path))throw permission();return {exists:()=>true,data:()=>stored.get(reference.path),metadata:{fromCache:false,hasPendingWrites:false}};},
    setDoc:async(reference,payload)=>{writes++;if(writes===1){originalPayload=payload;throw Object.assign(Error('ACK pendiente'),{code:'unavailable'});}stored.set(reference.path,originalPayload);throw permission();},
    prepareReceiptFile:async file=>file,ref:(_storage,path)=>({path}),storage:{},uploadBytesResumable(){},getDownloadURL(){},
    uploadReceiptFile:async()=>({url:'https://example.test/proof.jpg'}),captureSubmissionBalance:()=>writes?5000:0,renderExpensePreview(){},
    localDayKey:()=> '2026-10-07',currentWeeklyPeriodId:()=> 'week',currentDriverName:()=> 'Chofer',serverTimestamp:()=> 'server',BUSINESS_ID:'explora',
    closeModalAndGoTop(){},withOperationDeadline,delay:async()=>{throw Error('No debe esperar ni repetir la confirmación de permisos');},console:{error(){}},Date});
  vm.runInContext(['firebaseErrorCode','assertSameCommittedOperation','confirmCommittedOperation','shouldCheckUncertainWrite','receiptSaveError'].map(declaration).join('\n'),context);
  const start=source.indexOf('$("expenseForm")?.addEventListener("submit",');
  vm.runInContext(source.slice(start,source.indexOf('\n});',start)+4),context);
  await submit({preventDefault(){}});assert.equal(writes,1);assert.equal(reads,1);
  await submit({preventDefault(){}});
  assert.equal(writes,2);assert.equal(stored.size,1);assert.equal(stored.values().next().value.telegramSettlementBeforeBalance,0);
  // One preflight and just one acknowledgement check during the retry.
  assert.equal(reads,3);assert.equal(pending['same-fingerprint'],undefined);
  assert.match($('expenseStatus').textContent,/confirmado y registrado una sola vez/);
});

test('una denegación real sin documento solo verifica una vez y conserva su mensaje de permisos',async()=>{
  let reads=0;const context=vm.createContext({getDocFromServer:async()=>{reads++;return {exists:()=>false};},withOperationDeadline,
    delay:async()=>{throw Error('No debe esperar para confirmar permiso denegado');}});
  vm.runInContext(['confirmCommittedOperation','firebaseErrorCode','receiptSaveError'].map(declaration).join('\n'),context);
  assert.equal(await context.confirmCommittedOperation({},'expense','fp',{attempts:1}),false);assert.equal(reads,1);
  assert.match(context.receiptSaveError({code:'permission-denied'},'gasto'),/permiso/);
});
