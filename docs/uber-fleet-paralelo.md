# Uber Fleet — comparación sin movimientos reales

## Estado de esta entrega

Esta versión incorpora una pantalla administrativa, importación CSV, conciliación en paralelo y un proceso programado en el servidor cada cinco minutos. **No está sincronizando una cuenta real de Uber, no registra cobros ni emite facturas ni envía Telegram.** No modifica el cierre semanal existente. La función programada está deshabilitada por defecto y aún no tiene credenciales ni permisos de la cuenta verificados.

El botón **Uber Fleet** aparece en Administración, también en móvil. El administrador carga un reporte de viajes y, cuando existe, su reporte de pagos; asocia el UUID de Uber con un chofer activo de Explora y confirma quién recibe el dinero digital. Primero compara y luego puede guardar el resultado. Un viaje sin asociación permanece en revisión.

La autorización se comprueba en el servidor con el administrador oficial existente. Los CSV sólo se envían a ese servidor; no se reenvían a Uber, ARCA ni Telegram. No se guardan contraseñas ni tokens en el navegador. Las vistas previas de factura no tienen validez fiscal.

## Confirmaciones del titular

- El 29/09/2026, el titular confirmó que Uber deposita los cobros digitales en su cuenta/de Explora. Al asociar los UUID reales de esta flota, corresponde seleccionar `digitalRecipient: explora`; no se deduce una asociación de choferes a partir de esta respuesta.
- También el 29/09/2026 confirmó que el reparto para las billeteras se calcula sobre el **neto después de comisión de Uber**, no sobre el bruto. La política específica es `uber_net_after_commission_cashbox_10_v1`: en el depósito digital confirmado a Explora, la parte del chofer es el 40% del neto. La tarifa bruta se conserva por separado para revisar la factura. Recibir el depósito no acredita que un viaje particular ya esté pagado.
- Si el chofer cobra efectivo, además del neto hay que comprobar dónde Uber descontó la comisión: el efectivo bruto en manos del chofer no desaparece por calcular el reparto sobre el neto. Esos casos quedan en revisión hasta contrastar la liquidación real.

## Datos, conciliación y límites

- Acepta CSV UTF-8 con coma, punto y coma o tabulación, encabezados reconocidos en español o inglés, comillas y saltos de línea dentro de campos. Los dos archivos juntos admiten hasta 2 MB y 2000 filas; el servicio limita cada comparación a 100 viajes únicos.
- Las fechas deben indicar zona horaria; los importes ambiguos no se adivinan. Los exportados varían entre países: aún falta validar las columnas de un reporte real de esta cuenta. Los formatos en `tests/fixtures/uber-fleet-*-demo.csv` son **datos ficticios de referencia**, no exportaciones auténticas de Uber.
- Se conserva por separado bruto, comisión, neto, medio de pago, UUID del viaje y transacciones. Ganancias netas no equivale al bruto que se factura. Propinas, devoluciones y ajustes no se suman como nuevas ventas.
- El identificador estable usa proveedor, flota y UUID del viaje. La reimportación idéntica no crea otro viaje. Si la fuente cambia, se muestra una diferencia y se conserva la versión anterior; resolver/reemplazar formalmente esa evidencia es trabajo pendiente, no existe un botón para ignorar el conflicto.
- Se detectan transacciones reutilizadas, cobros reales ya vinculados, posibles cobros manuales del mismo conductor/fecha/importe y semanas Uber ya liquidadas. Las coincidencias aproximadas sólo generan observaciones.
- `planned` significa proyección preparada, nunca autorización fiscal ni cobro realizado. `review` necesita revisión y `unchanged` conserva la comparación ya guardada.
- Para Uber se proyecta sobre el neto conciliado: digital −40%, efectivo sin comisión +60%. El efectivo con comisión, destinatario digital desconocido, pago no acreditado o diferencias entre bruto/comisión/neto quedan en revisión. No se usa la liquidación OCR semanal para inventar un cobro individual. Los cobros propios de Explora y las liquidaciones históricas conservan sus reglas.
- Origen, destino, kilómetros, fecha y alcance fiscal deben corroborarse. No se inventa «Viaje al centro». La alternativa descriptiva es «Servicio de traslado de pasajeros», manteniendo la emisión pendiente si faltan datos fiscales. Los nacionales mayores de 100 km e internacionales quedan en revisión.
- La primera versión consulta hasta 1000 registros históricos por chofer/colección y por flota. Al excederlos se detiene explícitamente; no anuncia una conciliación completa con datos truncados. Ampliar la consulta histórica requiere una mejora posterior.

La comparación sólo escribe en `uber_fleet_shadow_trips`, `uber_fleet_shadow_imports` y `uber_fleet_shadow_settings`. El proceso automático sólo escribe observaciones, estado y brechas en `uber_fleet_shadow_observations`, `uber_fleet_shadow_sync` y `uber_fleet_shadow_sync_gaps`. Las reglas bloquean acceso directo del cliente; no hay disparadores financieros en esas colecciones. Los reportes y rutas son privados y quedan dentro de la infraestructura existente de Explora.

