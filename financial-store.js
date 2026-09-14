// The UI may preview a balance, but only the callable transaction confirms it.
// This adapter keeps the existing forms, their stable receipt IDs and Firebase
// read semantics. It NEVER falls back to a direct financial write when offline.
import { ledgerComponentColor } from "./movement-colors.js?v=20260914-colors-login";

export const FINANCIAL_COLLECTIONS = new Set([
  'billing_records','gastos','uber_weekly_closures','cierres_semanales',
  'deudas_choferes','deuda_pagos','prestamos_operativos','deuda_movimientos'
]);
export function createFinancialStore({sdk,db,commit,onConfirmed=()=>{},onError=()=>{},newId=()=>crypto.randomUUID(),sleep=ms=>new Promise(r=>setTimeout(r,ms))}) {
  const financial=ref=>FINANCIAL_COLLECTIONS.has(String(ref.path || '').split('/')[0]);
  function encode(value) {
    if(value===undefined) throw new Error('Un campo del movimiento no tiene valor.');
    if(value===null || typeof value!=='object') return value;
    if(typeof value.toMillis==='function') return {$financialType:'timestamp',milliseconds:value.toMillis()};
    if(value._methodName==='serverTimestamp' || value.isEqual?.(sdk.serverTimestamp())) return {$financialType:'serverTimestamp'};
    if(value._methodName==='deleteField' || value.isEqual?.(sdk.deleteField())) return {$financialType:'delete'};
    if(value instanceof Date) return {$financialType:'timestamp',milliseconds:value.getTime()};
    if(Array.isArray(value)) return value.map(encode);
    return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,encode(item)]));
  }
  async function send(writes,reads=[],requestId=`fin_${newId()}`) {
    if(!writes.length) return {noop:true};
    if(writes.some(w=>!FINANCIAL_COLLECTIONS.has(w.path.split('/')[0]))) throw new Error('No se pueden mezclar escrituras financieras y generales.');
    const input={requestId,writes,reads};
    let last;
    for(let attempt=0;attempt<3;attempt++) {
      try {
        const response=await commit(input),data=response.data ?? response;
        if(data.ok!==true) throw new Error('El servidor no confirmó el movimiento.');
        // Rendering is not part of committing money: a UI exception must never
        // cause the caller to retry an already confirmed financial operation.
        try {onConfirmed(data);} catch(uiError) {console.error('No se pudo actualizar la vista del saldo confirmado',uiError);}
        return data;
      } catch(error) {
        last=error;
        if(!/^(functions\/)?(unavailable|deadline-exceeded|internal)$/.test(String(error.code || ''))) break;
        if(attempt<2) await sleep(250*(attempt+1));
      }
    }
    onError(last);throw last;
  }
  async function setDoc(ref,data,options) {
    if(!financial(ref)) return sdk.setDoc(ref,data,options);
    if(options && Object.keys(options).some(key=>key!=='merge')) throw new Error('Opción de escritura no admitida.');
    return send([{path:ref.path,kind:'set',data:encode(data),merge:options?.merge===true}]);
  }
  async function addDoc(ref,data) {
    if(!financial(ref)) return sdk.addDoc(ref,data);
    const target=sdk.doc(ref);
    await send([{path:target.path,kind:'create',data:encode(data)}]);
    return target;
  }
  async function runTransaction(database,handler,options) {
    for(let attempt=0;attempt<5;attempt++) {
      const writes=[],reads=[],snapshots=new Map();
      const stage=(kind,ref,data,settings)=>{
        writes.push({path:ref.path,kind,...(data===undefined?{}:{data:encode(data)}),...(settings?{merge:settings.merge===true}:{})});
        return transaction;
      };
      const transaction={
        get:async ref=>{
          if(snapshots.has(ref.path)) return snapshots.get(ref.path);
          const snap=await sdk.getDocFromServer(ref);
          snapshots.set(ref.path,snap);
          reads.push({path:ref.path,exists:snap.exists(),revision:Number(snap.data()?.financialRevision || 0)});
          return snap;
        },
        set:(ref,data,settings)=>stage('set',ref,data,settings),
        update:(ref,data)=>stage('update',ref,data),
        delete:ref=>stage('delete',ref)
      };
      const result=await handler(transaction);
      if(!writes.length) return result;
      if(writes.every(w=>!FINANCIAL_COLLECTIONS.has(w.path.split('/')[0]))) return sdk.runTransaction(database,handler,options);
      try {await send(writes,reads);return result;}
      catch(error) {
        if(!/^(functions\/)?aborted$/.test(String(error.code || '')) || attempt===4) throw error;
        await sleep(50*(attempt+1));
      }
    }
  }
  function writeBatch(database) {
    const pending=[];
    const batch={
      set:(ref,data,options)=>{pending.push({kind:'set',ref,data,options});return batch;},
      update:(ref,data)=>{pending.push({kind:'update',ref,data});return batch;},
      delete:ref=>{pending.push({kind:'delete',ref});return batch;},
      commit:async()=>{
        if(!pending.some(w=>financial(w.ref))) {
          const native=sdk.writeBatch(database);
          for(const w of pending) {
            if(w.kind==='delete') native.delete(w.ref);
            else if(w.kind==='update') native.update(w.ref,w.data);
            else if(w.options) native.set(w.ref,w.data,w.options); else native.set(w.ref,w.data);
          }
          return native.commit();
        }
        return send(pending.map(w=>({path:w.ref.path,kind:w.kind,...(w.data===undefined?{}:{data:encode(w.data)}),merge:w.options?.merge===true})));
      }
    };
    return batch;
  }
  return {setDoc,addDoc,runTransaction,writeBatch,encode};
}

export function ledgerReceiptRows(entries=[]) {
  return entries.flatMap(entry=>(entry.components || []).map(component=>({
    id:`ledger_${entry.id}_${component.index}`,
    type:component.type || 'ledger_receipt',method:component.method || 'ledger',
    service:component.title,amount:component.amount,detail:entry.detail || '',proofUrl:entry.proofUrl || '',proofPath:entry.proofPath || '',
    settlementRuleVersion:entry.settlementRuleVersion || '',
    createdAtMs:entry.createdAtMs,financialSequence:entry.sequence,financialComponentIndex:component.index,
    financialConfirmedReceipt:true,financialEntryId:entry.id,
    visualMovementColor:ledgerComponentColor(component, entry),
    confirmedBefore:component.before,confirmedAfter:component.after,
    _receiptGroupKey:`ledger:${entry.id}`,_sortPriority:100-Number(component.index || 0)
  })));
}
