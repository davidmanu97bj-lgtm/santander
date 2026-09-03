import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const app = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
const rules = fs.readFileSync(new URL("../firestore.rules", import.meta.url), "utf8");
const telegram = fs.readFileSync(new URL("../functions/index.js", import.meta.url), "utf8");

assert.doesNotMatch(html, /id="uberCashAmount"/);
assert.doesNotMatch(html, /id="uberTransferAmount"/);
assert.match(html, /Pedir a David el cierre de Uber/);
assert.match(html, /id="uberReminderModal"/);
assert.match(html, /id="uberDriverConfirmationModal"/);

assert.match(app, /function uberSettlementDelta\(cashAmount = 0, transferAmount = 0\)/);
assert.match(app, /cashAmount \* 0\.55/);
assert.match(app, /transferAmount \* -0\.50/);
assert.match(app, /Hoy debes pedirle a David tu cierre semanal de Uber/);
assert.match(app, /En 2 días podrás pedirle a David tu cierre semanal de Uber/);
assert.match(app, /reviewStatus: "pending_admin_breakdown"/);
assert.match(app, /reviewStatus:"awaiting_driver_confirmation"/);
assert.match(app, /driverConfirmed:true/);
assert.match(app, /service: "Cierre semanal de Uber"/);

assert.match(rules, /validUberClosureRequest/);
assert.match(rules, /data\.reviewStatus == 'pending_admin_breakdown'/);
assert.match(rules, /resource\.data\.reviewStatus == 'awaiting_driver_confirmation'/);

assert.match(telegram, /`Efectivo: \$\{telegramMoney\(cashAmount\)\}`/);
assert.match(telegram, /`Transferencia: \$\{telegramMoney\(transferAmount\)\}`/);
assert.match(telegram, /CHOFER PIDIÓ SU CIERRE SEMANAL DE UBER/);
assert.match(telegram, /DAVID CARGÓ EL CIERRE SEMANAL DE UBER/);
assert.match(telegram, /CHOFER CONFIRMÓ SU CIERRE SEMANAL DE UBER/);

console.log("uber-weekly-split-flow: ok");
