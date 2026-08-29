#!/usr/bin/env bash
set -Eeuo pipefail

readonly FIREBASE_PROJECT_ID="explora-control-operativo"
readonly PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly GIT_COMMIT_MESSAGE="${GIT_COMMIT_MESSAGE:-Explora v73: Tiempo real e inhabilitación de choferes}"

GIT_RESULT="Git pendiente"

on_error() {
  local exit_code=$?
  local line_number="${1:-desconocida}"
  echo
  echo "ERROR: el despliegue se detuvo en la línea ${line_number}."
  echo "No se borró ningún archivo. Corregí el mensaje anterior y volvé a ejecutar este mismo SH."
  exit "$exit_code"
}
trap 'on_error $LINENO' ERR

cd "$PROJECT_DIR"

echo "1/8 · Verificando archivos del proyecto..."
required_files=(
  firebase.json firestore.rules storage.rules firebase-config.js
  app.js index.html styles.css service-worker.js manifest.json
  functions/index.js functions/package.json functions/package-lock.json
  functions/telegram-billing-balance.js functions/telegram-debt-payment.js
  functions/telegram-driver-debt.js functions/telegram-expense.js
)
for required_file in "${required_files[@]}"; do
  if [[ ! -f "$required_file" ]]; then
    echo "Falta el archivo obligatorio: $required_file"
    exit 1
  fi
done

echo "2/8 · Verificando herramientas..."
for command_name in node npm git; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Falta la herramienta obligatoria: $command_name"
    exit 1
  fi
done
if ! command -v firebase >/dev/null 2>&1; then
  echo "Instalando Firebase CLI..."
  npm install --global firebase-tools
fi

echo "3/8 · Instalando dependencias exactas de Functions..."
(
  cd functions
  npm ci
)

echo "4/8 · Validando código y ejecutando pruebas..."
node --check app.js
node --check functions/index.js
node --check functions/telegram-billing-balance.js
node --check functions/telegram-debt-payment.js
node --check functions/telegram-driver-debt.js
node --check functions/telegram-expense.js
(
  cd functions
  npm test
)

echo "5/8 · Actualizando Git con esta versión validada..."
if ! git -C "$PROJECT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git -C "$PROJECT_DIR" init >/dev/null
  git -C "$PROJECT_DIR" branch -M main
fi

if ! git -C "$PROJECT_DIR" config user.name >/dev/null 2>&1; then
  git -C "$PROJECT_DIR" config user.name "Explora Deploy"
fi
if ! git -C "$PROJECT_DIR" config user.email >/dev/null 2>&1; then
  git -C "$PROJECT_DIR" config user.email "deploy@explora.local"
fi

git_paths=(
  .gitignore
  app.js index.html styles.css firebase-config.js firebase.json
  firestore.rules storage.rules service-worker.js manifest.json
  icon-192.png icon-512.png assets
  DESPLEGAR_EXPLORA_COMPLETO.sh
  functions/index.js functions/package.json functions/package-lock.json
  functions/telegram-billing-balance.js functions/telegram-debt-payment.js
  functions/telegram-driver-debt.js functions/telegram-expense.js functions/tests
  tools/desplegar-explora-completo.sh tools/deploy-migracion-cloud-shell.sh
)

