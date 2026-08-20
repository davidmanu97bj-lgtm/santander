"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { calculateOpenBillingBalance } = require("../telegram-billing-balance");

function record(id, amount, paymentMethod, createdAtMs, extra = {}) {
  return { id, amount, paymentMethod, createdAtMs, ...extra };
}

test("un cobro en efectivo deja al chofer debiendo su mitad", () => {
  const balance = calculateOpenBillingBalance({
    records: [record("cash-1", 100000, "cash", 1000)]
  });
  assert.equal(balance.cash, 100000);
  assert.equal(balance.digital, 0);
  assert.equal(balance.amountFromDriver, 50000);
  assert.equal(balance.amountToDriver, 0);
});

test("cada cobro digital compensa la mitad que corresponde al chofer", () => {
  const balance = calculateOpenBillingBalance({
    records: [
      record("cash-1", 100000, "cash", 1000),
      record("digital-1", 20000, "card", 2000)
    ]
  });
  assert.equal(balance.amountFromDriver, 40000);
  assert.equal(balance.amountToDriver, 0);
});

test("cambia a Explora como pagador cuando el digital supera al efectivo", () => {
  const balance = calculateOpenBillingBalance({
    records: [
      record("cash-1", 100000, "cash", 1000),
      record("digital-1", 120000, "transfer", 2000)
    ]
  });
  assert.equal(balance.amountFromDriver, 0);
  assert.equal(balance.amountToDriver, 10000);
});

test("solo suma movimientos posteriores al último cierre de facturación", () => {
  const balance = calculateOpenBillingBalance({
    records: [
      record("cash-before", 100000, "cash", 1000),
      record("digital-after", 20000, "qr", 2000)
    ],
    closures: [{
      closureMode: "on_demand",
      closureKind: "chofer",
      cutoffAtMs: 1500,
      status: "closed"
    }]
  });
  assert.equal(balance.cutoffMs, 1500);
  assert.equal(balance.cash, 0);
  assert.equal(balance.digital, 20000);
  assert.equal(balance.amountToDriver, 10000);
});

test("un cierre rechazado no corta el período", () => {
  const balance = calculateOpenBillingBalance({
    records: [record("cash-1", 100000, "cash", 1000)],
    closures: [{
      closureMode: "rejected_on_demand",
      closureKind: "chofer",
      cutoffAtMs: 1500,
      status: "rejected",
      rejected: true
    }]
  });
  assert.equal(balance.cutoffMs, 0);
  assert.equal(balance.amountFromDriver, 50000);
});

test("ignora cobros borrados y simulados", () => {
  const balance = calculateOpenBillingBalance({
    records: [
      record("cash-real", 100000, "cash", 1000),
      record("cash-deleted", 80000, "cash", 2000, { deleted: true }),
      record("digital-sim", 300000, "card", 3000, { isSimulated: true })
    ]
  });
  assert.equal(balance.includedCount, 1);
  assert.equal(balance.amountFromDriver, 50000);
});

test("el pago del chofer reduce Facturación sin contarse como un nuevo cobro", () => {
  const balance = calculateOpenBillingBalance({
    records: [
      record("cash-1", 20000, "cash", 1000),
      record("billing-payment-1", 10000, "transfer", 2000, {
        type:"admin_billing_settlement_payment",
        sourceModule:"facturacion",
        affectsBillingSettlement:true,
        excludeFromBillingGross:true
      })
    ]
  });
  assert.equal(balance.cash, 20000);
  assert.equal(balance.digital, 0);
  assert.equal(balance.gross, 20000);
  assert.equal(balance.settlementPaymentCount, 1);
  assert.equal(balance.settlementPaymentTotal, 10000);
  assert.equal(balance.netBeforePayments, -10000);
  assert.equal(balance.amountFromDriver, 0);
  assert.equal(balance.amountToDriver, 0);
});

test("un pago de Facturación anterior al corte no afecta el período nuevo", () => {
  const balance = calculateOpenBillingBalance({
    records: [
      record("old-payment", 10000, "cash", 1000, {
        type:"admin_billing_settlement_payment",
        affectsBillingSettlement:true
      }),
      record("new-cash", 20000, "cash", 2000)
    ],
    closures:[{
      closureMode:"on_demand",
      closureKind:"facturacion",
      cutoffAtMs:1500,
      status:"closed"
    }]
  });
  assert.equal(balance.settlementPaymentTotal, 0);
  assert.equal(balance.amountFromDriver, 10000);
});
