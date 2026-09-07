import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const app = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
const rules = fs.readFileSync(new URL("../firestore.rules", import.meta.url), "utf8");
const telegram = fs.readFileSync(new URL("../functions/index.js", import.meta.url), "utf8");
const balance = fs.readFileSync(new URL("../functions/telegram-billing-balance.js", import.meta.url), "utf8");

// El chofer carga un único total semanal y la evidencia desde cámara o galería.
assert.match(html, /id="uberGrossAmount"/);
assert.match(html, /data-photo-picker="uber"/);
assert.match(html, /id="uberProofCamera"[^>]*capture="environment"/);
assert.match(html, /id="uberProof"[^>]*data-photo-source="gallery"/);
assert.match(html, /¿Dónde encuentro este monto\?/);
assert.match(html, /No uses saldo, retiros ni tarifa bruta/);
assert.doesNotMatch(html, /id="uberCashAmount"/);
assert.doesNotMatch(html, /id="uberTransferAmount"/);
assert.doesNotMatch(html, /id="adminUberCashAmount"/);
assert.doesNotMatch(html, /id="adminUberTransferAmount"/);

// La vista previa usa 50% Explora + 5% caja chica y deja 45% al chofer.
assert.match(app, /function uberDriverSubmissionDelta\(grossAmount = 0\)/);
assert.match(app, /Number\(grossAmount \|\| 0\)\) \* 0\.55/);
assert.match(app, /driverShare = amount - exploraShare - cashboxAmount/);
assert.match(app, /settlementWorkflowVersion: "v84_driver_submission_admin_review"/);
assert.match(app, /reviewStatus: "pending_admin_review"/);
assert.match(app, /adminConfirmed:false/);
assert.match(app, /selectedPhotoFile\("uber"\)/);
assert.match(app, /openOperationPreview\(\{ kind:"uber", amount, formId:"uberForm" \}\)/);

// El Admin ve el comprobante, puede corregir el total y es quien confirma el impacto.
assert.match(app, /id="adminUberVerifiedAmount"/);
assert.match(app, /Comprobante y semana verificados/);
assert.match(app, /async function approveUberClosureFromAdmin/);
assert.match(app, /adminConfirmed:true/);
assert.match(app, /reviewStatus:"approved"/);
assert.match(app, /Cierre confirmado\. El saldo ya fue actualizado\./);

// Las reglas exigen monto, foto, reparto 50/5/45 y estado pendiente del Admin.
assert.match(rules, /data\.settlementWorkflowVersion == 'v84_driver_submission_admin_review'/);
assert.match(rules, /data\.exploraShare \* 2 == data\.grossAmount/);
assert.match(rules, /data\.cashboxAmount \* 20 == data\.grossAmount/);
assert.match(rules, /data\.driverShare == data\.grossAmount - data\.exploraShare - data\.cashboxAmount/);
assert.match(rules, /data\.reviewStatus == 'pending_admin_review'/);
assert.match(rules, /data\.proofUrl\.size\(\) > 0/);

// Telegram cubre el envío con foto y la aprobación/rechazo de David.
assert.match(telegram, /CHOFER ENVIÓ SU CIERRE SEMANAL DE UBER/);
assert.match(telegram, /DAVID CONFIRMÓ EL CIERRE SEMANAL DE UBER/);
assert.match(telegram, /DAVID RECHAZÓ EL CIERRE SEMANAL DE UBER/);
assert.match(telegram, /Comprobante: Adjunto/);
assert.match(telegram, /Total para Explora:/);
assert.match(telegram, /review !== "rejected"/);

// Tanto el Home como Telegram excluyen el pedido hasta la aprobación administrativa.
assert.match(app, /item\.adminConfirmed === true && \/approved\|confirmed\|completed\/\.test\(status\)/);
assert.match(balance, /data\.adminConfirmed === true && \/approved\|confirmed\|completed\/\.test\(status\)/);

console.log("uber-weekly-driver-proof-admin-review: ok");
