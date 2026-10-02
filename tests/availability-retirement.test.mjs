import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {HOSTING_FILES} from '../tools/project.mjs';
import {REMIS_NUMBERS,renderChargeRemisStep} from '../ops-salidas.js';

const read=path=>fs.readFileSync(new URL('../'+path,import.meta.url),'utf8');
const callables=['availabilityBootstrap','availabilitySavePhone','availabilityChange'];
const triggers=['availabilityDriverSync','availabilityUserSync','availabilityMidnight','availabilityTelegram'];

function retiredHandlers(){
  const wrap=(options,handler)=>({options,handler});
  class HttpsError extends Error {constructor(code,message){super(message);this.code=code;}}
  const dependencies={
    'firebase-functions/v2/https':{onCall:wrap,HttpsError},
    'firebase-functions/v2/firestore':{onDocumentWritten:wrap,onDocumentCreated:wrap},
    'firebase-functions/v2/scheduler':{onSchedule:wrap}
  };
  const module={exports:{}};
  vm.runInNewContext(read('functions/driver-availability-functions.js'),{
    module,require:name=>{assert.ok(dependencies[name],'retirement must not load data or messaging services');return dependencies[name];}
  });
  const unavailable=new Proxy({}, {get(){assert.fail('retirement must not access database or Telegram');}});
  return module.exports(unavailable);
}

test('old availability calls reject every retry without reading or changing records',()=>{
  const functions=retiredHandlers();
  assert.deepEqual(Object.keys(functions),[...callables,...triggers]);
  for(const name of callables){
    for(const auth of [undefined,{uid:'driver'},{uid:'admin'}]){
      const request={auth,data:{status:'free',zone:'Ciudad',number:57,operationId:'old-retry',phone:'+5493757123456'}};
      const before=structuredClone(request);
      for(let retry=0;retry<2;retry++)assert.throws(()=>functions[name].handler(request),{code:'failed-precondition'});
      assert.deepEqual(request,before);
    }
  }
});

test('retired profile, midnight and queued Telegram events are inert even on repeated delivery',async()=>{
  const functions=retiredHandlers();
  const event=new Proxy({}, {get(){assert.fail('retired triggers must ignore pending events without reading data');}});
  for(const name of triggers)for(let retry=0;retry<2;retry++)assert.equal(await functions[name].handler(event),null);
  assert.equal(functions.availabilityDriverSync.options.document,'choferes/{uid}');
  assert.equal(functions.availabilityUserSync.options.document,'usuarios/{uid}');
  assert.equal(functions.availabilityTelegram.options.document,'driver_availability_events/{id}');
  assert.equal(functions.availabilityMidnight.options.timeZone,'America/Argentina/Buenos_Aires');
  assert.match(read('functions/index.js'),/require\("\.\/driver-availability-functions"\)\(\)/);
  assert.equal(fs.existsSync(new URL('../functions/driver-availability.js',import.meta.url)),false);
});

test('web release has no availability access or previews; historical collections deny client access',()=>{
  for(const file of HOSTING_FILES.filter(file=>/\.(html|js|css)$/.test(file))){
    assert.doesNotMatch(read(file),/driver[-_]availability|mountDriverAvailability|adminAvailabilityBtn|availabilityBootstrap|availabilitySavePhone|availabilityChange|av-numbers/,file);
  }
  for(const file of ['driver-availability.js','driver-availability.css','preview-disponibilidad.html','preview-numeros-perpetuos.html','preview-telegram-disponibilidad.html','tools/availability-preview.html']){
    assert.equal(fs.existsSync(new URL('../'+file,import.meta.url)),false,file);
  }
  const rules=read('firestore.rules');
  for(const collection of ['driver_availability','driver_availability_days']){
    const block=rules.match(new RegExp(`match /${collection}/\\{[^}]+\\} \\{([^}]+)\\}`));
    assert.ok(block,collection);
    assert.match(block[1],/allow read, write: if false;/);
    assert.doesNotMatch(block[1],/isAdmin|isActiveTeamViewer/);
  }
  assert.match(rules,/match \/\{document=\*\*\} \{\s*allow read, write: if false;/);
});

test('charge classification keeps all remis numbers and private option without retired styles',()=>{
  const container={innerHTML:'',querySelectorAll:()=>[],querySelector:()=>null};
  renderChargeRemisStep(container,{selection:{remisNumber:57,viajePrivado:false}});
  for(const n of REMIS_NUMBERS)assert.ok(container.innerHTML.includes(`data-charge-remis="${n}"`));
  assert.match(container.innerHTML,/data-charge-remis="57" aria-pressed="true"/);
  assert.match(container.innerHTML,/data-charge-private aria-pressed="false"/);
  assert.match(container.innerHTML,/class="charge-remis-numbers"/);
  assert.doesNotMatch(container.innerHTML,/\bav-/);
  renderChargeRemisStep(container,{selection:{remisNumber:null,viajePrivado:true}});
  assert.match(container.innerHTML,/data-charge-private aria-pressed="true"/);
  assert.doesNotMatch(container.innerHTML,/data-charge-remis="\d+" aria-pressed="true"/);
  assert.match(read('ops-salidas.css'),/\.charge-remis-numbers\{display:grid;grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
  assert.ok(read('index.html').includes('id="opsSalidasBoard"'),'Salidas de hoy retains its mount');
});
