import test from 'node:test';
import assert from 'node:assert/strict';
import {createReceiptUploadCache} from '../receipt-upload.js';

const photo = name => new File(['photo'], name, {type:'image/jpeg'});
const deferred = () => { let resolve, reject; const promise = new Promise((yes,no) => {resolve=yes;reject=no;}); return {promise,resolve,reject}; };
const microtasks = async () => {for(let index=0;index<8;index++)await Promise.resolve();};

test('selección y confirmación comparten una sola promesa y reutilizan el comprobante terminado', async () => {
  const gate=deferred();let prepared=0,uploads=0,paths=0;
  const file=photo('proof.jpg');
  const cache=createReceiptUploadCache({prepareFile:async original=>{prepared++;assert.equal(original,file);return original;},
    createPath:(preparedFile,uid)=>{paths++;assert.equal(preparedFile,file);return `billing_receipts/${uid}/receipt.jpg`;},
    uploadFile:async({path})=>{uploads++;await gate.promise;return {url:`https://example.test/${path}`};}});
  const preupload=cache.get(file,'driver-a');
  const confirmation=cache.get(file,'driver-a');
  assert.equal(preupload,confirmation);
  await microtasks();assert.equal(uploads,1);
  gate.resolve();assert.deepEqual(await confirmation,{url:'https://example.test/billing_receipts/driver-a/receipt.jpg',path:'billing_receipts/driver-a/receipt.jpg'});
  const progress=[];assert.equal(cache.get(file,'driver-a',value=>progress.push(value)),preupload);
  assert.deepEqual(progress,[{stage:'ready',percent:100}]);
  assert.equal(prepared,1);assert.equal(paths,1);assert.equal(uploads,1);
});

test('archivos distintos y usuarios distintos nunca comparten comprobante', async () => {
  let uploads=0;
  const cache=createReceiptUploadCache({prepareFile:async file=>file,createPath:(file,uid)=>`${uid}/${file.name}`,
    uploadFile:async({path})=>{uploads++;return {url:`https://example.test/${path}`};}});
  const first=photo('first.jpg'),second=photo('second.jpg');
  const promises=[cache.get(first,'driver-a'),cache.get(first,'driver-b'),cache.get(second,'driver-a')];
  assert.notEqual(promises[0],promises[1]);assert.notEqual(promises[0],promises[2]);
  assert.deepEqual((await Promise.all(promises)).map(value=>value.path),['driver-a/first.jpg','driver-b/first.jpg','driver-a/second.jpg']);
  assert.equal(uploads,3);
});

test('fallos de preparación o subida liberan la entrada para un reintento real', async () => {
  for(const failStage of ['prepare','upload']) {
    let failed=false,uploads=0,prepared=0;
    const cache=createReceiptUploadCache({prepareFile:async file=>{prepared++;if(failStage==='prepare'&&!failed){failed=true;throw Error('preparación');}return file;},
      createPath:()=> 'proof.jpg',uploadFile:async()=>{uploads++;if(failStage==='upload'&&!failed){failed=true;throw Error('subida');}return {url:'https://example.test/proof.jpg'};}});
    const file=photo('proof.jpg'),first=cache.get(file,'driver-a');
    await assert.rejects(first);
    const retry=cache.get(file,'driver-a');assert.notEqual(retry,first);
    assert.equal((await retry).url,'https://example.test/proof.jpg');assert.equal(prepared,2);
    assert.equal(uploads,failStage==='upload'?2:1);
  }
});

test('el consumidor actual recibe avance; callbacks fallidos y tardíos no rompen ni alteran un resultado final', async () => {
  const gate=deferred();let report;
  const old=[],current=[];
  const cache=createReceiptUploadCache({prepareFile:async file=>file,createPath:()=> 'proof.jpg',
    uploadFile:async({onProgress})=>{report=onProgress;await gate.promise;return {url:'https://example.test/proof.jpg'};}});
  const file=photo('proof.jpg'),first=cache.get(file,'driver-a',value=>old.push(value));
  await microtasks();report(25);
  const oldCount=old.length;
  assert.equal(cache.get(file,'driver-a',value=>{current.push(value);throw Error('UI desmontada');}),first);
  report(75);report(100);gate.resolve();await first;
  assert.equal(old.length,oldCount);
  assert.deepEqual(current,[{stage:'upload',percent:25},{stage:'upload',percent:75},{stage:'url',percent:100},{stage:'ready',percent:100}]);
  report(30);assert.equal(current.length,4);
  const cached=[];await cache.get(file,'driver-a',value=>cached.push(value));
  assert.deepEqual(cached,[{stage:'ready',percent:100}]);
});

test('un enlace vacío o inválido no queda cacheado como éxito', async () => {
  for(const invalidUrl of ['',undefined,'javascript:alert(1)','relative.jpg']) {
    let attempts=0;
    const cache=createReceiptUploadCache({prepareFile:async file=>file,createPath:()=> 'proof.jpg',
      uploadFile:async()=>({url:++attempts===1?invalidUrl:'https://example.test/proof.jpg'})});
    const file=photo('proof.jpg');
    await assert.rejects(cache.get(file,'driver-a'),{code:'receipt/invalid-url'});
    assert.equal((await cache.get(file,'driver-a')).url,'https://example.test/proof.jpg');assert.equal(attempts,2);
  }
});
