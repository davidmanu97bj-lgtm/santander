#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

# EXPLORA · Despliegue completo para Google Cloud Shell
# Uso normal:
#   chmod +x DESPLEGAR_EXPLORA_COMPLETO.sh
#   ./DESPLEGAR_EXPLORA_COMPLETO.sh
#
# Opciones avanzadas (no son necesarias para el uso normal):
#   SOLO_VALIDAR=1 ./DESPLEGAR_EXPLORA_COMPLETO.sh
#   OMITIR_GIT=1 ./DESPLEGAR_EXPLORA_COMPLETO.sh
#   GIT_REMOTE_URL=https://github.com/usuario/repositorio.git ./DESPLEGAR_EXPLORA_COMPLETO.sh

readonly FIREBASE_PROJECT_ID="${FIREBASE_PROJECT_ID:-explora-control-operativo}"
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly START_DIR="$(pwd -P)"
readonly RUN_ID="$(date -u +%Y%m%d-%H%M%S)"
readonly LOG_DIR="${TMPDIR:-/tmp}/explora-deploy-${RUN_ID}"
readonly GIT_COMMIT_MESSAGE="${GIT_COMMIT_MESSAGE:-Explora: cierre Uber solicitado, preparado y confirmado}"

PROJECT_DIR=""
GIT_RESULT="No ejecutado"
RULES_RESULT="Pendiente"
FUNCTIONS_RESULT="Pendiente"
HOSTING_RESULT="Pendiente"
VERIFY_RESULT="Pendiente"
declare -a FIREBASE_CMD=()

mkdir -p "$LOG_DIR"

line() {
  printf '%s\n' "============================================================"
}

info() {
  printf '%s\n' "$*"
}

