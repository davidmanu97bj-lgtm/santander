# Actualización de saldo e historial

El inicio escucha las colecciones del chofer con Firestore `onSnapshot`. Cada cambio actualiza un índice por ID; solo se normalizan las altas y modificaciones recibidas y se quitan las bajas. Se mantienen los aliases de propiedad de los registros anteriores.

`onSnapshotsInSync` vacía los dibujos pendientes cuando los listeners afectados ya procesaron el cambio. El saldo y el historial usan entonces los mismos datos, sin esperar a una animación de números. Este evento sincroniza listeners entre sí: la confirmación del servidor se determina por los metadatos de cada snapshot. Se muestra «Guardando…» mientras hay escrituras pendientes y «Sin conexión» cuando corresponde.

Al confirmar una operación, la vista previa conserva su saldo inicial mientras llega el alta para evitar sumar dos veces el impacto en pantalla. En cobros, gastos y Gestión, ese punto de partida se actualiza justo antes de escribir, después de subir la foto y de las lecturas necesarias. El inicio sigue recibiendo cambios durante el guardado. Tras la confirmación se cierra el formulario inmediatamente, sin los antiguos temporizadores de 700–1300 ms.

Al volver a la app o recuperar conexión, se dibuja el estado disponible. Se reutilizan los listeners existentes; no se agregan consultas periódicas, funciones de servidor ni instancias permanentes. Las reglas de caja chica, reintegros, ARCA y los saldos históricos no cambian. La subida de imágenes y la confirmación remota siguen dependiendo de la conexión del dispositivo.

## Verificación

- `tests/realtime-balance.test.mjs`: importes exactos, normalización incremental con 1000 movimientos, metadatos, regreso a la app, bloqueo de doble impacto en los cuatro formularios y confirmaciones sin conexión.
- `tests/loading-performance.test.mjs`: coordinación del render, altas, modificaciones, bajas, caché y aislamiento entre sesiones.
- `tests/settlement-gross-flow.test.mjs`: concordancia de los cálculos del inicio, el historial y el servidor para cobros, gastos, Gestión y Uber.
- Prueba local con dos clientes Firestore: efectivo, digital, gasto y reintegro, corrección, eliminación y reconexión recibidos sin recargar.
- Prueba visual en dos pestañas y viewport de 412 × 915: gasto temporal de $1000, reintegro de $500 y saldo final idéntico al «Después» en ambas vistas. Se eliminó el registro de prueba y su imagen; no se enviaron facturas ni mensajes externos.

El 13/09/2026 pasaron las 186 pruebas del proyecto. Las pruebas locales no representan una medición de la red móvil de un teléfono Android real.
