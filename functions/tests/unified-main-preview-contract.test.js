"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appSource = fs.readFileSync(path.resolve(__dirname, "../../app.js"), "utf8");
const htmlSource = fs.readFileSync(path.resolve(__dirname, "../../index.html"), "utf8");

test("el Main usa una sola tarjeta de facturación y una lista unificada", () => {
  assert.match(htmlSource, /id="settlementDirection"/);
  assert.match(htmlSource, /id="settlementTotal"/);
  assert.match(htmlSource, /id="receiptList"/);
  assert.doesNotMatch(htmlSource, /id="cashWalletStatus"/);
  assert.doesNotMatch(htmlSource, /id="digitalWalletStatus"/);
  assert.doesNotMatch(htmlSource, /<span>Explora<\/span>/);
});

test("efectivo genera su comprobante y otro comprobante de caja chica 5%", () => {
  assert.match(appSource, /type: "cashbox_receipt"/);
  assert.match(appSource, /amount: Number\(item\.amount \|\| 0\) \* 0\.05/);
  assert.match(appSource, /service: "Caja chica 5%"/);
});

test("cobro y gasto exigen el segundo aviso antes de cualquier escritura", () => {
  const chargePreview = appSource.indexOf('openOperationPreview({ kind:mode, amount, formId:"chargeForm" })');
  const chargeWrite = appSource.indexOf('acquireSubmissionLock("charge")', chargePreview);
  const expensePreview = appSource.indexOf('openOperationPreview({ kind:"expense", amount, formId:"expenseForm" })');
  const expenseWrite = appSource.indexOf('acquireSubmissionLock("expense")', expensePreview);
  assert.ok(chargePreview > -1 && chargeWrite > chargePreview);
  assert.ok(expensePreview > -1 && expenseWrite > expensePreview);
  assert.match(appSource, /form\.dataset\.previewConfirmed = "true"/);
});

test("la vista previa usa las reglas de efectivo, digital y gasto", () => {
  assert.match(appSource, /cash:[\s\S]*?delta: value \* 0\.55/);
  assert.match(appSource, /digital:[\s\S]*?delta: value \* -0\.50/);
  assert.match(appSource, /expense:[\s\S]*?delta: value \* -0\.50/);
  assert.match(appSource, /cashAmount \* 0\.55/);
  assert.match(appSource, /transferAmount \* -0\.50/);
});