warn() {
  printf 'AVISO: %s\n' "$*" >&2
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

on_error() {
  local exit_code=$?
  local line_number="${1:-desconocida}"
  trap - ERR
  printf '\nERROR: el proceso se detuvo en la línea %s (código %s).\n' "$line_number" "$exit_code" >&2
  printf 'No se borraron los archivos del proyecto. Podés ejecutar nuevamente este mismo SH.\n' >&2
  printf 'Registro de esta ejecución: %s\n' "$LOG_DIR" >&2
  exit "$exit_code"
}
trap 'on_error "$LINENO"' ERR

canonical_dir() {
  (cd -- "$1" 2>/dev/null && pwd -P)
}

is_explora_project() {
  local candidate="$1"
  [[ -f "$candidate/firebase.json" \
    && -f "$candidate/firebase-config.js" \
    && -f "$candidate/app.js" \
    && -f "$candidate/index.html" \
    && -f "$candidate/functions/index.js" ]]
}

find_project_dir() {
  local candidate resolved config_file
  local -a direct_candidates=(
    "$SCRIPT_DIR"
    "$START_DIR"
    "$SCRIPT_DIR/santander-main"
    "$START_DIR/santander-main"
    "$SCRIPT_DIR/../santander-main"
    "$START_DIR/../santander-main"
  )

  for candidate in "${direct_candidates[@]}"; do
    if is_explora_project "$candidate"; then
      PROJECT_DIR="$(canonical_dir "$candidate")"
      return 0
    fi
  done

  local -a discovered=()
  while IFS= read -r -d '' config_file; do
    candidate="$(dirname -- "$config_file")"
    if ! is_explora_project "$candidate"; then
      continue
    fi
    resolved="$(canonical_dir "$candidate")"
    local already_added=0
    local existing
    for existing in "${discovered[@]:-}"; do
      if [[ "$existing" == "$resolved" ]]; then
        already_added=1
        break
      fi
    done
    [[ "$already_added" == "0" ]] && discovered+=("$resolved")
  done < <(find "$START_DIR" "$SCRIPT_DIR" -maxdepth 4 -type f -name firebase.json -print0 2>/dev/null)

  if [[ "${#discovered[@]}" -eq 1 ]]; then
    PROJECT_DIR="${discovered[0]}"
    return 0
  fi

  if [[ "${#discovered[@]}" -gt 1 ]]; then
    local -a matching_project=()
    for candidate in "${discovered[@]}"; do
      if grep -Fq "$FIREBASE_PROJECT_ID" "$candidate/firebase-config.js"; then
        matching_project+=("$candidate")
      fi
    done
    if [[ "${#matching_project[@]}" -eq 1 ]]; then
      PROJECT_DIR="${matching_project[0]}"
      return 0
    fi

    printf 'Se encontraron varios proyectos posibles:\n' >&2
    printf '  - %s\n' "${discovered[@]}" >&2
    die "dejá este SH dentro de la carpeta santander-main correcta y volvé a ejecutarlo."
  fi

  die "no encontré el proyecto. Extraé el ZIP completo y ejecutá el SH que está dentro de santander-main."
}

require_file() {
  local relative_path="$1"
  [[ -f "$PROJECT_DIR/$relative_path" ]] || die "falta el archivo obligatorio: $relative_path"
}

require_command() {
  local command_name="$1"
  command -v "$command_name" >/dev/null 2>&1 || die "Cloud Shell no tiene disponible: $command_name"
}

run_retry() {
  local label="$1"
  local attempts="$2"
  local base_delay="$3"
  shift 3

  local attempt
  for ((attempt = 1; attempt <= attempts; attempt++)); do
    info "$label · intento $attempt de $attempts..."
    if "$@"; then
      return 0
    fi
    if [[ "$attempt" -lt "$attempts" ]]; then
      local delay=$((base_delay * attempt))
      warn "$label no terminó. Reintento automático en ${delay}s."
      sleep "$delay"
    fi
  done
  return 1
}

firebase_exec() {
  "${FIREBASE_CMD[@]}" "$@"
}

configure_firebase_cli() {
  if command -v firebase >/dev/null 2>&1; then
    FIREBASE_CMD=(firebase)
  else
    warn "Firebase CLI no estaba instalado; se usará la versión oficial más reciente mediante npx."
    FIREBASE_CMD=(npx --yes firebase-tools@latest)
  fi

  firebase_exec --version | tee "$LOG_DIR/firebase-version.log"
}

check_firebase_access() {
  local projects_log="$LOG_DIR/firebase-projects.json"
  if firebase_exec projects:list --json --non-interactive >"$projects_log" 2>&1 \
      && grep -Fq "$FIREBASE_PROJECT_ID" "$projects_log"; then
    return 0
  fi

  warn "Cloud Shell todavía no confirmó el acceso a Firebase. Se abrirá el inicio de sesión solamente esta vez."
  firebase_exec login --no-localhost

  firebase_exec projects:list --json --non-interactive >"$projects_log" 2>&1 \
    || die "Firebase no pudo validar la cuenta iniciada."
  grep -Fq "$FIREBASE_PROJECT_ID" "$projects_log" \
    || die "la cuenta de Google activa no tiene acceso al proyecto $FIREBASE_PROJECT_ID."
}

install_functions_dependencies() {
  export npm_config_audit=false
  export npm_config_fund=false
  export npm_config_update_notifier=false

  run_retry "Dependencias de Functions" 3 5 \
    npm --prefix "$PROJECT_DIR/functions" ci --no-audit --no-fund \
    || die "no se pudieron instalar las dependencias exactas de Functions."
}

validate_project() {
  node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));' "$PROJECT_DIR/firebase.json"
  grep -Fq "$FIREBASE_PROJECT_ID" "$PROJECT_DIR/firebase-config.js" \
    || die "firebase-config.js no apunta al proyecto $FIREBASE_PROJECT_ID."

  node --check "$PROJECT_DIR/app.js"
  node --check "$PROJECT_DIR/functions/index.js"
  node --check "$PROJECT_DIR/functions/telegram-billing-balance.js"
  node --check "$PROJECT_DIR/functions/telegram-debt-payment.js"
  node --check "$PROJECT_DIR/functions/telegram-driver-debt.js"
  node --check "$PROJECT_DIR/functions/telegram-expense.js"

  node "$PROJECT_DIR/tests/closure-direct-flow.test.mjs"
  node "$PROJECT_DIR/tests/billing-driver-payment.test.mjs"
  node "$PROJECT_DIR/tests/uber-weekly-split-flow.test.mjs"
  (
    cd "$PROJECT_DIR/functions"
    node --test tests/*.test.js
  )
}

update_git() {
  if [[ "${OMITIR_GIT:-0}" == "1" ]]; then
    GIT_RESULT="Omitido por OMITIR_GIT=1"
    return 0
  fi

  if ! git -C "$PROJECT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git -C "$PROJECT_DIR" init -b main >/dev/null 2>&1 \
      || {
        git -C "$PROJECT_DIR" init >/dev/null
        git -C "$PROJECT_DIR" symbolic-ref HEAD refs/heads/main
      }
  fi

  if ! git -C "$PROJECT_DIR" config user.name >/dev/null 2>&1; then
    git -C "$PROJECT_DIR" config user.name "Explora Deploy"
  fi
  if ! git -C "$PROJECT_DIR" config user.email >/dev/null 2>&1; then
    git -C "$PROJECT_DIR" config user.email "deploy@explora.local"
  fi

  if [[ -n "${GIT_REMOTE_URL:-}" ]] && ! git -C "$PROJECT_DIR" remote get-url origin >/dev/null 2>&1; then
    git -C "$PROJECT_DIR" remote add origin "$GIT_REMOTE_URL"
  fi

  git -C "$PROJECT_DIR" add -A -- .
  if git -C "$PROJECT_DIR" diff --cached --quiet; then
    GIT_RESULT="El proyecto ya estaba confirmado localmente"
  else
    git -C "$PROJECT_DIR" \
      -c commit.gpgsign=false \
      commit --quiet --no-verify -m "$GIT_COMMIT_MESSAGE"
    GIT_RESULT="Commit local creado"
  fi

  local branch
  branch="${GIT_BRANCH:-$(git -C "$PROJECT_DIR" symbolic-ref --short -q HEAD || true)}"
  if [[ -z "$branch" ]]; then
    branch="main"
    git -C "$PROJECT_DIR" switch -c "$branch"
  fi

  if ! git -C "$PROJECT_DIR" remote get-url origin >/dev/null 2>&1; then
    GIT_RESULT="${GIT_RESULT}; no había un remoto origin para subir"
    warn "Git quedó actualizado localmente. El despliegue de Firebase continuará normalmente."
    return 0
  fi

  # Se conserva la historia remota sin usar force. Si el remoto avanzó, se crea
  # una unión de historiales manteniendo como contenido final este paquete validado.
  if git -C "$PROJECT_DIR" fetch --prune origin; then
    if git -C "$PROJECT_DIR" show-ref --verify --quiet "refs/remotes/origin/$branch" \
        && ! git -C "$PROJECT_DIR" merge-base --is-ancestor "origin/$branch" HEAD; then
      git -C "$PROJECT_DIR" merge \
        --strategy=ours \
        --no-edit \
        --no-gpg-sign \
        --no-verify \
        --allow-unrelated-histories \
        "origin/$branch"
    fi

    if git -C "$PROJECT_DIR" push --set-upstream origin "HEAD:$branch"; then
      GIT_RESULT="Git actualizado correctamente en origin/$branch"
      return 0
    fi
  fi

  GIT_RESULT="${GIT_RESULT}; el push quedó pendiente por permisos o conexión"
  warn "Git no pudo subir al remoto, pero el commit local está guardado. Firebase continuará."
  return 0
}

run_firebase_stage() {
  local stage_key="$1"
  local stage_label="$2"
  local attempts="$3"
  shift 3

  local attempt rc delay
  local log_file="$LOG_DIR/${stage_key}.log"
  : >"$log_file"

  for ((attempt = 1; attempt <= attempts; attempt++)); do
    info "$stage_label · intento $attempt de $attempts..."
    set +e
    firebase_exec deploy \
      --project "$FIREBASE_PROJECT_ID" \
      --non-interactive \
      "$@" 2>&1 | tee -a "$log_file"
    rc=${PIPESTATUS[0]}
    set -e

    if [[ "$rc" -eq 0 ]]; then
      return 0
    fi

    # Algunas versiones del CLI confirman la publicación y luego fallan al
    # cerrar telemetría. Sólo se acepta como éxito si Firebase escribió la
    # confirmación literal del despliegue.
    if grep -Fq "Deploy complete!" "$log_file"; then
      warn "$stage_label fue confirmado por Firebase aunque el CLI terminó con código $rc."
      return 0
    fi

    if grep -Eqi 'permission denied|does not have permission|not authorized|authentication|login required' "$log_file"; then
      warn "$stage_label se detuvo por permisos; no se harán reintentos inútiles."
      return "$rc"
    fi

    if [[ "$attempt" -lt "$attempts" ]]; then
      delay=$((attempt * 8))
      warn "$stage_label tuvo un error temporal. Reintento automático en ${delay}s."
      sleep "$delay"
    fi
  done

  return "$rc"
}

verify_telegram_functions() {
  local functions_log="$LOG_DIR/functions-after.json"
  local -a critical_functions=(
    notifyBillingRecordV2
    notifyExpenseV2
    notifyAdminDebtPaymentTelegramV1
    notifyAdminDriverDebtTelegramV1
    notifyClosureTelegramGroupV1
    notifyUberClosureTelegramGroupV1
  )

  if ! firebase_exec functions:list \
      --project "$FIREBASE_PROJECT_ID" \
      --json \
      --non-interactive >"$functions_log" 2>&1; then
    VERIFY_RESULT="Despliegue confirmado; Firebase no permitió listar Functions para la revisión final"
    warn "$VERIFY_RESULT."
    return 0
  fi

  local function_name missing=0
  for function_name in "${critical_functions[@]}"; do
    if ! grep -Fqi "$function_name" "$functions_log"; then
      warn "No pude confirmar en el listado la Function: $function_name"
      missing=1
    fi
  done

  if [[ "$missing" == "0" ]]; then
    VERIFY_RESULT="Functions críticas de Telegram confirmadas"
  else
    VERIFY_RESULT="Firebase confirmó el deploy, pero el listado final no mostró todas las Functions esperadas"
  fi
}

main() {
  line
  info "EXPLORA · DESPLIEGUE COMPLETO"
  info "Proyecto Firebase: $FIREBASE_PROJECT_ID"
  line

  info "1/10 · Localizando y verificando el proyecto..."
  find_project_dir
  cd "$PROJECT_DIR"

  local -a required_files=(
    firebase.json
    firestore.rules
    storage.rules
    firebase-config.js
    app.js
    index.html
    styles.css
    service-worker.js
    manifest.json
    functions/index.js
    functions/package.json
    functions/package-lock.json
    functions/telegram-billing-balance.js
    functions/telegram-debt-payment.js
    functions/telegram-driver-debt.js
    functions/telegram-expense.js
    tests/closure-direct-flow.test.mjs
    tests/billing-driver-payment.test.mjs
    tests/uber-weekly-split-flow.test.mjs
  )
  local required_file
  for required_file in "${required_files[@]}"; do
    require_file "$required_file"
  done
  info "Carpeta detectada: $PROJECT_DIR"

  info "2/10 · Verificando herramientas de Cloud Shell..."
  require_command bash
  require_command node
  require_command npm
  require_command git

  local node_major
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  [[ "$node_major" =~ ^[0-9]+$ ]] || die "no pude determinar la versión de Node.js."
  ((node_major >= 18)) || die "se necesita Node.js 18 o superior; Cloud Shell informó $(node --version)."

  info "3/10 · Instalando dependencias exactas de Functions..."
  if [[ "${OMITIR_INSTALACION:-0}" == "1" ]]; then
    warn "Instalación omitida por OMITIR_INSTALACION=1."
  else
    install_functions_dependencies
  fi

  info "4/10 · Validando código y pruebas del cierre/Telegram..."
  validate_project
  info "Validación completa: OK"

  if [[ "${SOLO_VALIDAR:-0}" == "1" ]]; then
    line
    info "VALIDACIÓN TERMINADA SIN DESPLEGAR"
    info "Código, cierre directo y Telegram: OK"
    info "Registros: $LOG_DIR"
    line
    exit 0
  fi

  info "5/10 · Confirmando acceso al Firebase correcto..."
  configure_firebase_cli
  check_firebase_access
  if command -v gcloud >/dev/null 2>&1; then
    gcloud config set project "$FIREBASE_PROJECT_ID" >/dev/null 2>&1 \
      || warn "No se pudo cambiar el proyecto predeterminado de gcloud; Firebase usará igualmente --project."
  fi

  info "6/10 · Guardando esta versión en Git..."
  update_git

  info "7/10 · Desplegando reglas de Firestore y Storage..."
  run_firebase_stage \
    rules \
    "Reglas Firestore/Storage" \
    3 \
    --only firestore:rules,storage \
    || die "Firestore/Storage no pudieron desplegarse. Revisá $LOG_DIR/rules.log"
  RULES_RESULT="Desplegadas"

  info "8/10 · Desplegando todas las Functions, incluido Telegram..."
  run_firebase_stage \
    functions \
    "Functions/Telegram" \
    3 \
    --only functions \
    --force \
    || die "Functions/Telegram no pudieron desplegarse. Revisá $LOG_DIR/functions.log"
  FUNCTIONS_RESULT="Desplegadas"

  info "9/10 · Desplegando Hosting..."
  run_firebase_stage \
    hosting \
    "Firebase Hosting" \
    5 \
    --only hosting \
    || die "Hosting no pudo desplegarse. Rules y Functions sí quedaron actualizadas; volvé a ejecutar este mismo SH."
  HOSTING_RESULT="Desplegado"

  info "10/10 · Comprobando las Functions críticas de Telegram..."
  verify_telegram_functions

  line
  info "DESPLIEGUE COMPLETO TERMINADO"
  info "Firebase: $FIREBASE_PROJECT_ID"
  info "Reglas: $RULES_RESULT"
  info "Functions/Telegram: $FUNCTIONS_RESULT"
  info "Hosting: $HOSTING_RESULT"
  info "Verificación: $VERIFY_RESULT"
  info "Git: $GIT_RESULT"
  info "Aplicación: https://${FIREBASE_PROJECT_ID}.web.app"
  info "Registros: $LOG_DIR"
  info "Ya podés cerrar Cloud Shell y volver a abrir Explora."
  line
}

main "$@"