shopt -s nullglob
for documentation_file in ./*.md ./*.txt; do
  git_paths+=("${documentation_file#./}")
done
shopt -u nullglob

existing_git_paths=()
for git_path in "${git_paths[@]}"; do
  if [[ -e "$PROJECT_DIR/$git_path" ]]; then
    existing_git_paths+=("$git_path")
  fi
done

git -C "$PROJECT_DIR" add -- "${existing_git_paths[@]}"
if git -C "$PROJECT_DIR" diff --cached --quiet -- "${existing_git_paths[@]}"; then
  GIT_RESULT="Git ya estaba actualizado; no fue necesario crear otro commit"
else
  git -C "$PROJECT_DIR" commit -m "$GIT_COMMIT_MESSAGE" -- "${existing_git_paths[@]}"
  GIT_RESULT="Commit local creado correctamente"
fi

git_branch="$(git -C "$PROJECT_DIR" symbolic-ref --short -q HEAD || true)"
if [[ -z "$git_branch" ]]; then
  git_branch="explora-v73"
  git -C "$PROJECT_DIR" switch -c "$git_branch"
fi

if [[ -n "${GIT_REMOTE_URL:-}" ]] && ! git -C "$PROJECT_DIR" remote get-url origin >/dev/null 2>&1; then
  git -C "$PROJECT_DIR" remote add origin "$GIT_REMOTE_URL"
fi

if git -C "$PROJECT_DIR" remote get-url origin >/dev/null 2>&1; then
  echo "Sincronizando Git con origin/$git_branch antes del push..."

  # El paquete extraído es la versión completa que debe quedar en GitHub.
  # Hacemos fetch sólo para actualizar la referencia remota y luego usamos
  # --force-with-lease: evita non-fast-forward y también evita merges que
  # fallen por archivos locales/untracked que existen en Cloud Shell.
  git -C "$PROJECT_DIR" fetch --prune origin "$git_branch" || true

  if git -C "$PROJECT_DIR" push --force-with-lease --set-upstream origin "$git_branch"; then
    GIT_RESULT="Commit creado y GitHub actualizado con esta versión completa en origin/$git_branch"
  else
    echo "El push protegido no pudo completarse; refrescando origin y reintentando una vez..."
    git -C "$PROJECT_DIR" fetch --prune origin "$git_branch" || true
    if git -C "$PROJECT_DIR" push --force-with-lease --set-upstream origin "$git_branch"; then
      GIT_RESULT="Commit creado y GitHub actualizado con esta versión completa en origin/$git_branch"
    else
      GIT_RESULT="Commit local creado; el push quedó pendiente por acceso al remoto"
      echo "AVISO: Firebase continuará. Git quedó guardado localmente y no se perdió ningún cambio."
    fi
  fi
else
  GIT_RESULT="Commit local creado; no existe origin para hacer push"
  echo "AVISO: no hay un remoto Git configurado. Si luego agregás origin, este mismo SH hará el push."
fi

echo "6/8 · Seleccionando el proyecto Firebase correcto..."
if command -v gcloud >/dev/null 2>&1; then
  gcloud config set project "$FIREBASE_PROJECT_ID" >/dev/null
fi

echo "7/8 · Desplegando Firebase por etapas para evitar cortes de Hosting..."

echo "   7.1 · Firestore, Storage y Functions..."
firebase deploy \
  --project "$FIREBASE_PROJECT_ID" \
  --only firestore:rules,storage,functions \
  --force \
  --non-interactive

echo "   7.2 · Hosting con reintentos automáticos..."
HOSTING_OK=0
for intento in 1 2 3 4 5; do
  echo "   Hosting: intento $intento de 5..."
  if firebase deploy \
      --project "$FIREBASE_PROJECT_ID" \
      --only hosting \
      --non-interactive; then
    HOSTING_OK=1
    break
  fi

  if [[ "$intento" -lt 5 ]]; then
    espera=$((intento * 8))
    echo "   Firebase Hosting devolvió un error temporal. Reintentando en ${espera}s..."
    sleep "$espera"
  fi
done

if [[ "$HOSTING_OK" != "1" ]]; then
  echo "ERROR: Hosting no pudo completar la subida después de 5 intentos."
  echo "Las Functions/Rules ya quedaron desplegadas. Podés volver a ejecutar este mismo SH; Git no duplicará cambios."
  exit 1
fi

echo "8/8 · Proceso terminado correctamente."
echo "Firebase: proyecto $FIREBASE_PROJECT_ID actualizado."
echo "Git: $GIT_RESULT."
echo "Ya podés cerrar Cloud Shell y abrir nuevamente la aplicación."
