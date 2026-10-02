# Login, retiro de disponibilidad y billetera Uber

Pedido de David del 02/10/2026. Base revisada: `ed044d4`, posterior al PR 25
(`b92050b149b585a48d52842601284764bee6b664`). Los cambios se preparan para revisión;
este trabajo no fusiona ni despliega y no accede a datos de producción.

## Acceso y carga inicial

La pantalla «Cargando tu cuenta» ocupa el viewport mediante un contenedor fijo,
con altura dinámica, márgenes de área segura y scroll disponible. El formulario
centra la tarjeta cuando hay espacio; en alturas pequeñas permite recorrerla
completa, incluyendo mensajes de error y el borde inferior. Los márgenes
automáticos se reducen antes de desplazar contenido fuera del área visible.
La configuración del viewport solicita el ajuste de altura al teclado en los
navegadores que lo soportan.

La emulación inicial no reprodujo el recorte informado. La corrección refuerza la
contención de ambas pantallas frente a cambios de altura y desplazamiento; no
modifica autenticación, restauración de sesión ni tiempos de carga.

## Funciones retiradas

Se eliminan Adjudicar número y Libre/Ocupado, sus entradas, suscripciones y vistas
de prueba. Salidas de hoy, su registro, el selector remis de cobros y la
comparación de cobros conservan su implementación independiente.
Ver [detalle del retiro](disponibilidad-pendiente.md).

## Uber: decisiones confirmadas

David especificó que el administrador carga cada cierre semanal utilizando la
información de Uber Fleet. Los importes son el efectivo retenido por el chofer
y el digital neto recibido por Explora, con comisiones de Uber ya descontadas.
No se importa automáticamente el análisis Fleet en modo shadow.

La nueva política debe quedar identificada en cada nuevo registro. Los modelos
anteriores, documentos existentes y cierres previos conservan sus reglas. El
desglose no puede reconstruirse como medio real de cobro cuando un registro
histórico sólo guardó un total clasificado contablemente como efectivo.

El marcador `uber_admin_fleet_split_10_v1` aplica el reparto de las billeteras:
mitad de la diferencia efectivo/digital más caja chica del 10% del neto
conciliado. La caja y el resultado de cada semana se fijan en centavos enteros.
Ejemplos sin otros movimientos:

| Efectivo | Digital | Caja chica | Resultado por Uber |
| ---: | ---: | ---: | --- |
| $10.000 | $0 | $1.000 | Chofer pasa $6.000 a Explora |
| $0 | $10.000 | $1.000 | Explora pasa $4.000 al chofer |
| $6.000 | $4.000 | $1.000 | Chofer pasa $2.000 a Explora |
| $0 | $0 | $0 | Sin transferencia |

La tarjeta UBER se ubica debajo de Digital y desglosa importes ya incluidos en
las billeteras y la caja chica. No agrega una segunda transferencia ni vuelve a
sumar sus importes: se compensan en el único cierre de período existente.

La carga requiere un administrador habilitado, un chofer activo, la última
semana habilitada según el calendario existente, referencia de Fleet y
confirmación de conciliación. La transacción canonicaliza el UID, busca sus
alias históricos y rechaza una semana ya cargada o pendiente. Un reintento
idéntico devuelve el documento existente. No realiza cargas retroactivas.
La entrada de alta del chofer se retira y el backend antiguo rechaza nuevos
asientos; los documentos anteriores mantienen sus flujos históricos de lectura
y revisión.

Los importes netos deben estar conciliados y ser no negativos. Un saldo digital
negativo requiere resolver la conciliación antes del asiento: no se transforma
en cero ni se inventa un ajuste de comisiones.

El neto de Fleet no acredita el bruto fiscal. En los informes mensuales aparece
como conciliación separada; no se inserta en la base fiscal del 40%. Cuando
existen estas nuevas semanas, la interfaz y el PDF indican **base incompleta**
y muestran sólo el subtotal conocido. La fórmula fiscal, facturas emitidas y
los informes sin nuevas semanas permanecen iguales. Completar el bruto fiscal
requiere una fuente y un alcance específicos; este cambio no los inventa.

## Reproducción local

Con Node 22:

```sh
npm ci --ignore-scripts
npm ci --prefix functions --ignore-scripts
npm test
npm run build
node tools/inspect-login-layout.mjs
node tools/inspect-charge-classification.mjs
node tools/inspect-uber-wallet.mjs
git diff --check
```

Las herramientas visuales usan un servidor en localhost, Firebase sustituido
por un adaptador en memoria y navegadores nuevos con perfil temporal. No usan
el navegador operativo. Las capturas se guardan fuera del repositorio.

La prueba de login abarca Edge/Chromium y WebKit a 320×568, 390×844, 768×1024,
1440×900, 844×390 y 390×300, más errores reales del adaptador local, perfil
demorado, rotación, reapertura y foco con teclado/áreas seguras simulados.
No sustituye una comprobación con teclado físico en iPhone o Android.

La prueba visual de Uber ejecuta 14 casos en Edge/Chromium y WebKit a
320/390/768/1440 px: efectivo, digital, mixto, cero y centavos. Incluye
`100 / 0,17 → 59,94` y `100 / 1,95 → 59,23`, reintento después de fallo de red,
duplicados, negativos y denegación al chofer. Las pruebas numéricas también
cubren 200 variantes de centavos, registros acumulados y saldos anclados.
La suite completa pasó 460 pruebas con Node 22.16.0; build y diff-check correctos.

Los cambios principales están en `index.html`/`styles.css`, `app.js`,
`admin-uber-liquidation-ui.js/css`, `period-ui.js`, `functions/admin-uber-weekly.js`,
`functions/uber-weekly-policy.js`, `functions/telegram-billing-balance.js`,
`functions/period-closure.js` y `firestore.rules`. Se adaptaron los informes de
lectura para no confundir neto con bruto, el paquete de publicación, el preview
aislado y sus pruebas. Los módulos y previews exclusivos de disponibilidad
fueron eliminados; `ops-salidas.js/css` sólo pierde la dependencia de sus estilos.

Una publicación futura debe actualizar reglas y Functions además de la web.
Los cambios de código no desactivan las funciones actualmente desplegadas.
La fusión y el despliegue requieren aprobación separada.
