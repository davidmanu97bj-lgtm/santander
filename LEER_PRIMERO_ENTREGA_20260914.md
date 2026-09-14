# Explora — entrega de colores, login y Cloud Shell

**Instalador V2: corregida la detección de archivos nuevos frente a eliminaciones.** Ver `LEER_PRIMERO_INSTALADOR_V2.md`.

**14/09/2026 · Base: Explora_completo_saldos_confirmados_GitHub.zip.**
Este paquete reemplaza la entrega anterior completa; **incluye la corrección de saldos confirmados**. No es necesario instalar primero el ZIP anterior. No se publicó nada en GitHub ni en Firebase durante su preparación.

## Cambios visuales, sin cambiar las cuentas

| Movimiento | Color |
|---|---|
| Cobro digital | Verde |
| Caja digital 5% | Rojo |
| Cobro efectivo | Rojo |
| Caja efectivo 5% | Rojo |
| Gasto compartido 50/50 | Rojo |
| Reintegro de gasto | Verde |
| Gasto 100% Explora | Verde |
| Gasto 100% chofer | Rojo |
| Pagar a Explora | Verde |
| Cobrar a Explora | Rojo |

Se aplican a los acentos visuales (ícono, importe/impacto, grupos y confirmación) de las acciones, formularios, historial antiguo y confirmado, Gestión y revisión/edición administrativa. Los textos de explicación y los saldos «Antes/Después» mantienen su diseño; el color del saldo general sigue expresando quién debe a quién. Las pantallas archivadas no cargadas por `index.html` se conservan sin reescribirlas.

**Verde no equivale a signo positivo.** El digital continúa con principal −100% y caja +5%; efectivo con +100% y caja +5%. El gasto compartido conserva principal +100% y reintegro −50%; el gasto 100% Explora conserva su principal y reintegro completo existentes. No se cambian fórmulas, porcentajes, cantidades, orden de registros ni documentos del servidor. Uber y conceptos ajenos a la lista conservan sus tonos.

`movement-colors.js` decide exclusivamente presentación. `movement-colors.css` contiene exclusivamente propiedades de color; no cambia tamaños ni distribución. Los archivos de Functions y las Rules son idénticos a la entrega de saldos confirmados.

## Inicio de sesión

Se inicia Firebase Auth desde `auth-session.js`, antes de terminar de descargar los módulos del panel. Se usa `initializeAuth` sin el inicializador de ventanas/redirecciones federadas que la app no utiliza; se mantienen usuario/contraseña, aliases, sesiones antiguas en IndexedDB y las alternativas local/session/memoria. Se evita volver a migrar la persistencia inmediatamente después de `getAuth`.

Las búsquedas históricas de perfil por UID y por email empiezan juntas cuando faltan ambos perfiles directos. Se conserva la prioridad del perfil por UID, los roles, la desactivación del chofer y el rechazo de respuestas de una sesión anterior. No se habilitan saldos ni operaciones financieras antes de su comprobación.

Esto elimina trabajo evitable del arranque, pero **no es una medición en un iPhone ni Android físico, ni garantiza una duración concreta**. La red, el tiempo de respuesta de Auth/Firestore y el historial de cada cuenta siguen influyendo. No se activaron instancias mínimas de pago ni se debilitó la autenticación.

Fundamento oficial: Firebase explica que el resolver predeterminado de ventanas puede abrir un iframe adicional en navegadores móviles: https://firebase.google.com/docs/auth/web/custom-dependencies . Se conserva la misma versión del SDK que tenía la app, 11.10.0.

## Un archivo para Cloud Shell

La entrega incluye **`EXPLORA_AUTOGESTION_V2.sh`**, que contiene en su interior un ZIP completo de este proyecto y comprueba su SHA-256 antes de extraerlo. No contiene claves privadas, contraseñas ni tokens de acceso. Subir ese archivo a Cloud Shell; no hace falta pegar código ni subir los módulos uno por uno.

Desde la carpeta donde se subió (normalmente `$HOME`):

```bash
bash EXPLORA_AUTOGESTION_V2.sh --publicar
```

El script pide las autorizaciones de GitHub y Firebase únicamente cuando hacen falta. No las puede saltar. Al final de las verificaciones pide escribir **PUBLICAR EXPLORA** para confirmar el push y el despliegue. Antes de confirmar, pausar los registros de los choferes, revisar los cambios y tener una copia de seguridad de Firestore. El respaldo Git que crea el script **no respalda la base de datos**.

La publicación está configurada, según el proyecto entregado, para:

- GitHub: `davidmanu97bj-lgtm/santander`, rama `main`.
- Firebase: `explora-control-operativo`.
- Orden: commit/push GitHub → Firestore Rules, índices y Storage Rules → Functions → Hosting.

