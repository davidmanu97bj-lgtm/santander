import test from 'node:test';
import assert from 'node:assert/strict';
import {fleetSourceAmount,fleetInvoicePreviewText} from '../uber-fleet-ui.js';
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