## Ejecución automática y detención

`uberFleetObserveAutomatically` se ejecuta cada cinco minutos en Cloud Scheduler, sin depender de abrir la app ni de pulsar un botón. Necesita **ambas** habilitaciones: `UBER_FLEET_SYNC_ENABLED=true` en el despliegue y `enabled=true` en `uber_fleet_shadow_settings/automatic`, donde se indican `organizationId` y `startTimeMs` verificados. Sin la primera no se enlazan secretos; sin cualquiera de las dos no consulta Uber. Las credenciales se enlazan sólo mediante los secretos `UBER_FLEET_CLIENT_ID` y `UBER_FLEET_CLIENT_SECRET` al habilitar el despliegue.

Para detener consultas sin afectar cobros existentes, un operador autorizado puede poner `enabled=false` en ese documento. El apagado se aplica al siguiente ciclo; una lectura ya iniciada puede terminar de guardar observaciones sin efectos financieros. El proceso verifica el acceso de la organización, respeta ventanas y límites del proveedor, conserva el progreso y detecta brechas históricas. No convierte las unidades monetarias ambiguas de la API en cobros. Los fallos se registran únicamente con códigos saneados.

**Este proceso es de observación automática, no la automatización financiera terminada.** La conexión a `billing_records`, facturas y Telegram exige validar una respuesta real, identidad de Ramiro, pago, política y fecha de corte; no se habilita por instalar el proceso programado. Los avisos de inicio de viaje requieren además el acceso a eventos Fleet.

## Protección fiscal adicional

La auditoría encontró que un cobro ficticio con marcas de simulación podía llegar a ARCA. Ahora el generador y el trabajador verifican tanto la fuente como las solicitudes históricas, antes de contactar ARCA. Las marcas de simulación también se rechazan en cobros creados por un chofer. `suppressTelegram` por sí solo no bloquea una factura real. Una serie fiscal con resultado incierto conserva su bloqueo, incluso al detectar una simulación; no se libera ni reutiliza numeración automáticamente.

## Para conectar los viajes reales

1. Confirmar que Uber habilitó la aplicación para la organización, con `vehicle_suppliers.organizations.read` y `supplier.partner.payments`. El acceso al Portal de Proveedores no garantiza esos permisos. Webhooks Fleet también requieren alta con Uber. Ver fuentes y contrato en [uber-fleet-api.md](uber-fleet-api.md).
2. Obtener una respuesta autorizada y reportes de esta cuenta. Resolver las discrepancias monetarias/paginación que aparecen en la documentación pública antes de interpretar importes. No hay sandbox de las transacciones en tiempo real ni del evento de estado de conductor; las pruebas de este repositorio son locales.
3. Conciliar bruto del pasajero, comisión, propinas, neto y efectivo/digital con la liquidación real, definiendo quién soporta los costos. Asociar los conductores por UUID y definir una fecha de corte para impedir que lo individual se contabilice otra vez en el cierre semanal.
4. Incorporar el receptor de eventos y el proceso de consulta a las colecciones de observación. Un estado de conductor en viaje puede producir una novedad operativa; nunca prueba por sí mismo la recepción del dinero.
5. Sólo después, habilitar la creación de un único `billing_records` por viaje finalizado y conciliado. Ese registro puede reutilizar la cola ARCA y Telegram existentes, respetando sus controles. La factura pendiente no se presenta como autorizada. Una alerta de viaje recibido y la de cobro deben tener identidades diferentes.

Mientras Uber no habilite la API, la alternativa implementada es importar los reportes. No promete notificación inmediata de cada viaje: los reportes de actividad/pagos tienen demoras y su descarga es manual. No se automatiza una sesión privada del portal ni se usa la API de pasajeros como si fuera Fleet.

## Comprobación local

Node 22. La verificación normal es `npm test` y `npm run build`. En el entorno Windows restringido, el corredor con procesos aislados puede fallar con `spawn EPERM`; las mismas pruebas pueden ejecutarse con `node --test --experimental-test-isolation=none` indicando los archivos de ambas carpetas de pruebas.

La vista local existente se inicia con `PREVIEW_ROLE=admin` y `node tools/preview.mjs`. Reemplaza Firebase por datos locales y bloquea conexiones externas en el navegador. La prueba usa exclusivamente los CSV sintéticos de `tests/fixtures`, el identificador `flota-prueba` y un chofer ficticio. No se deben cargar pruebas en las colecciones financieras reales.

Las pruebas cubren CSV inválidos/ambiguos, viajes repetidos y modificados, asociaciones, efectivo/digital, comisiones, cobros pendientes, solapamientos, transacciones reutilizadas, acceso administrativo, guardado concurrente y aislamiento de billeteras/ARCA/Telegram. Las reglas tienen comprobaciones estáticas; su validación con emulador permanece pendiente.
