# Salidas pendientes entre días

Cada toque en un número registra una salida independiente, con identificador único y fecha/hora del momento de la marca. La fecha operativa se calcula en Argentina. Un reintento conserva el mismo identificador y hora, sin sobrescribir otra salida.

El panel consulta las salidas históricas. Muestra todas las pendientes, las salidas de hoy y las vinculadas hoy. El contador de pendientes incluye cualquier día. Se actualiza al cambiar de día aunque el panel siga abierto.

El vínculo es uno a uno. Se guarda exclusivamente en `ops_number_exits` y `ops_exit_payment_links`, en una transacción que vuelve a leer el cobro. No modifica `billing_records`, billeteras, importes, fechas fiscales ni cierres. Dos administradores no pueden adjudicar el mismo cobro a dos salidas.

Se vincula automáticamente sólo cuando hay una única coincidencia en ambas direcciones: mismo número, cobro cargado desde el momento de salida, no privado, eliminado ni simulado. Si varias salidas o cobros son posibles, el administrador elige la fila y el cobro. Un cobro demorado puede pertenecer a una salida anterior: no se aplica FIFO arbitrariamente.

## Compatibilidad y publicación

- Las marcas antiguas activas que todavía existan se conservan con su fecha original. Los documentos que antes se sobrescribieron no se pueden reconstruir con este cambio.
- No hay migración ni borrado de movimientos financieros.
- Deben publicarse las reglas nuevas y el Hosting de la misma revisión. Las reglas anteriores no permiten crear las reservas exclusivas. Las nuevas reglas impiden que una pestaña antigua sobrescriba una salida: recargar las sesiones de administración después de publicar.
- No se ha probado una operación real contra producción. Las pruebas de transacciones usan el almacén en memoria; la sintaxis y permisos de reglas deben validarse con Firebase antes de publicar.
- Para volver atrás, conservar los documentos nuevos y restaurar el código/reglas de la revisión previa; no borrar vínculos ni registros financieros. La pantalla antigua no representa las salidas múltiples, por lo que una reversión pierde esa funcionalidad visual.

## Validación

`node tools/check.mjs`: 419 pruebas aprobadas, incluidas medianoche argentina/cambio de mes, cobros demorados varios días, múltiples salidas por número, reintentos y competencia por un mismo cobro. Se verificó que los documentos de cobros, saldos y cierres permanezcan idénticos.

Se revisó el panel en navegador local aislado: dos salidas del 30/09 siguen pendientes el 01/10, y vincular un cobro del 01/10 resuelve sólo una de ellas.
