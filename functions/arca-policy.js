'use strict';
// This module selects a fiscal series, never a driver's settlement percentage.
const DOMESTIC_EXEMPT_POLICY = 'domestic_taxi_exempt_up_to_100km_v1';
const INTERNATIONAL_EXEMPT_POLICY = 'international_passenger_transport_exempt_v1';
function configuredInvoiceType(config) {
  if (config?.regime === 'monotributo') return 11;
  if (config?.regime === 'iva_exento' && config.invoiceType === 11) return 11;
  if (config?.regime === 'general' && config.invoiceType === 6) return 6;
  return 0;
}
function approvedDriversConfigured(config) {
  return Array.isArray(config?.approvedDriverUids) && config.approvedDriverUids.length > 0 &&
    config.approvedDriverUids.every(uid => typeof uid === 'string' && uid.trim().length > 0);
}
function generalPolicyReady(config) {
  return configuredInvoiceType(config) === 6 && config.taxPolicy === DOMESTIC_EXEMPT_POLICY &&
    config.domesticTaxiExemptionVerified === true && approvedDriversConfigured(config);
}
function explicitTimestamp(value) {
  // A date-only value is interpreted as UTC and would shift Argentina's legal
  // effective day backwards. Configuration must record the actual instant.
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value))return NaN;
  const day=value.slice(0,10),calendar=Date.parse(day+'T00:00:00Z'),instant=Date.parse(value);
  return Number.isFinite(calendar)&&new Date(calendar).toISOString().slice(0,10)===day?instant:NaN;
}
function ivaExemptPolicyReady(config) {
  const effective = explicitTimestamp(config?.regimeEffectiveFrom), active = explicitTimestamp(config?.activeFrom);
  return config?.regime === 'iva_exento' && configuredInvoiceType(config) === 11 &&
    config.ivaExemptRegistrationVerified === true && Number.isFinite(effective) && Number.isFinite(active) && active >= effective &&
    config.taxPolicy === DOMESTIC_EXEMPT_POLICY && config.domesticTaxiExemptionVerified === true && approvedDriversConfigured(config);
}
function ivaExemptActive(config, now = new Date()) {
  return ivaExemptPolicyReady(config) && Date.parse(config.regimeEffectiveFrom) <= Number(now) && Date.parse(config.activeFrom) <= Number(now);
}
function invoiceAEnabled(config) {
  return generalPolicyReady(config) && config.invoiceAEnabled === true &&
    (config.environment === 'homologation' || config.invoiceAHomologationPassed === true ||
      (config.invoiceAProductionVerified === true && typeof config.invoiceAVerificationPaymentId === 'string' && config.invoiceAVerificationPaymentId.length > 0));
}
function enabledInvoiceTypes(config) {
  const base = configuredInvoiceType(config);
  return invoiceAEnabled(config) ? [base, 1] : [base];
}
function internationalBEnabled(config,now=new Date()) {
  const cutoff=Date.parse(config.internationalActiveFrom||'');
  return generalPolicyReady(config) && config.internationalInvoiceType===6 &&
    config.internationalTaxPolicy===INTERNATIONAL_EXEMPT_POLICY && config.internationalTransportExemptionVerified===true &&
    Number.isFinite(cutoff) && cutoff<=Number(now);
}
function internationalExemptCEnabled(config, now = new Date()) {
  const cutoff = explicitTimestamp(config?.internationalActiveFrom);
  return ivaExemptActive(config, now) && config.internationalInvoiceType === 11 &&
    config.internationalTaxPolicy === INTERNATIONAL_EXEMPT_POLICY && config.internationalTransportExemptionVerified === true &&
    Number.isFinite(cutoff) && cutoff >= Date.parse(config.regimeEffectiveFrom) && cutoff <= Number(now);
}
function invoiceTypeOf(invoice) {
  // Historical C snapshots predate invoiceType. Never read the current regime here.
  return invoice.invoiceType === undefined ? 11 : Number(invoice.invoiceType);
}
function pointMatches(point, config) {
  if (Number(point.Nro) !== Number(config.pointOfSale) || point.Bloqueado !== 'N' ||
      (point.FchBaja && point.FchBaja !== 'NULL')) return false;
  const type = String(point.EmisionTipo || '');
  if (config.regime === 'iva_exento') {
    // C issued by an IVA-exempt taxpayer uses its own WSFE point, not the old
    // monotributo C point. Keep the exact label returned by the activation preflight.
    return ivaExemptPolicyReady(config) && typeof config.pointEmissionType === 'string' &&
      /^CAE\s*-\s*Exento(?:\s+(?:en\s+)?IVA)?$/i.test(config.pointEmissionType) && type === config.pointEmissionType;
  }
  if (configuredInvoiceType(config) === 11) return type.includes('Monotributo');
  // Match the exact WSFE type recorded during the activation preflight.
  return generalPolicyReady(config) && typeof config.pointEmissionType === 'string' &&
    config.pointEmissionType === 'CAE - Ri Iva' &&
    type === config.pointEmissionType;
}
module.exports = {DOMESTIC_EXEMPT_POLICY, INTERNATIONAL_EXEMPT_POLICY, configuredInvoiceType, generalPolicyReady, ivaExemptPolicyReady, ivaExemptActive, invoiceAEnabled, enabledInvoiceTypes, internationalBEnabled, internationalExemptCEnabled, invoiceTypeOf, pointMatches};
