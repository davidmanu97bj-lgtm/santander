# Explora — ZIP normal y publicación manual

14/09/2026. Proyecto Firebase: `explora-control-operativo`.
Repositorio previsto: `davidmanu97bj-lgtm/santander`.

## Qué contiene esta entrega

`EXPLORA_COMPLETO_MANUAL.zip` es un ZIP normal que contiene `santander-main/`.
Conserva íntegros los archivos del ZIP V2 de colores, login y saldos confirmados;
solamente agrega esta guía. No cambia colores, fórmulas, porcentajes, Functions,
Rules, dependencias ni controles de la aplicación. No contiene `node_modules`.
Los instaladores anteriores quedan conservados como archivos, pero NO se ejecutan
al descomprimir ni con los comandos manuales de esta guía.

No se realizó un despliegue de producción para esta entrega. La prueba de los
emuladores quedó pendiente en la ejecución que mostraste: **esta vía manual no la
convierte en aprobada**. Los despliegues directos no ejecutan aquella barrera del
instalador. Recomiendo completar la prueba antes de poner en uso real esta migración
de saldos; la sección de verificación separada indica cómo ejecutarla.

Antes de publicar: copia de seguridad de Firestore, copia de las reglas actuales
y del código anterior, y choferes en pausa. Un ZIP de código NO respalda los datos.
Si otra persona cambió GitHub o las reglas de producción después de preparar esta
versión, primero comparar esos cambios; no sobrescribirlos a ciegas.

## Dónde va cada archivo

| Archivo/carpeta | Destino |
|---|---|
| `firestore.rules` | Reglas de Cloud Firestore |
| `firestore.indexes.json` | Índices de Cloud Firestore |
| `storage.rules` | Reglas de Cloud Storage (archivos/comprobantes) |
| `functions/` | Cloud Functions |
| `dist/` (generada por `npm run build`) | Firebase Hosting |
| Contenido de `santander-main/` | Raíz del repositorio Git, tras revisar los cambios |

No pegar `firestore.indexes.json` en el editor de reglas. No ejecutar `firebase init`:
`firebase.json` ya tiene los destinos configurados. Las reglas de Firestore y las
de Storage son diferentes; no intercambiarlas. Las reglas sueltas entregadas junto
al ZIP son copias idénticas de las que están dentro.

## A. Continuar desde la carpeta que ya preparó Cloud Shell (tu caso)

Esta opción evita volver a descargar el proyecto e instalar las dependencias.
No hace falta subir otro ZIP para continuar desde esta carpeta.

Primero, en la terminal de la descarga trabada, presionar **Ctrl+C** y esperar al
prompt `$`. No mantener otro instalador, recuperador o emulador ejecutándose a la vez.
Ejecutar cada bloque por separado, siempre en la misma terminal. Si un bloque falla,
no continuar al siguiente. No pegar todo el documento como un único comando.

### A1. Entrar al proyecto y reutilizar las herramientas instaladas

```bash
cd "$HOME/explora-despliegues/release-20260914-061639-fhntvp/repo" &&
source "$HOME/.nvm/nvm.sh" &&
nvm use 22 &&
export PATH="$HOME/.npm/_npx/a466814c936f6a15/node_modules/.bin:$PATH" &&
firebase --version
```

La ubicación de Firebase CLI es la que aparece en tu registro; se espera **15.30.0**
y Node **22**. Si la carpeta no existe o aparece otra versión, detenerse y usar la
preparación desde ZIP de la sección B. No instalar todo de nuevo sobre `/home`.

### A2. Pruebas locales y compilación (no descargan el emulador)

```bash
npm test && npm run build
```

Estas pruebas no sustituyen la prueba de integración con Firestore/Auth. En una
sesión sin emuladores, la prueba correspondiente puede aparecer como omitida.
No considerar una omisión como aprobación. Si hay errores, no publicar.

