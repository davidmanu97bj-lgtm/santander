// Presentation only. These colors NEVER choose an amount, sign, rate or writer.
// Green/red describe the operation requested by Explora, not the arithmetic sign.
export function movementColor(record = {}, {expensePolicy} = {}) {
  if (["green", "red"].includes(record.visualMovementColor)) return record.visualMovementColor;
  const type = String(record.type || "");
  const method = String(record.method || "");
  if (type === "expense_reimbursement_receipt") return "green";
  if (type === "cashbox_receipt") return ["cash", "digital"].includes(method) ? "red" : "";
  if (type === "expense_receipt" || type === "gasto" || method === "expense") {
    // The existing catalogue decides responsibility. Historical rules stay historical.
    const rate = expensePolicy?.refundRate(record);
    return rate === 1 ? "green" : "red";
  }
  const direction = record.adjustmentDirection || record.direction;
  if (["driver_to_explora", "driver_pays_explora"].includes(direction)) return "green";
  if (["explora_to_driver", "explora_pays_driver"].includes(direction)) return "red";
  if (["settlement_adjustment", "cash_advance", "admin_debt", "reimbursement_compensation", "debt_compensation", "uber_receipt", "uber"].includes(type)) return "";
  return method === "cash" ? "red" : method === "digital" ? "green" : "";
}

export function ledgerComponentColor(component = {}, entry = {}) {
  // Confirmed entries are immutable. Derive ONLY a display color from their
  // original components, without querying a possibly edited source document.
  if (component.type === "expense_receipt") {
    const reimbursement = (entry.components || []).find(row => row.type === "expense_reimbursement_receipt");
    const gross = Math.abs(Number(component.impact));
    const fullyRefunded = gross > 0 && reimbursement && Math.abs(Math.abs(Number(reimbursement.impact)) - gross) < 0.005;
    return fullyRefunded ? "green" : "red";
  }
  if (component.title === "Pago a Explora") return "green";
  if (component.title === "Cobro a Explora") return "red";
  return movementColor(component);
}
