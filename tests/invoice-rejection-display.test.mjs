import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const source = app.slice(app.indexOf('function invoiceRejectionMessages('), app.indexOf('function renderInvoices()'));
function element(tag, className = '', textContent = '') {
  return {tag, className, textContent, children: [],
    append(...items) { this.children.push(...items); },
    get firstChild() { return this.children[0]; },
    addEventListener() { throw Error('No debe haber acciones de emisión o descarga en un rechazo'); }
  };
}
const context = vm.createContext({invoiceElement:element, invoiceDisplayDate:()=>null,
  invoiceStatusLabels:{rejected:'Rechazada'}, money:n=>String(n)});
vm.runInContext(source, context);
const all = node => [node, ...node.children.flatMap(all)];
const record = messages => ({status:'rejected', messages, issuer:{pointOfSale:3}, number:7, detail:{ImpTotal:100000}});

test('expone Observaciones WSFE, incluida una única Obs y errores de petición', () => {
  for (const messages of [{Obs:{Code:'10000',Msg:'Revisar condición del emisor'}},
    {Obs:[{Code:'10000',Msg:'Revisar condición del emisor'}]},
    [{code:'10000',message:'Revisar condición del emisor'}]]) {
    const nodes = all(context.createInvoiceCard(record(messages)));
    assert.ok(nodes.some(n=>n.textContent.includes('Código 10000: Revisar condición del emisor')));
    assert.ok(nodes.some(n=>n.textContent==='00003'));
    assert.ok(nodes.some(n=>n.textContent==='Número solicitado (sin autorización confirmada)'));
    assert.ok(nodes.some(n=>n.textContent==='Pendiente de emisión'));
    assert.equal(nodes.some(n=>n.tag==='button'),false);
  }
});
test('mensajes se tratan como texto, no como HTML, sin serializar otros datos del registro', () => {
  const nodes=all(context.createInvoiceCard(record({Obs:{Code:'42',Msg:'<img src=x onerror=alert(1)>',token:'NO_MOSTRAR'}})));
  const notice=nodes.find(n=>n.textContent.includes('Código 42:'));
  assert.ok(notice.textContent.includes('<img src=x onerror=alert(1)>'));
  assert.equal('innerHTML' in notice,false);
  assert.equal(nodes.some(n=>n.textContent.includes('NO_MOSTRAR')),false);
});
test('rechazos sin detalle siguen sin autorización y mensajes antiguos no contaminan otro estado', () => {
  const nodes=all(context.createInvoiceCard(record(null)));
  assert.ok(nodes.some(n=>n.textContent.includes('No hay un motivo detallado guardado')));
  assert.equal(context.invoiceRejectionMessages({status:'uncertain',messages:{Obs:{Msg:'Viejo'}}}).length,0);
  assert.equal(context.invoiceRejectionMessages(record({Obs:{Msg:'a'.repeat(1000)}}))[0].length,400);
});