Las fuentes ya incluyen sus dependencias instaladas en la carpeta preparada por
el intento anterior. Si faltan dependencias, no usar `npm ci` sin revisar espacio:
la sección B instala en `/tmp`, fuera de la carpeta `/home` casi llena.

### A3. Comprobar acceso a Firebase

```bash
firebase projects:list
```

Debe aparecer `explora-control-operativo`. Solo cuando falte la sesión autorizada:

```bash
firebase login --no-localhost
```

Después repetir `firebase projects:list`. No pegar tokens ni contraseñas en chats.
Si no tenés acceso al proyecto correcto, no continuar.

### A4. Publicar reglas e índices

**Este y los siguientes comandos cambian el proyecto real.** No existe la
confirmación `PUBLICAR EXPLORA` del instalador. Asegurar antes la copia de datos,
la revisión de la versión y la pausa de choferes.

```bash
firebase deploy --project explora-control-operativo --config firebase.json --only firestore:rules,firestore:indexes,storage
```

Esperar a que termine correctamente antes de continuar. Publicar reglas por CLI
reemplaza las reglas del destino: revisar las diferencias con las reglas actuales.
Si pide eliminar índices o recursos que no reconocés, responder **n** y revisar.
No usar `--force`. Los índices pueden necesitar tiempo para estar listos.

### A5. Publicar Functions

```bash
firebase deploy --project explora-control-operativo --config firebase.json --only functions
```

No responder afirmativamente a eliminaciones de funciones sin comprobarlas.
No usar `--force`, no inventar secretos, no desactivar seguridad ante errores.
Una solicitud de credenciales o configuración necesita los valores reales.
Functions puede tardar en compilar y publicar: el camino manual no elimina ese
trabajo del servicio. Si falla, no seguir con Hosting ni reabrir los registros.

### A6. Publicar la aplicación web

```bash
firebase deploy --project explora-control-operativo --config firebase.json --only hosting
```

Este comando usa `dist/`, que generó la compilación. No publicar solamente Hosting
para introducir la migración; Rules y Functions deben corresponder a esta versión.
Al finalizar, revisar la URL indicada por Firebase y verificar las tres etapas.
Una etapa exitosa no significa que hayan terminado las otras.

### A7. Después de publicar

Ingresar como David → **Admin → Saldos seguros**. Revisar y activar cada cuenta
histórica una por vez, contrastando su base con los registros. Sin activación,
las cuentas con historial siguen sin poder registrar nuevos movimientos.
No crear un ajuste de $80.750 para hacer coincidir una tarjeta del historial.
No se reescriben automáticamente las fotografías históricas ni se activan las
cuentas por el hecho de desplegar.

Antes de reabrir la operación, verificar login, roles, estado de cuentas y errores.
Probar movimientos ficticios solamente en un entorno aislado, no en cuentas reales.
Si una etapa del despliegue quedó incompleta, no hacer un rollback aislado del
cliente ni volver a reglas permisivas: primero resolver la compatibilidad.

## B. Preparar desde el ZIP normal (alternativa; NO sumar esta opción a A)

Usar esta opción únicamente cuando no existe o no querés usar la carpeta preparada.
Subir `EXPLORA_COMPLETO_MANUAL.zip` a `$HOME`. No subir un `.sh`.
Tu registro mostró `/home` casi lleno; por eso la extracción y las instalaciones
nuevas se hacen en `/tmp`. Esa carpeta es temporal: conservar el ZIP en la PC o
el código confirmado en GitHub. No usar `/tmp` como único respaldo.

```bash
WORK="$(mktemp -d /tmp/explora-manual-XXXXXXXX)" &&
unzip -q "$HOME/EXPLORA_COMPLETO_MANUAL.zip" -d "$WORK" &&
cd "$WORK/santander-main" &&
source "$HOME/.nvm/nvm.sh" &&
nvm use 22
```

Reutilizar Firebase CLI ya instalado, sin descargar otra copia:

```bash
export PATH="$HOME/.npm/_npx/a466814c936f6a15/node_modules/.bin:$PATH"
firebase --version
```

