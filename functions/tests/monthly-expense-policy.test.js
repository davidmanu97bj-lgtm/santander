'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const expensePolicy = require('../expense-policy');
const periodPolicy = require('../period-policy');
const {calculateTeamRealtimeSettlementBalance, calculateOpenBillingBalance} = require('../telegram-billing-balance');
const {quoteFromInput} = require('../period-closure');

const allocations = [
  {typeId:'canon', group:'driver', rate:0, expected:100000},
  {typeId:'canon_compartido', group:'shared', rate:.5, expected:50000},
  {typeId:'patente', group:'shared', rate:.5, expected:50000},
  {typeId:'patente_chofer', group:'driver', rate:0, expected:100000}
];

test('canon y patente conservan sus repartos históricos y ofrecen variantes sólo administrativas', () => {
  for (const {typeId, group, rate} of allocations) {
    const type = expensePolicy.find(typeId);
    assert.equal(type.group, group, typeId);
    assert.equal(type.refundRate, rate, typeId);
    assert.equal(expensePolicy.refundRate({expenseType:typeId, receiptFlowVersion:expensePolicy.version}), rate, typeId);
    assert.equal(expensePolicy.netDriverRate({expenseType:typeId, receiptFlowVersion:expensePolicy.version}), 1-rate, typeId);
    assert.equal(expensePolicy.driverAllowedTypes.includes(typeId), false, typeId);
  }
  assert.equal(expensePolicy.refundRate({expenseType:'canon'}), .5, 'el esquema anterior a v3 conserva su reintegro');
  assert.equal(expensePolicy.netDriverRate({expenseType:'canon', receiptFlowVersion:'gross_expense_driver_debit_50_v2'}), .5);
});

test('ambos conceptos pagados por Explora cargan una sola vez 50% o 100% al chofer en saldo, aviso y cierre', async () => {
  const {buildAdminDigitalExpense} = await import('../../admin-digital-expense.js');
  for (const {typeId, group, rate, expected} of allocations) {
    const row = buildAdminDigitalExpense({
      driver:{id:'chofer-prueba', name:'Chofer de prueba'}, actor:{uid:'admin-prueba', name:'Administrador'},
      amount:100000, detail:'Gasto mensual', typeId,
      proofUrl:'https://example.test/comprobante.pdf', proofPath:'gastos/chofer-prueba/operacion/comprobante.pdf',
      file:{name:'comprobante.pdf', type:'application/pdf'}, operation:{operationId:typeId, createdAtMs:10000},
      fingerprint:'test', businessId:'explora', dayKey:'2026-10-01'
    }, expensePolicy, periodPolicy);
    row.id = typeId;
    const input = {records:[], expenses:[row], uberWeeks:[], closures:[], debts:[]};
    assert.equal(row.payerRole, 'explora', typeId);
    assert.equal(row.expensePaymentMethod, 'digital', typeId);
    assert.equal(row.reimbursementRate, rate, typeId);
    assert.equal(row.billingImpactAmount, expected, typeId);
    assert.equal(calculateTeamRealtimeSettlementBalance(input).balance, expected, typeId);
    assert.equal(calculateOpenBillingBalance(input).netToDriver, -expected, typeId);
    const quote = quoteFromInput('chofer-prueba', input);
    assert.equal(quote.balance, expected, typeId);
    assert.equal(quote.summary.netDigital, -100000, typeId);
    assert.equal(quote.summary.cashbox, 0, 'el gasto no genera caja chica');
    assert.equal(quote.summary.responsibilityAdjustment, group==='driver' ? 50000 : 0, typeId);
    assert.equal(quote.summary.previousBalance, 0, typeId);
    assert.equal(quote.summary.debtRows.length, group==='driver' ? 1 : 0, typeId);
    assert.equal(calculateTeamRealtimeSettlementBalance({...input, expenses:[{...row, deleted:true}]}).balance, 0, 'anular revierte el cargo');
  }
});
