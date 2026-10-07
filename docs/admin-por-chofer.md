# Administración por chofer — 7 de octubre de 2026

La pantalla inicial muestra una tarjeta por chofer activo. El saldo usa el mismo cálculo que la versión anterior. «Chofer debe» significa saldo a favor de Explora; «Explora debe» significa saldo a favor del chofer.

## Acciones de cada tarjeta

- **Movimientos:** consulta los movimientos del chofer. «Corregir un movimiento» abre la edición con ese chofer fijo.
- **Cierre / achique:** muestra sus cierres. «Gestionar pendientes» permite resolver los pedidos existentes; «Registrar pago / achique» registra un pago o ajuste ya realizado. El sistema no envía dinero al banco.
- **Comprobantes:** consulta los respaldos del mes y distingue «Sin adjunto» de «Sin comprobante · administración».
- **Contadora:** muestra exclusivamente el resumen mensual del chofer y permite descargar su PDF. Conserva el cálculo fiscal existente.
- **Facturas ARCA:** consulta los comprobantes de los viajes de ese chofer, con su emisor fiscal original. Abrir esta pantalla no emite facturas.
- **Deuda digital:** registra un gasto ya pagado por Explora para el chofer. El botón se marca en rojo e indica si falta cargar Canon, Patente o ambos en el mes actual.
- **100% chofer deuda:** registra una deuda individual; el selector del chofer queda fijo.

«Volver a choferes» regresa al listado. Los botones superiores abren **Operaciones**, **Gestión de choferes** y **Deuda grupal**. La deuda grupal conserva su regla: el importe completo se aplica a cada integrante, no se divide entre ellos.

## Operaciones

El control de salidas del aeropuerto continúa en su instancia original, dentro de Operaciones. Ocultar el panel no elimina salidas, vinculaciones ni pendientes. Allí también están las herramientas de Uber y calendario.

## Sin comprobante

Administración puede elegir «Sin comprobante» en carga digital, pago/achique, registro de pago de un cierre y «100% chofer deuda» individual. La elección deshabilita el archivo y guarda la identidad del administrador y la fecha del servidor. Se reinicia al abrir otra deuda; la deuda grupal sigue requiriendo un archivo. Los permisos de los choferes para adjuntar comprobantes no se amplían.

## Verificación

### Canon y patente mensuales

Desde el día 1, según la hora de Iguazú, cada chofer activo tiene dos recordatorios independientes. Son avisos de carga; no crean deudas ni transfieren dinero. La tarjeta cambia automáticamente al nuevo mes, incluso si el administrador deja abierta la página.

1. Abrir **Deuda digital** en la tarjeta del chofer.
2. Elegir **Canon** o **Patente** y el **mes al que corresponde**. Por defecto se propone el concepto pendiente del mes actual.
3. Elegir **50% chofer / 50% Explora** o **100% chofer**. Ingresar el importe total pagado, no la mitad.
4. Escribir el detalle y adjuntar respaldo, o elegir **Sin comprobante**.
5. Confirmar el pago digital. Sólo una operación guardada quita el aviso correspondiente; completar o cerrar el formulario no lo quita.

Una carga de $100.000 al 50/50 aumenta $50.000 lo que debe el chofer; con 100% chofer aumenta $100.000. Los IDs antiguos mantienen sus porcentajes originales. Cargar septiembre durante octubre completa septiembre, no octubre. Los registros digitales anteriores etiquetados Canon o Patente se reconocen por su fecha si no tienen mes explícito. Un texto libre en otro tipo de movimiento no se interpreta como carga mensual.

El registro y su control de duplicados se guardan en una transacción por chofer, concepto y mes. Los reintentos y administradores simultáneos no generan una segunda carga. Para corregir un importe usar Movimientos. Si se anula una carga, el aviso vuelve y se puede reemplazar sin borrar su historial. No se envían avisos periódicos adicionales a Telegram.

### Comprobaciones

- `npm test`: configuración, sintaxis, pruebas financieras y regresión.
- `node tools/inspect-admin-driver-cards.mjs`: vista local con datos ficticios, sin tráfico externo; Chromium y WebKit a 1440, 390 y 360 px, aislamiento por chofer, controles bloqueados y registros administrativos sin adjunto.
- `tests/admin-no-receipt-emulator.mjs`: permisos de Firestore contra un proyecto `demo-` y un emulador exclusivamente local. Requiere `EXPLORA_FIREBASE_CLIENT_ROOT` con el SDK y `FIRESTORE_EMULATOR_HOST` apuntando al emulador.

Las fórmulas de billeteras, caja chica, Uber, facturación y cierres no cambian. No hay migración ni reescritura de saldos históricos. La nueva interfaz reutiliza los flujos financieros existentes.
