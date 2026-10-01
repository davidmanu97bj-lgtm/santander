import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
const start=source.indexOf('function syncChargeCustomerFields()');
const code=source.slice(start,source.indexOf('\n}',start)+2);
test('Factura A exige CUIT; B nominada y datos pendientes no se convierten automáticamente en A',()=>{
  const fields=new Map();const $=id=>{if(!fields.has(id))fields.set(id,{value:'',checked:false,classList:{toggle(){}},setAttribute(){}});return fields.get(id);};
  const context=vm.createContext({$});vm.runInContext(code,context);
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
