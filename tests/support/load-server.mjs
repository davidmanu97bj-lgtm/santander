// Load the actual server handlers with an injected database and no live services.
// This deliberately does NOT pretend to be an emulator or test SDK serialization.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {Timestamp,FieldValue,Filter,HttpsError} from './settlement-memory.mjs';
const base=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../functions');
export function loadServer(db,{now=Date.now()}={}) {
  const cache=new Map();
  const noLive=()=>{throw new Error('LIVE_SERVICE_FORBIDDEN_IN_TEST');};
  const services={
    'firebase-functions/v2/https':{onCall:(_options,fn)=>fn,HttpsError},
    'firebase-functions/v2/firestore':{onDocumentCreated:(_options,fn)=>fn,onDocumentWritten:(_options,fn)=>fn},
    'firebase-functions/v2/scheduler':{onSchedule:(_options,fn)=>fn},
    'firebase-functions/params':{defineSecret:()=>({value:()=>''})},
    'firebase-admin/app':{initializeApp:()=>{}},
    'firebase-admin/firestore':{getFirestore:()=>db,Timestamp,FieldValue,Filter,FieldPath:{documentId:()=> '__name__'}},
    'firebase-admin/auth':{getAuth:()=>({getUser:noLive})},
    'firebase-admin/storage':{getStorage:()=>({bucket:()=>({file:noLive})})}
  };
  class TestDate extends Date {constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
  function load(filename) {
    filename=path.resolve(filename);if(cache.has(filename))return cache.get(filename).exports;
    const module={exports:{}};cache.set(filename,module);
    const native=createRequire(filename);
    const localRequire=name=>{
      if(services[name])return services[name];
      if(name==='./arca-pdf')return {invoicePdf:noLive};
      if(name==='./arca-functions')return ()=>({}); // Unrelated fiscal integration has its own tests.
      if(name.startsWith('./') || name.startsWith('../')) {
        const full=native.resolve(name);return full.endsWith('.js')?load(full):native(name);
      }
      return native(name);
    };
    const context={module,exports:module.exports,require:localRequire,__filename:filename,__dirname:path.dirname(filename),
      console,Date:TestDate,Buffer,process,URL,URLSearchParams,Intl,setTimeout,clearTimeout,fetch:noLive};
    vm.runInNewContext(fs.readFileSync(filename,'utf8'),context,{filename});
    return module.exports;
  }
  return {handlers:load(path.join(base,'index.js')),load:name=>load(path.join(base,name))};
}
