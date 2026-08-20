import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = relative => readFile(new URL(relative, root), "utf8");
const build = "v4141-deudas-pagos-admin";
const assetVersion = build.slice(1);

const [index, serviceWorker, register, debtMenu, telegramFunctions] = await Promise.all([
  read("index.html"),
  read("service-worker.js"),
  read("js/pwa-register.js"),
  read("js/segments/15-script.mjs"),
  read("functions/index.js")
]);

assert.match(register, new RegExp(`const BUILD = '${build}'`));
assert.doesNotMatch(register, /v4137-telegram-group/);
assert.ok(serviceWorker.includes(`CACHE_NAME = \`\${CACHE_PREFIX}${build}\``));

for (const asset of [
  "js/segments/11-script.mjs",
  "js/segments/13-script.mjs",
  "js/segments/15-script.mjs",
  "css/segments/52-style.css",
  "js/segments/52-script.mjs",
  "js/pwa-register.js"
]) {
  assert.ok(index.includes(`${asset}?v=${assetVersion}`), `index sin versión nueva: ${asset}`);
}

const start = debtMenu.indexOf("async function openDebt(options={})");
const end = debtMenu.indexOf("function setDebtReason", start);
const markup = debtMenu.slice(start, end);
assert.ok(start >= 0 && end > start, "No se encontró el nuevo formulario de deuda");
assert.match(markup, /DEUDA DEL CHOFER/);
assert.match(markup, /PAGO DEL CHOFER/);
assert.match(markup, /EFECTIVO O TRANSFERENCIA/);
assert.match(markup, /AGREGAR COMPROBANTE/);
assert.doesNotMatch(markup, /VEHÍCULO RELACIONADO/);
assert.doesNotMatch(markup, /data-debt-reason/);
assert.doesNotMatch(markup, /REGISTROS EXISTENTES/);

assert.match(telegramFunctions, /notifyAdminDebtPaymentTelegramV1/);
assert.match(telegramFunctions, /notifyAdminDriverDebtTelegramV1/);

console.log("admin-debt-menu-release: ok");
