#!/usr/bin/env bash
# Explora · release desde el paquete completo. Sin contraseñas ni claves privadas.
set -Eeuo pipefail
umask 077
export PYTHONDONTWRITEBYTECODE=1
SOURCE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
PROJECT='explora-control-operativo'
REPO='davidmanu97bj-lgtm/santander'
CLI_VERSION='15.30.0'
MODE="${1:---ayuda}"
if [[ $# -gt 1 ]]; then echo 'Usá un solo modo: --verificar o --publicar.' >&2; exit 2; fi
case "$MODE" in
  --ayuda|--help|-h)
    cat <<'HELP'
Explora · Colores, login y saldos confirmados
  bash tools/cloudshell-release.sh --verificar
    Instala dependencias locales y ejecuta pruebas/build/emuladores. No publica.
  bash tools/cloudshell-release.sh --publicar
    Valida, autentica, compara GitHub, crea commit y publica Rules, Functions y Hosting.
Necesita internet, Node 22, Java 21+, GitHub y permisos de Firebase de Explora.
No activa cuentas ni modifica registros históricos. No usa force-push ni borra archivos remotos.
HELP
    exit 0 ;;
  --verificar|--publicar) ;;
  *) echo "Modo desconocido: $MODE" >&2; exit 2 ;;
esac
for tool in python3 git curl tar sha256sum; do
  command -v "$tool" >/dev/null || { echo "Falta $tool. Abrí Google Cloud Shell." >&2; exit 1; }
done
[[ -d "$HOME" ]] || { echo 'HOME no es válido.' >&2; exit 1; }
PARENT="$HOME/explora-despliegues"
[[ ! -L "$PARENT" ]] || { echo 'La carpeta de trabajo no puede ser un enlace.' >&2; exit 1; }
mkdir -p -- "$PARENT"
WORK="$(mktemp -d "$PARENT/release-$(date +%Y%m%d-%H%M%S)-XXXXXX")"
LOG="$WORK/etapas.log"
STAGE='Preparación'
log() { printf '%s · %s\n' "$(date -Iseconds)" "$*" | tee -a "$LOG"; }
failed() {
  local code="$1" line="$2"
  trap - ERR
  log "DETENIDO en $STAGE (línea $line, código $code). No se revierte ni se borra nada automáticamente."
  printf '\nRevisá: %s\n' "$WORK" >&2
  if [[ -d "$WORK/repo/.deploy" ]]; then printf 'Las etapas Firebase completadas están en %s/repo/.deploy/\n' "$WORK" >&2; fi
  exit "$code"
}
trap 'failed "$?" "$LINENO"' ERR
ask() {
  local message="$1" expected="$2" answer
  printf '\n%s\nEscribí %s para continuar: ' "$message" "$expected"
  if [[ ! -t 0 ]]; then echo 'Se requiere una terminal interactiva; no se aceptan confirmaciones automáticas.' >&2; exit 1; fi
  IFS= read -r answer
  [[ "$answer" == "$expected" ]] || { log 'Cancelado por el usuario.'; exit 1; }
}
log "Instalador v2 (base original verificada). Paquete: $SOURCE | destino autorizado: $REPO / $PROJECT | modo: $MODE"
# Instalar Node solo en la carpeta privada de esta ejecución. No cambia el Node global.
if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" != 22 ]]; then
  STAGE='Preparar Node 22'
  case "$(uname -m)" in x86_64) ARCH=x64 ;; aarch64|arm64) ARCH=arm64 ;; *) echo 'Arquitectura no soportada.' >&2; exit 1 ;; esac
  mkdir -p "$WORK/node"
  curl --fail --silent --show-error --location --retry 2 'https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt' -o "$WORK/node/SHASUMS256.txt"
  NODE_FILE="$(awk -v arch="$ARCH" '$2 ~ ("^node-v22[.][0-9]+[.][0-9]+-linux-" arch "[.]tar[.]xz$") {print $2}' "$WORK/node/SHASUMS256.txt")"
  [[ "$NODE_FILE" =~ ^node-v22\.[0-9]+\.[0-9]+-linux-(x64|arm64)\.tar\.xz$ ]] || { echo 'No se pudo identificar un binario Node 22 válido.' >&2; exit 1; }
  curl --fail --silent --show-error --location --retry 2 "https://nodejs.org/dist/latest-v22.x/$NODE_FILE" -o "$WORK/node/$NODE_FILE"
  (cd "$WORK/node"; awk -v file="$NODE_FILE" '$2 == file' SHASUMS256.txt | sha256sum --check -)
  tar -xJf "$WORK/node/$NODE_FILE" -C "$WORK/node"
  export PATH="$WORK/node/${NODE_FILE%.tar.xz}/bin:$PATH"