No alcanza con publicar solo Hosting: esta entrega también incluye la migración de saldos del paquete anterior. Functions y Rules no se editaron en esta revisión de colores, pero todavía necesitan publicarse si la entrega anterior no se desplegó.

### Qué hace el script

1. Extrae en una carpeta nueva, instala Node 22 de forma local si es necesario y comprueba herramientas. Si falta Java 21+ o GitHub CLI, pide autorización para instalar mediante apt. Requiere internet.
2. Autoriza acceso, clona `main` sin tocar una copia de trabajo anterior y crea `github-antes.bundle`. Compara las huellas y verifica el commit original del ZIP 79 en el historial Git. Los archivos incorporados en las entregas locales se distinguen de las eliminaciones reales. **No pisa cambios desconocidos ni restaura archivos que fueron borrados después de esas bases.**
3. Instala las dependencias fijadas del backend, ejecuta toda la suite, los controles de despliegue, la compilación y la prueba de Firestore/Auth en emuladores `demo-explora-ledger`. Un fallo detiene la publicación; no hay un modo que ignore pruebas.
4. Pide confirmación, crea el commit local y lo sube a `main` sin `--force`. Si la rama está protegida, falta permiso o `main` cambió, se detiene antes de desplegar Firebase. No cambia las protecciones de GitHub.
5. Usa el desplegador existente, que publica una copia del commit confirmado en `main`. Registra las etapas terminadas en `~/explora-despliegues/release-.../`. Ante un fallo parcial no hace rollback automático ni anuncia publicación completa.

**GitHub guarda el código; Firebase Hosting publica la web.** El script conecta ambos pasos; un push por sí solo no se presenta como un despliegue de la aplicación.

La autenticación de GitHub CLI puede guardar credenciales en el entorno de Cloud Shell conforme a su configuración; no se agregan al ZIP ni al repositorio. No compartir la carpeta de credenciales del entorno. Manual oficial: https://cli.github.com/manual/gh_auth_login . Ayuda de carga de archivos: https://docs.cloud.google.com/shell/docs/uploading-and-downloading-files .

### Modos sin publicación

```bash
# Solo extraer y verificar la integridad del ZIP: no autentica ni usa la nube.
bash EXPLORA_AUTOGESTION_V2.sh --extraer

# Instalar dependencias locales y verificar, sin push ni deploy.
bash EXPLORA_AUTOGESTION_V2.sh --verificar
```

Con el proyecto ya descomprimido, también se puede ejecutar `bash tools/cloudshell-release.sh --verificar` o `--publicar`. Los accesos `.sh` antiguos permanecen por compatibilidad; el asistente de esta entrega es **`EXPLORA_AUTOGESTION_V2.sh`**.

## Después de desplegar

Ingresar como David, **Admin → Saldos seguros**: revisar y activar una vez las cuentas con historial, según `LEER_PRIMERO_SALDOS_CONFIRMADOS.md`, conservado en la raíz del proyecto. Esta entrega no activa cuentas, no concilia automáticamente los saldos antiguos y no carga el ajuste de $80.750 del ejemplo. Las cuentas históricas sin activar siguen bloqueadas para registrar nuevos movimientos.

Comprobar en Safari/iPhone y Chrome/Android reales: entrada con sesión existente, entrada por usuario/contraseña, salida, perfiles inactivos, los diez colores y un par de registros simultáneos **en un entorno aislado de producción**. Una URL de preview con la configuración actual seguiría usando el proyecto real: no emplearla para cargar operaciones ficticias.

## Pruebas de esta entrega y límites

**Aprobado localmente:** sintaxis de 46 archivos JavaScript; compilación completa de Hosting; 111 pruebas seleccionadas de colores, login, recálculo de vistas previas, saldo confirmado y despliegue; 10 pruebas Python del copiado seguro; colores calculados por el navegador en vistas de 390, 412 y 1280 píxeles con datos sintéticos y red externa bloqueada; sintaxis de los scripts Bash.

En el intento de suite completa: **215 aprobadas, cuatro archivos de prueba bloqueados por dependencias ausentes y una prueba de emuladores omitida**. `npm ci` no pudo descargar paquetes por `EAI_AGAIN` (DNS/conectividad) y terminó con un error de npm. Faltaron `node-forge` y módulos de Firebase. No se declara aprobada la suite completa. No se ejecutaron Firebase/Rules en el emulador ni una autenticación/despliegue real en este entorno. El script exige que esas pruebas sí pasen en Cloud Shell antes de publicar.

La prueba visual usa Chromium de escritorio con esos anchos: **no es Safari ni Chrome Android físico**. Comprueba la cascada CSS y los signos/números del renderizado original. No se midió una reducción en segundos del login real.

Los cambios y huellas de integridad están en `docs/colores-login-cloudshell/CAMBIOS_Y_QA.json`. Se mantiene completa la documentación de la migración de saldos anterior; sus controles y límites de costo/lecturas siguen vigentes.
