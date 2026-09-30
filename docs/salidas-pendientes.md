# OPERACIONES: control de salidas del aeropuerto

Versión funcional: Operaciones v3 (2026-09-30). Amplía PR23, sin modificar documentos de cobros, saldos, billeteras, facturas ni cierres. No agrega tareas programadas ni avisos de Telegram.

## Uso desde el navegador

1. Recargar Explora e ingresar con administración. Abrir **Salidas de hoy**. El título conserva el acceso conocido, pero la tabla incluye pendientes y vínculos de todos los días.
2. Revisar los mensajes de Aeropuerto 2026 desde el último control, incluyendo los anteriores a las 06:00. Elegir el número y escribir la **fecha y hora real del mensaje**, hora de Iguazú/Argentina. Nunca sustituirla por la hora de revisión. «Usar hora actual» es una elección explícita.
3. Escribir una **referencia estable y única por salida**. Preferir el identificador del mensaje; si no está disponible, usar siempre fecha completa + hora + autor + texto exacto. Si un mensaje describe varias salidas, añadir el número y posición de cada evento a su referencia. Dos viajes distintos necesitan referencias distintas. Reutilizar exactamente la misma referencia al reintentar, incluso tras recargar.
4. Elegir tipo: propio; reemplazo interno (requiere cobro); Uber/por app (excluido); cobertura externa (excluido); origen/cobertura por confirmar (por revisar). Para cobertura externa o duda, agregar el aviso o motivo. La clasificación pertenece a esa salida, no al número para siempre.
5. Pulsar **Registrar salida**. Repetir para todas las salidas de la revisión antes de pulsar **Comparar cobros**. Elegir un número por sí solo no guarda nada. Un reintento del mismo mensaje devuelve el registro existente; una referencia repetida con otra hora o número se rechaza sin sobrescribir.
6. **Comparar cobros** vincula coincidencias únicas en ambos sentidos. No requiere que el cobro sea posterior al registro en la app, sólo a la salida real. No adivina por orden FIFO. Varias alternativas permanecen **Por revisar**; administración selecciona el cobro correspondiente y pulsa **Vincular cobro** después de comprobarlo.
7. Usar el filtro **Pendientes sin cobro encontrado** para el reclamo habitual. La antigüedad se calcula desde la salida real y se conserva entre días. La leyenda «2 h o más» permite reconocer los casos vencidos. **Por revisar** no es falta de cobro confirmada y **Excluido** no se reclama. Si faltan datos del servidor, se muestra revisión en vez de falsos pendientes.
8. Para corregir una clasificación aún no vinculada, abrir **Revisar clasificación**, indicar tipo y motivo, y **Guardar revisión**. Si otra persona la cambió, la app rechaza sobrescribir esa revisión. No permite reclasificar una salida ya vinculada.

El cambio de lista del aeropuerto no elimina nada. Número solo/R/remis puede indicar salida; T/taxi no corresponde. Punto = presente, raya = salió con viaje, X = ausencia sin viaje. Baja vacío conserva turno; sube con out lleva pasajeros hacia el aeropuerto. Estos criterios son para OPERACIONES: la app no interpreta automáticamente los mensajes ni lee WhatsApp.

## Integridad y alcance

- `markedAtMs`/`dayKey`: salida real Argentina; `createdAt`: registro del servidor por separado.
- ID determinista SHA-256 de la referencia del evento; creación transaccional. La deduplicación depende de conservar la referencia original, no de inventar una nueva en cada revisión. No intenta deduplicar por número/hora solos: eso fusionaría viajes legítimos.
- Metadatos de clasificación y su revisión quedan en `ops_number_exits`. Reserva exclusiva e inmutable en `ops_exit_payment_links/{paymentId}`. Un cobro no puede vincularse a dos salidas ni una salida consumir dos cobros, incluso con administradores simultáneos.
- El cruce relee salida, cobro y reserva en una transacción. Rechaza cobros anulados, privados, simulados o internos. Pago a Explora, gastos, deudas, ajustes y cierres no equivalen a un viaje.
- La comparación se hace sobre todos los datos disponibles del servidor. Cargar primero el lote completo de salidas evita vincular antes de conocer otra salida candidata. Casos de contexto incierto se registran como por confirmar y bloquean adjudicaciones automáticas a otra salida compatible.
- Las marcas anteriores de PR23 se conservan. No se pueden recuperar salidas que una versión anterior ya hubiera sobrescrito. No hay migración ni borrado financiero.
- Los controles de WhatsApp, posiciones de fila, vuelos de Aeropuertos Argentina y Telegram siguen en la automatización existente: esta entrega no los cambia ni envía recordatorios nuevos.

## Validación y publicación

Pruebas con datos ficticios: salida 08:00/cobro 08:30/registro 10:00; medianoche argentina/cambio de mes; pendientes de días anteriores; varias salidas del mismo número; reintentos después de recargar; competencia por un cobro; revisiones concurrentes; ambigüedad en ambos sentidos; exclusión por evento y reemplazos internos; lectura incompleta; conservación exacta de documentos financieros.

Las pruebas de transacciones usan el almacén en memoria, no cuentas reales. La compilación de reglas con Firebase dry-run verifica sintaxis, no sustituye una prueba completa de permisos en Firestore. La revisión visual se hace en un entorno local sin Firebase; en producción sólo se verifica carga/lectura, sin crear viajes ficticios.

Publicar reglas y Hosting de la misma revisión; recargar pestañas antiguas (no pueden crear documentos v2). Conservar la revisión anterior como respaldo. Revertir código/reglas no debe borrar documentos operacionales nuevos ni reservas exclusivas.

Validación de esta entrega: 435 pruebas aprobadas; reglas compiladas mediante dry-run. En navegador se comprobó el registro 08:00 con cobro 08:30 y carga 10:00, su reintento tras recargar (una sola fila), los casos ambiguos y la reclasificación individual sin errores de consola.
