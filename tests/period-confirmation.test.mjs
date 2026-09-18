import test from 'node:test';
import assert from 'node:assert/strict';
import {mountPeriodClose} from '../period-ui.js';
function setup({uploadProof=async()=> 'proof/test.png',confirmClose=async()=>{}}={}){
 const nodes=new Map();
 const get=id=>{
  if(!nodes.has(id)){
   const classes=new Set(['hidden']);
   nodes.set(id,{disabled:false,value:'',files:[],textContent:'',innerHTML:'',handlers:{},
    classList:{add:c=>classes.add(c),remove:c=>classes.delete(c),contains:c=>classes.has(c)},
    setAttribute(){},focus(){},addEventListener(type,fn){this.handlers[type]=fn;},
    querySelector(){return get('label');},querySelectorAll(){return [];}});
  }
  return nodes.get(id);
 };
 globalThis.document={getElementById:get};
 const quote={quoteId:'test',balance:60,amount:60,summary:{cash:100,digital:0,netCash:100,netDigital:0,cashExpense:0,digitalExpense:0,gross:100,cashbox:10,walletDifference:50,debtRows:[],externalDebt:0,responsibilityAdjustment:0,previousBalance:0}};
 const controller=mountPeriodClose({getQuote:async()=>quote,uploadProof,confirmClose,showScreen(){}});
 const click=id=>get(id).handlers.click();
 const upload=()=>{const target=get('periodReceiptFile');target.files=[{name:'proof.png',size:100,type:'image/png'}];return target.handlers.change({target});};
 return {get,controller,click,upload};
}
test('cargar comprobante no cierra; aceptar es obligatorio y cancelar descarta la aceptación',async()=>{
 let calls=0;const ui=setup({confirmClose:async()=>{calls++;}});
 await ui.controller.open();await ui.click('confirmPeriodClose');
 assert.equal(ui.get('acceptPeriodReceipt').disabled,true);
 await ui.click('acceptPeriodReceipt');assert.equal(calls,0);
 await ui.upload();assert.equal(calls,0);assert.equal(ui.get('acceptPeriodReceipt').disabled,false);
 await ui.click('cancelPeriodReceipt');await ui.click('confirmPeriodClose');
 assert.equal(ui.get('acceptPeriodReceipt').disabled,true);
 await ui.click('acceptPeriodReceipt');assert.equal(calls,0);
 await ui.upload();await ui.click('acceptPeriodReceipt');assert.equal(calls,1);
});
test('carga fallida no habilita aceptar; doble toque confirma una sola vez',async()=>{
 const failed=setup({uploadProof:async()=>{throw Error('fallo');}});
 await failed.controller.open();await failed.upload();assert.equal(failed.get('acceptPeriodReceipt').disabled,true);
 let calls=0,release;const pending=new Promise(resolve=>release=resolve);
 const ui=setup({confirmClose:async()=>{calls++;await pending;}});
 await ui.controller.open();await ui.upload();
 const first=ui.click('acceptPeriodReceipt');await ui.click('acceptPeriodReceipt');
 assert.equal(calls,1);assert.equal(ui.get('acceptPeriodReceipt').disabled,true);
 release();await first;
});
