import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const activity = fs.readFileSync(path.join(root, "js/segments/52-script.mjs"), "utf8");
const css = fs.readFileSync(path.join(root, "css/segments/53-style.css"), "utf8");
const index = fs.readFileSync(path.join(root, "index.html"), "utf8");
const serviceWorker = fs.readFileSync(path.join(root, "service-worker.js"), "utf8");

assert.match(activity, /financialKind:"cobro", financialId/);
assert.match(activity, /financialKind:"gasto", financialId/);
assert.match(activity, /canManageFinancial = isAdmin\(\)/);
assert.match(activity, /data-pay-activity-financial-edit/);
assert.match(activity, /data-pay-activity-financial-delete/);
assert.match(activity, />EDITAR<\/button>/);
assert.match(activity, /ELIMINAR/);
assert.match(activity, /ExploraReceiptEngine\.modifyFinancialAmount/);
assert.match(activity, /ExploraReceiptEngine\.deleteFinancialMovement/);
assert.match(activity, /adminActivityFinancialReceipt/);
assert.match(activity, /stateKey = cleanKind === "gasto" \? "expenses" : "records"/);
assert.match(css, /\.pay-activity-financial-edit/);
assert.match(css, /\.pay-activity-financial-delete/);
assert.match(index, /id="payAdminAmountEditContextLabel"/);
assert.match(index, /v=4145-activity-receipt-actions/);
assert.match(serviceWorker, /v4145-activity-receipt-actions/);

console.log("admin activity financial actions: ok");
