"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "../..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const functions = fs.readFileSync(path.join(root, "functions/index.js"), "utf8");
const rules = fs.readFileSync(path.join(root, "firestore.rules"), "utf8");
const workspace = fs.readFileSync(path.join(root, "admin-workspace.js"), "utf8");

test("el nuevo panel conserva los saldos en tiempo real de todo el equipo", async () => {
  const {monthlyChargeMonth,monthlyChargesForDriver}=await import('../../admin-monthly-charges.js');
  assert.match(html, /id="adminWorkspaceTitle"[^>]*>Tu equipo<\/h1>/);
  assert.match(html, /id="adminDriverList"/);
  assert.doesNotMatch(html, /id="summaryBilledAmount"/);
  assert.doesNotMatch(html, /id="summaryExpenseTotal"/);
  assert.match(app, /TEAM_REALTIME_BALANCES_COLLECTION = "team_realtime_balances"/);
  assert.match(workspace, /Chofer debe/);
  assert.match(workspace, /Explora debe/);
  const calls = [];
  const context = {monthlyChargeMonth,monthlyChargesForDriver,auth:{currentUser:{uid:"admin"}},isAdminProfile:()=>true,dashboardLoad:{complete:()=>true},
    adminDrivers:[{id:"driver-one",name:"Chofer uno",active:true},{id:"driver-two",name:"Chofer dos",active:true},{id:"inactive",active:false},{id:"admin",role:"admin",active:true}],
    adminDriverIsAdministrator:driver=>driver.role==="admin",adminDriverIsActive:driver=>driver.active,
    adminDriverLabel:driver=>driver.name,adminBillingBalanceForDriver:driver=>{calls.push(driver.id);return driver.id==="driver-one"?25000:-10000;},
    adminPayments:[],adminExpenses:[],adminDebts:[],adminDebtPayments:[],adminUberClosures:[],adminAllClosures:[]};
  const start=app.indexOf("function adminWorkspaceState()"),end=app.indexOf("\n}",start)+2;
  vm.runInNewContext(app.slice(start,end)+"\nresult=adminWorkspaceState();",context);
  assert.deepEqual(calls,["driver-one","driver-two"]);
  assert.deepEqual(JSON.parse(JSON.stringify(context.result.accounts)).map(({monthlyCharges,...account})=>account),[{uid:"driver-one",name:"Chofer uno",balance:25000},{uid:"driver-two",name:"Chofer dos",balance:-10000}]);
  for(const account of context.result.accounts)assert.deepEqual(Array.from(account.monthlyCharges.missing),['canon','patente']);
});

test("el listado de choferes está visible en Admin y la gestión permite borrar", () => {
  assert.match(html, /id="adminDashboard"/);
  assert.match(html, /id="adminDriversBtn"/);
  assert.match(html, /data-driver-manager-mode="delete">Borrar chofer</);
  assert.match(html, /id="deleteDriverSelect"/);
  assert.match(app, /deleteDriver:true/);
  assert.match(app, /Borrar chofer/);
  assert.match(app, /function renderAdminDriverList\(\)/);
  assert.match(app, /const drivers=adminDrivers\.filter\(d=>!adminDriverIsAdministrator\(d\)\)/);
  assert.match(app, /accounts:drivers\.filter\(adminDriverIsActive\)/);
  assert.match(workspace, /data-admin-driver-action/);
  assert.match(functions, /admin_delete_driver/);
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
