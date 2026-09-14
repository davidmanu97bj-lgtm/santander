# QA de la entrega — saldos confirmados

Base original: `santander-main (79).zip`. Pruebas locales, datos sintéticos, sin
credenciales ni acceso a producción. No hubo publicación ni cambios en GitHub.

## Resultados ejecutados

| Comprobación | Resultado |
|---|---|
| `node tools/check-syntax.mjs` | 44 archivos correctos |
| `node tools/validate-project.mjs` | Correcta |
| `node tools/build-hosting.mjs` | `dist` generado y recursos verificados |
| `npm run test:ledger` | 23 pruebas aprobadas |
| Intento de todas las pruebas | 195 aprobadas, 4 cargas fallidas, 1 omitida |

Los registros de Node están en `PRUEBAS_SALDOS.txt` y `PRUEBAS_COMPLETAS.txt`.
Las cuatro cargas fallidas fueron `functions/tests/arca-integration.test.js`,
`functions/tests/uber-proof-ocr.test.js`, `functions/tests/uber-submission.test.js`
y `tests/uber-schedule-proof.test.mjs`: faltaron dependencias después del fallo
DNS de `npm ci`. No se anularon esas pruebas y no se declara aprobada la suite.

## Escenarios de la corrección

Apertura con revisión/hash y rechazo de revisión desactualizada; salto exacto de
$80.750; dos sesiones concurrentes; reintento idempotente tras respuesta perdida;
las tres responsabilidades de gastos; aceptación de deuda pendiente; anulación
con contrapartida y conservación de la entrada inicial; bloqueo de deriva externa;
identidad ajena y operaciones no permitidas.

Los handlers reales, cargados con servicios externos sustituidos, prueban además:
corrección y anulación de cobros, corrección de gastos, exclusión de caja digital,
Uber verificado y reintento, Gestión, cierre pendiente y pago confirmado, solicitudes
de adelanto concurrentes, comparación de revisiones en el cliente, intereses diarios
concurrentes, evento atrasado de Tiempo real, creación anterior a un corte aunque
se edite después y protección contra reset/borrado de identidad. La consulta de
historia detecta una posible discontinuidad de $80.750 sin alterar los documentos.

El test doble de Firestore implementa conflictos optimistas y falla si se intenta
leer después de escribir en la transacción nativa. No reproduce todos los límites,
la serialización, los permisos, índices ni los tiempos del SDK real.

## Pendiente antes de producción

Instalar dependencias, ejecutar la suite completa y `npm run test:ledger:emulator`.
El test de emuladores viene incluido, usa el SDK real, está limitado a hosts locales
y proyecto `demo-`, pero **no se ejecutó en este entorno**. También falta una prueba
visual/funcional de la aplicación autenticada, de sus permisos desplegados y del
envío real de Telegram en un entorno aislado.

No se auditó ni corrigió automáticamente el saldo real de ningún chofer. Las
fotografías históricas originales se mantienen. La activación exige revisión manual.

## Verificación del paquete

El ZIP conserva todos los archivos fuente originales de la entrega base y añade
los módulos, pruebas y guía. No lleva `node_modules`, `dist` generado, credenciales
ni una carpeta `.git`. El manifiesto `CAMBIOS.json` distingue archivos modificados
y agregados por comparación SHA-256 con el ZIP recibido.
