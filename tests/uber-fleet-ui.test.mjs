import test from 'node:test';
import assert from 'node:assert/strict';
import {fleetSourceAmount,fleetInvoicePreviewText,fleetDigitalRecipient,fleetAutomationText} from '../uber-fleet-ui.js';

test('automation cannot claim connected, complete or financial activity without verified evidence',()=>{
  assert.match(fleetAutomationText({enabled:false,lastSuccessAtMs:1}),/Inactiva/);
  assert.match(fleetAutomationText({enabled:true}),/Todavía no hay una consulta exitosa/);
  assert.match(fleetAutomationText({enabled:true,recoveryRequired:true,lastSuccessAtMs:1}),/No se considera conciliado/);
  assert.match(fleetAutomationText({enabled:true,lastSuccessAtMs:Date.parse('2026-09-29T15:00:00Z')}),/No registra movimientos financieros/);
});

test('confirmed recipient is used only for new mappings; explicit historical choices are preserved',()=>{
  assert.equal(fleetDigitalRecipient({},'explora'),'explora');
  assert.equal(fleetDigitalRecipient({digitalRecipient:'driver'},'explora'),'driver');
  assert.equal(fleetDigitalRecipient({digitalRecipient:'unknown'},'explora'),'unknown');
  assert.equal(fleetDigitalRecipient({}),'unknown');
});
test('comparison preserves source currency and never disguises unknown or USD amounts as ARS',()=>{
  assert.equal(fleetSourceAmount(12500,'USD'),'125,00 USD');
  assert.equal(fleetSourceAmount(12500,null),'125,00 (moneda por confirmar)');
  assert.equal(fleetSourceAmount(null,'ARS'),'Sin confirmar');
  assert.match(fleetInvoicePreviewText({amountCents:12500,currency:'USD'}),/125,00 USD/);
  assert.doesNotMatch(fleetInvoicePreviewText({amountCents:12500,currency:'USD'}),/ARS|al centro/i);
});
test('invoice preview describes only supplied route, never invents destination or fiscal authorization',()=>{
  const missing=fleetInvoicePreviewText({amountCents:1000000,currency:'ARS',serviceDate:'2026-09-28'});
  assert.match(missing,/Recorrido pendiente/);assert.match(missing,/Sin emisión ni validez fiscal/);
  const known=fleetInvoicePreviewText({amountCents:1000000,currency:'ARS',route:{origin:'Hotel de prueba',destination:'Aeropuerto de prueba'}});
  assert.match(known,/Hotel de prueba → Aeropuerto de prueba/);assert.doesNotMatch(known,/IVA exento|CAE|autorizad/i);
});
