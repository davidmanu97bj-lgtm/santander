"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const functions = fs.readFileSync(path.join(root, "functions/index.js"), "utf8");
const rules = fs.readFileSync(path.join(root, "firestore.rules"), "utf8");

test("el resumen anterior fue reemplazado por Tiempo real", () => {
  assert.match(html, /id="teamRealtimeTitle">Tiempo real</);
  assert.match(html, /id="teamRealtimeList"/);
  assert.doesNotMatch(html, /id="summaryBilledAmount"/);
  assert.doesNotMatch(html, /id="summaryExpenseTotal"/);
  assert.match(app, /TEAM_REALTIME_BALANCES_COLLECTION = "team_realtime_balances"/);
  assert.match(app, /Chofer debe liquidar a Explora/);
  assert.match(app, /Explora debe liquidar al chofer/);
});

test("la gestión administrativa incorpora una acción explícita de inhabilitar", () => {
  assert.match(html, /data-driver-manager-mode="disable">Inhabilitar</);
  assert.match(html, /id="disableDriverSelect"/);
  assert.match(app, /active:false/);
  assert.match(app, /no aparecerá en Tiempo real/i);
  assert.match(app, /\["disableDriverSelect", activeOptions\]/);
});

test("los saldos compartidos son sanitizados y mantenidos por backend", () => {
  assert.match(functions, /exports\.ensureTeamRealtimeBalances/);
  assert.match(functions, /exports\.onTeamRealtimeBillingWriteV1/);
  assert.match(functions, /exports\.onTeamRealtimeExpenseWriteV1/);
  assert.match(functions, /exports\.onTeamRealtimeDriverWriteV1/);
  assert.match(functions, /driverName:teamRealtimeDriverName\(profile\)/);
  assert.match(functions, /settlementBalance:result\.balance/);
  assert.match(rules, /match \/team_realtime_balances\/\{driverId\}/);
  assert.match(rules, /allow create, update, delete: if false/);
});
