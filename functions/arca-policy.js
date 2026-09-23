'use strict';
// This module selects a fiscal series, never a driver's settlement percentage.
const DOMESTIC_EXEMPT_POLICY = 'domestic_taxi_exempt_up_to_100km_v1';
function configuredInvoiceType(config) {
  if (config?.regime === 'monotributo') return 11;
  if (config?.regime === 'general' && config.invoiceType === 6) return 6;
  return 0;
}
function generalPolicyReady(config) {
  return configuredInvoiceType(config) === 6 && config.taxPolicy === DOMESTIC_EXEMPT_POLICY &&
    config.domesticTaxiExemptionVerified === true;
}
function invoiceTypeOf(invoice) {
  // Historical C snapshots predate invoiceType. Never read the current regime here.
  return invoice.invoiceType === undefined ? 11 : Number(invoice.invoiceType);
}
function pointMatches(point, config) {
  if (Number(point.Nro) !== Number(config.pointOfSale) || point.Bloqueado !== 'N' ||
      (point.FchBaja && point.FchBaja !== 'NULL')) return false;
  const type = String(point.EmisionTipo || '');
  if (configuredInvoiceType(config) === 11) return type.includes('Monotributo');
  // Match the exact WSFE type recorded during the activation preflight.
  return generalPolicyReady(config) && typeof config.pointEmissionType === 'string' &&
    config.pointEmissionType === 'CAE - Ri Iva' &&
    type === config.pointEmissionType;
}
module.exports = {DOMESTIC_EXEMPT_POLICY, configuredInvoiceType, generalPolicyReady, invoiceTypeOf, pointMatches};