fi
command -v npm >/dev/null || { echo 'Falta npm junto a Node 22.' >&2; exit 1; }
JAVA_MAJOR=0
if command -v java >/dev/null; then
  JAVA_MAJOR="$(java -version 2>&1 | sed -n 's/.*version "\([0-9]*\).*/\1/p' | head -1)"
fi
if [[ ! "$JAVA_MAJOR" =~ ^[0-9]+$ ]] || (( JAVA_MAJOR < 21 )); then
  ask 'Los emuladores requieren Java; se instalará openjdk-21-jre-headless con apt.' 'INSTALAR'
  sudo apt-get update
  sudo apt-get install -y openjdk-21-jre-headless
  # An older JAVA_HOME may have priority even after apt installs Java 21.
  JAVA_BIN="$(find /usr/lib/jvm -path '*java-21*/bin/java' -type f | head -1)"
  [[ -n "$JAVA_BIN" ]] || { echo 'No se encontró Java 21 después de instalar.' >&2; exit 1; }
  export JAVA_HOME="$(dirname "$(dirname "$JAVA_BIN")")"
  export PATH="$JAVA_HOME/bin:$PATH"
fi
firebase_cli() { npm exec --yes "--package=firebase-tools@$CLI_VERSION" -- firebase "$@"; }
TARGET="$SOURCE"
if [[ "$MODE" == '--publicar' ]]; then
  STAGE='Autorización de GitHub'
  if ! command -v gh >/dev/null; then
    ask 'Se instalará GitHub CLI desde apt para autorizar el repositorio.' 'INSTALAR'
    sudo apt-get update
    sudo apt-get install -y gh
  fi
  if ! gh auth status --hostname github.com >/dev/null 2>&1; then
    gh auth login --hostname github.com --git-protocol https --web
  fi
  gh auth setup-git --hostname github.com
  STAGE='Autorización de Firebase'
  if ! firebase_cli projects:list --non-interactive --json > "$WORK/firebase-projects.json"; then
    firebase_cli login --no-localhost
    firebase_cli projects:list --non-interactive --json > "$WORK/firebase-projects.json"
  fi
  python3 - "$WORK/firebase-projects.json" "$PROJECT" <<'PY'
import json,sys
result=json.load(open(sys.argv[1]))
if result.get('status') != 'success' or not any(p.get('projectId')==sys.argv[2] for p in result.get('result',[])):
    raise SystemExit('La cuenta de Firebase no muestra acceso al proyecto esperado. No se publica.')
PY
  STAGE='Comparación segura con main'
  git clone --origin origin --branch main --single-branch "https://github.com/$REPO.git" "$WORK/repo"
  TARGET="$WORK/repo"
  BASE_SHA="$(git -C "$TARGET" rev-parse HEAD)"
  git -C "$TARGET" bundle create "$WORK/github-antes.bundle" --all
  python3 "$SOURCE/tools/safe-release-overlay.py" --source "$SOURCE" --target "$TARGET" \
    --manifest "$SOURCE/docs/colores-login-cloudshell/BASES_CONOCIDAS.json" --report "$WORK/comparacion.json" --apply
  log 'Comparación aprobada: archivos nuevos verificados contra el commit original; eliminaciones reales siguen bloqueadas.'
  log "Respaldo del código: github-antes.bundle (NO es un respaldo de Firestore). Base main: $BASE_SHA"
