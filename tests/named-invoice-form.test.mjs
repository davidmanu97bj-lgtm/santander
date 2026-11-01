import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
const start=source.indexOf('function syncChargeCustomerFields()');
const code=source.slice(start,source.indexOf('\n}',start)+2);
test('Factura A exige CUIT; B nominada y datos pendientes no se convierten automáticamente en A',()=>{
  const fields=new Map();const $=id=>{if(!fields.has(id))fields.set(id,{value:'',checked:false,classList:{toggle(){}},setAttribute(){}});return fields.get(id);};
  const context=vm.createContext({$,arcaBillingDisplay:{regime:'general'}});vm.runInContext(code,context);
  $('chargeNamedInvoice').checked=true;
  for(const condition of ['registered','monotributo']) {
    $('chargeCustomerVat').value=condition;context.syncChargeCustomerFields();
    assert.equal($('chargeCustomerDocType').value,'CUIT');assert.equal($('chargeCustomerDocType').disabled,true);
    assert.match($('chargeCustomerInvoiceHint').textContent,/Factura A/);
  }
  $('chargeCustomerVat').value='consumer';context.syncChargeCustomerFields();
  assert.equal($('chargeCustomerDocType').disabled,false);assert.match($('chargeCustomerInvoiceHint').textContent,/Factura B/);
  $('chargeCustomerVat').value='';context.syncChargeCustomerFields();assert.match($('chargeCustomerInvoiceHint').textContent,/Confirmá/);
  $('chargeNamedInvoice').checked=false;context.syncChargeCustomerFields();assert.equal($('chargeCustomerVat').required,false);
});

test('IVA exento emite C para todos los receptores y conserva identificación fiscal',()=>{
  const fields=new Map();const $=id=>{if(!fields.has(id))fields.set(id,{value:'',checked:false,classList:{toggle(){}},setAttribute(){}});return fields.get(id);};
  const context=vm.createContext({$,arcaBillingDisplay:{regime:'iva_exento'}});vm.runInContext(code,context);
  $('chargeNamedInvoice').checked=true;
  for(const condition of ['registered','monotributo','exempt','consumer']){
    $('chargeCustomerVat').value=condition;context.syncChargeCustomerFields();
    assert.match($('chargeCustomerInvoiceHint').textContent,/IVA exento.*Factura C/);
    assert.doesNotMatch($('chargeCustomerInvoiceHint').textContent,/Factura [AB]/);
    if(condition!=='consumer')assert.equal($('chargeCustomerDocType').value,'CUIT');
    assert.equal($('chargeCustomerDocType').disabled,condition!=='consumer');
    assert.equal($('chargeCustomerName').required,true);assert.equal($('chargeCustomerDoc').required,true);
  }
  $('chargeCustomerVat').value='pending';context.syncChargeCustomerFields();
  assert.match($('chargeCustomerInvoiceHint').textContent,/Confirmá/);
  assert.doesNotMatch($('chargeCustomerInvoiceHint').textContent,/Factura C/);
});

test('mientras no se verificó el emisor no promete A/B y las opciones no fijan una clase',()=>{
  const fields=new Map();const $=id=>{if(!fields.has(id))fields.set(id,{value:'',checked:false,classList:{toggle(){}},setAttribute(){}});return fields.get(id);};
  const context=vm.createContext({$,arcaBillingDisplay:null});vm.runInContext(code,context);
  $('chargeNamedInvoice').checked=true;$('chargeCustomerVat').value='registered';context.syncChargeCustomerFields();
  assert.match($('chargeCustomerInvoiceHint').textContent,/verificar la condición/);
  assert.doesNotMatch($('chargeCustomerInvoiceHint').textContent,/Factura [ABC]/);
  const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
  assert.doesNotMatch(html.match(/<select id="chargeCustomerVat"[^>]*>([\s\S]*?)<\/select>/)[1],/Factura [ABC]/);
});

function declaration(name){
  const start=source.search(new RegExp(`^(?:async )?function ${name}\\(`,'m'));
  return source.slice(start,source.indexOf('\n}',start)+2);
}
test('estado fiscal actualiza formulario, falla sin prometer y descarta respuesta de otra sesión',async()=>{
  const fields=new Map();const $=id=>{if(!fields.has(id))fields.set(id,{textContent:''});return fields.get(id);};
  let response={enabled:true,environment:'production',regime:'iva_exento'};
  const context=vm.createContext({$,auth:{currentUser:{uid:'driver'}},authGeneration:1,arcaBillingDisplay:null,
    cachedArcaStatus:async()=>response,syncChargeCustomerFields:()=>{context.synced=(context.synced||0)+1;}});
  vm.runInContext(declaration('refreshArcaBillingStatus'),context);
  await context.refreshArcaBillingStatus();assert.match($('arcaModeLabel').textContent,/Factura C/);
  assert.match($('arcaModeNote').textContent,/IVA exento/);assert.equal(context.arcaBillingDisplay.regime,'iva_exento');assert.equal(context.synced,1);
  context.cachedArcaStatus=async()=>{throw Error('offline');};await context.refreshArcaBillingStatus();
  assert.equal(context.arcaBillingDisplay,null);assert.equal($('arcaModeLabel').textContent,'Por verificar');
  context.cachedArcaStatus=async()=>{context.authGeneration++;return response;};await context.refreshArcaBillingStatus();
  assert.equal(context.arcaBillingDisplay,null);assert.equal(context.synced,2);
  assert.match(source,/arcaStatusCache=null;arcaBillingDisplay=null;/);
});
