import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
const extractFunction=name=>{
  const start=source.indexOf(`function ${name}(`);
  assert.ok(start>=0);
  return source.slice(start,source.indexOf('\n}',start)+2);
};
const control=(disabled=false)=>({disabled,dataset:{}});

test('guardar bloquea el cierre externo al formulario y restaura cada estado tras éxito o error',()=>{
  for(const finalState of ['success','failure']) {
    const field=control(),back=control(),alreadyDisabled=control(true),externalClose=control();
    let closes=0;
    externalClose.click=()=>{if(!externalClose.disabled)closes++;};
    const nodes={chargeForm:{querySelectorAll:()=>[field,back,alreadyDisabled]},chargeModal:{querySelectorAll:()=>[externalClose]}};
    const context=vm.createContext({$:id=>nodes[id]});
    vm.runInContext(extractFunction('setChargeFormBusy'),context);
    context.setChargeFormBusy(true);externalClose.click();
    assert.equal(closes,0,finalState);
    assert.ok([field,back,alreadyDisabled,externalClose].every(item=>item.disabled));
    context.setChargeFormBusy(false);externalClose.click();
    assert.equal(closes,1,finalState);
    assert.equal(field.disabled,false);assert.equal(back.disabled,false);assert.equal(externalClose.disabled,false);
    assert.equal(alreadyDisabled.disabled,true,'A disabled fiscal field must stay disabled');
    assert.ok([field,back,alreadyDisabled,externalClose].every(item=>item.dataset.chargeDisabledBeforeSave===undefined));
  }
});

test('abrir otro cobro durante un envío no resetea el formulario; vuelve a abrir al liberar el bloqueo',()=>{
  let open,resetCount=0,openedCount=0;
  const nodes=new Map();
  const $=id=>{
    if(!nodes.has(id))nodes.set(id,{value:'',dataset:{},disabled:false,classList:{toggle(){},remove(){if(id==='chargeModal')openedCount++;}},
      reset(){resetCount++;},focus(){}});
    return nodes.get(id);
  };
  const activeSubmissionLocks=new Set(['charge']);
  const context=vm.createContext({$,activeSubmissionLocks,
    document:{querySelectorAll:()=>[{dataset:{mode:'digital'},addEventListener:(_event,callback)=>{open=callback;}}]},
    refreshArcaBillingStatus(){},resetChargeRoute(){},syncChargeCustomerFields(){},clearPhotoPicker(){},
    renderChargeRemisStep(){},REMIS_NUMBERS:[],localDayKey:()=> '2026-10-23',showChargeStep(){},renderChargePreview(){}});
  const start=source.indexOf('document.querySelectorAll("[data-mode]").forEach(');
  assert.ok(start>=0);vm.runInContext(source.slice(start,source.indexOf('\n});',start)+4),context);
  $('chargeAmount').value='125000';$('saveChargeBtn').disabled=true;
  open();
  assert.equal(resetCount,0);assert.equal(openedCount,0);assert.equal($('chargeAmount').value,'125000');
  assert.equal($('saveChargeBtn').disabled,true,'Opening must not release a pending submit');
  activeSubmissionLocks.delete('charge');open();
  assert.equal(resetCount,1);assert.equal(openedCount,1);assert.equal($('saveChargeBtn').disabled,false);
});