fi
STAGE='Dependencias y pruebas locales completas'
cd "$TARGET"
npm ci --prefix functions --ignore-scripts --no-audit --no-fund 2>&1 | tee "$WORK/dependencias.log"
npm test 2>&1 | tee "$WORK/pruebas.log"
python3 -m unittest discover -s tests -p 'test_*release*.py' 2>&1 | tee "$WORK/pruebas-despliegue.log"
for script in tools/cloudshell-release.sh DESPLEGAR_EXPLORA_COMPLETO.sh He.sh tools/desplegar-explora-completo.sh tools/deploy-migracion-cloud-shell.sh tools/deploy-v4144-cloud-shell.sh; do bash -n "$script"; done
npm run build 2>&1 | tee "$WORK/build.log"
STAGE='Emuladores aislados: demo-explora-ledger'
# El modo demo no puede escribir en Firebase real. No se saltan pruebas fallidas.
npm run test:ledger:emulator 2>&1 | tee "$WORK/emuladores.log"
log 'Pruebas, compilación y emuladores aprobados.'
if [[ "$MODE" == '--verificar' ]]; then
  log 'Verificación terminada. Sin commit, push ni despliegue. No se activó ninguna cuenta.'
  exit 0
fi
STAGE='Confirmación antes de publicar'
git diff --stat
printf '\nDestino: GitHub %s, rama main; Firebase %s.\n' "$REPO" "$PROJECT"
ask 'Confirmá que revisaste el diff, tenés copia de seguridad de Firestore y los choferes están en pausa. Se actualizarán GitHub, Rules/índices/Storage, Functions y Hosting.' 'PUBLICAR EXPLORA'
STAGE='Commit y push a GitHub'
# Stage only source paths explicitly checked; never stage credentials or extra files.
python3 - "$WORK/comparacion.json" "$TARGET" <<'PY'
import json,subprocess,sys
files=json.load(open(sys.argv[1]))['files']
for i in range(0,len(files),100):
    subprocess.run(['git','-C',sys.argv[2],'add','--',*files[i:i+100]],check=True)
PY
if ! git diff --cached --quiet; then
  if ! git config user.name >/dev/null; then git config user.name "$(gh api user --jq '.login')"; fi
  if ! git config user.email >/dev/null; then git config user.email "$(gh api user --jq '(.id|tostring)+"+"+.login+"@users.noreply.github.com"')"; fi
  # Existing Rules/test logs contain trailing spaces. Keep conflict-marker checks
  # without blocking the release on that non-functional formatting.
  git -c core.whitespace=-blank-at-eol diff --cached --check
  git commit -m 'Explora: colores por movimiento, inicio de sesión y despliegue seguro'
fi
REMOTE_SHA="$(git ls-remote --exit-code origin refs/heads/main | awk '{print $1}')"
[[ "$REMOTE_SHA" == "$BASE_SHA" ]] || { echo 'main cambió durante la validación. No se fuerza el push. Volvé a revisar.' >&2; exit 1; }
SHA="$(git rev-parse HEAD)"
if [[ "$SHA" != "$BASE_SHA" ]]; then
  if ! git push origin HEAD:refs/heads/main; then
    log 'GitHub rechazó el push (posible rama protegida). No se desplegó Firebase. Revisar/crear PR con el commit local.'
    exit 1
  fi
fi
log "GitHub actualizado al commit $SHA"
STAGE='Publicación de Rules, Functions y Hosting'
# El desplegador existente vuelve a verificar main y publica una copia del commit,
# no el directorio mutable. No --force, no borrados automáticos de Functions.
npm run deploy -- --deploy "$SHA"
log "PUBLICACIÓN COMPLETA: $SHA"
printf '\nIngresá como David: Admin → Saldos seguros. Revisá y activá cada cuenta histórica.\nNo se activan automáticamente ni se ajustan los $80.750 del ejemplo.\nRegistro de esta ejecución: %s\n' "$WORK"
