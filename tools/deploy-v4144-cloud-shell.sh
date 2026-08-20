#!/usr/bin/env bash
set -euo pipefail

readonly FIREBASE_PROJECT_ID="explora-control-operativo"

if [[ ! -f "firebase.json" || ! -f "index.html" || ! -f "functions/index.js" ]]; then
  echo "Error: ejecuta este script desde la raiz del repositorio."
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js no esta disponible."
  exit 1
fi

if ! command -v firebase >/dev/null 2>&1; then
  echo "Error: falta Firebase CLI. Instalala con: npm install -g firebase-tools"
  exit 1
fi

echo "Validando v4144..."
git diff --check
node --check functions/index.js
node tests/financial-receipt-actions.test.mjs
node tests/admin-debt-ledger.test.mjs
node tests/admin-debt-payment.test.mjs
node tests/admin-debt-menu-release.test.mjs
node tests/billing-driver-payment.test.mjs
node --test functions/test/*.test.js

echo "Desplegando Functions y Hosting en ${FIREBASE_PROJECT_ID}..."
firebase deploy \
  --project "${FIREBASE_PROJECT_ID}" \
  --only functions,hosting

echo "Despliegue v4144 finalizado."
