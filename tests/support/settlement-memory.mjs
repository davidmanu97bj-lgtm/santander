// Deterministic optimistic-transaction test double. This is not the Firebase
// emulator: the live SDK/security-rules integration needs the emulator test too.
export class Timestamp {
  constructor(ms){this.ms=ms;}
  static fromMillis(ms){return new Timestamp(ms);}
  static now(){return new Timestamp(Date.now());}
  toMillis(){return this.ms;}
  toDate(){return new Date(this.ms);}
}
class Transform {constructor(kind,operand){this.kind=kind;this.operand=operand;}isEqual(other){return other?.kind===this.kind;}}
export const FieldValue={serverTimestamp:()=>new Transform('timestamp'),delete:()=>new Transform('delete')};
export const Filter={where:(field,op,value)=>({field,op,value}),or:(...filters)=>({or:filters})};
export class HttpsError extends Error {constructor(code,message,details){super(message);this.code=code;this.details=details;}}
const clone=x=>x instanceof Timestamp?Timestamp.fromMillis(x.ms):Array.isArray(x)?x.map(clone):x&&typeof x==='object'?Object.fromEntries(Object.entries(x).map(([k,v])=>[k,clone(v)])):x;
const matches=(row,f)=>!f?true:f.or?f.or.some(child=>matches(row,child)):row[f.field]===f.value;
export function memoryDatabase() {
  const data=new Map(),versions=new Map(),collectionVersions=new Map(),commits=[];
  let next=0,retries=0;
  function ref(path) {return {path,id:path.split('/').at(-1),get:()=>Promise.resolve(snapshot(path)),
    set:async row=>{put(path,row);},delete:async()=>{put(path,null);}};}
  function snapshot(path) {const value=data.get(path);return {id:path.split('/').at(-1),ref:ref(path),exists:data.has(path),data:()=>value===undefined?undefined:clone(value)};}
  function put(path,row) {
    if(row===null)data.delete(path);else data.set(path,clone(row));
    versions.set(path,(versions.get(path)||0)+1);
    const collection=path.split('/')[0];collectionVersions.set(collection,(collectionVersions.get(collection)||0)+1);
  }
  function query(collection,filter=null,maximum=Infinity) {
    const target={path:collection,collection,filter,maximum};
    target.doc=id=>ref(`${collection}/${id || `auto${++next}`}`);
    target.where=(field,op,value)=>query(collection,typeof field==='string'?Filter.where(field,op,value):field,maximum);
    target.limit=n=>query(collection,filter,n);
    target.get=async()=>querySnapshot(target);
    return target;
  }
  function querySnapshot(target,onRead=()=>{}) {
    const docs=[...data.keys()].filter(path=>path.split('/')[0]===target.collection && matches(data.get(path),target.filter)).sort()
      .slice(0,target.maximum ?? Infinity).map(path=>{onRead(path);return snapshot(path);});
    return {docs,size:docs.length,empty:!docs.length};
  }
  const db={data,commits,put,get retries(){return retries;},doc:ref,
    getAll:async(...refs)=>refs.map(r=>snapshot(r.path)),
    collection:name=>query(name),
    async runTransaction(fn) {
      for(let attempt=0;attempt<30;attempt++) {
        const reads=new Map(),queries=new Map(),writes=[];
        const tx={get:async target=>{
          if(writes.length)throw new Error('READ_AFTER_WRITE');
          await Promise.resolve();
          if(target.collection) {
            queries.set(target.collection,collectionVersions.get(target.collection)||0);
            return querySnapshot(target,path=>reads.set(path,versions.get(path)||0));
          }
          reads.set(target.path,versions.get(target.path)||0);return snapshot(target.path);
        },set:(r,d,options)=>writes.push({kind:'set',path:r.path,data:d,options}),
        create:(r,d)=>writes.push({kind:'create',path:r.path,data:d}),
        update:(r,d)=>writes.push({kind:'update',path:r.path,data:d}),
        delete:r=>writes.push({kind:'delete',path:r.path})};
        const result=await fn(tx);
        await Promise.resolve();
        if([...reads].some(([path,version])=>(versions.get(path)||0)!==version)
          || [...queries].some(([name,version])=>(collectionVersions.get(name)||0)!==version)) {retries++;continue;}
        for(const w of writes) {
          if(w.kind==='create'&&data.has(w.path))throw new HttpsError('already-exists','exists');
          if(w.kind==='update'&&!data.has(w.path))throw new HttpsError('not-found','missing');
        }
        for(const w of writes)put(w.path,w.kind==='delete'?null:w.kind==='update'||w.options?.merge?{...data.get(w.path),...w.data}:w.data);
        commits.push({reads:[...reads.keys()],queries:[...queries.keys()],writes:writes.map(w=>w.path)});
        return result;
      }
      throw new HttpsError('aborted','Too much contention in test');
    }};
  return db;
}