Se espera 15.30.0. Si esa instalación no está disponible, instalar esa versión en
la carpeta temporal (requiere internet):

```bash
export npm_config_cache="$WORK/npm-cache"
npm install --prefix "$WORK/firebase-cli" --no-save --no-audit --no-fund firebase-tools@15.30.0 &&
export PATH="$WORK/firebase-cli/node_modules/.bin:$PATH" &&
firebase --version
```

Instalar las dependencias del backend en la copia temporal y comprobarla:

```bash
export npm_config_cache="$WORK/npm-cache"
npm ci --prefix functions --ignore-scripts --no-audit --no-fund &&
npm test &&
npm run build
```

Después seguir A3–A7. La verificación de emuladores sigue siendo independiente.
No ejecutar `npm run deploy` ni `tools/cloudshell-release.sh` para este recorrido:
son los flujos del instalador, no los comandos directos que estás eligiendo.

## Verificación pendiente de emuladores, separada del despliegue

Requiere Java 21+, conexión para descargar el emulador cuando falta y espacio libre.
Desde la raíz del proyecto, después de detener los procesos anteriores:

```bash
export FIREBASE_EMULATORS_PATH="$(mktemp -d /tmp/explora-prueba-emulador-XXXXXXXX)"
firebase emulators:exec --project demo-explora-ledger --config firebase.ledger-emulator.json --only firestore,auth "node --test tests/settlement-emulator.test.mjs"
```

Esto ejecuta la prueba con Firestore/Auth locales, NO publica en producción. Puede
necesitar la misma descarga que quedó pendiente; ponerla en `/tmp` evita consumir
el poco espacio de `/home`, pero no garantiza una red rápida. El proyecto de esta
prueba debe seguir siendo `demo-explora-ledger`, nunca `explora-control-operativo`.
Un despliegue exitoso no demuestra que esta prueba haya pasado.

## GitHub: paso separado y manual

Los comandos `firebase deploy` NO suben código a GitHub. Para actualizar el repositorio,
el contenido de `santander-main/` corresponde a la raíz del repo, no a una carpeta
anidada. No subir el ZIP como único archivo ni reemplazar a ciegas cambios posteriores.

En la carpeta preparada de A, que ya contiene el clon y la comparación de V2, primero:

```bash
git remote -v
git status --short
git diff --stat
```

Revisar que `origin` sea `davidmanu97bj-lgtm/santander` y que solo se incluyan fuentes.
No agregar credenciales, datos de choferes, comprobantes ni exportaciones de Firestore.
La configuración entregada ignora dependencias, cachés, logs y varios formatos
sensibles, pero igualmente corresponde revisar lo que se va a subir.

Tras revisar los archivos:

```bash
git add .
git diff --cached --stat
git diff --cached
```

Después de revisar el contenido del commit (salir del visor con `q`):

```bash
git commit -m "Explora: saldos confirmados, colores y login" &&
git push origin HEAD:main
```

Si faltan identidad/permisos, una rama está protegida o GitHub rechaza la actualización,
no forzarla: resolver identidad, cambios o revisión por PR según corresponda. Los
comandos no cambian esas protecciones. No copiar contraseñas en `git config`.
Si se parte del ZIP de B no hay `.git`; integrar sus archivos en un clon separado
antes de intentar estos comandos. No hacer `git init` para reemplazar el historial.

## Referencias oficiales

Consultadas el 14/09/2026:
- Firebase CLI: https://firebase.google.com/docs/cli
- Publicar Functions: https://firebase.google.com/docs/functions/manage-functions
- Publicar Hosting: https://firebase.google.com/docs/hosting/quickstart
- Firestore Rules: https://firebase.google.com/docs/firestore/security/get-started
- Storage Rules: https://firebase.google.com/docs/storage/security/get-started

Las rutas, versiones y nombres del proyecto provienen del ZIP V2 y del registro
que compartiste. Esta guía no supone que se haya cambiado GitHub ni producción.
