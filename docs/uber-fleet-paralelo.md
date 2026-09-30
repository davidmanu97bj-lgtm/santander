# Uber Fleet — comparación sin movimientos reales

## Estado de esta entrega

Esta versión incorpora una pantalla administrativa, importación CSV y conciliación en paralelo. **No está sincronizando una cuenta real de Uber, no registra cobros ni emite facturas ni envía Telegram.** No modifica el cierre semanal existente. El adaptador oficial de lectura está implementado y probado con respuestas ficticias; aún no está conectado a una función programada ni a credenciales de la cuenta.

El botón **Uber Fleet** aparece en Administración, también en móvil. El administrador carga un reporte de viajes y, cuando existe, su reporte de pagos; asocia el UUID de Uber con un chofer activo de Explora y confirma quién recibe el dinero digital. Primero compara y luego puede guardar el resultado. Un viaje sin asociación permanece en revisión.

La autorización se comprueba en el servidor con el administrador oficial existente. Los CSV sólo se envían a ese servidor; no se reenvían a Uber, ARCA ni Telegram. No se guardan contraseñas ni tokens en el navegador. Las vistas previas de factura no tienen validez fiscal.

## Confirmaciones del titular

- El 29/09/2026, el titular confirmó que Uber deposita los cobros digitales en su cuenta/de Explora. Al asociar los UUID reales de esta flota, corresponde seleccionar `digitalRecipient: explora`; no se deduce una asociación de choferes a partir de esta respuesta.
- Sigue pendiente definir quién absorbe la comisión de Uber. Recibir el depósito no implica asumir la comisión ni acredita que un viaje particular ya esté pagado. Se mantienen los controles de conciliación y revisión, sin movimientos financieros reales.

## Datos, conciliación y límites

- Acepta CSV UTF-8 con coma, punto y coma o tabulación, encabezados reconocidos en español o inglés, comillas y saltos de línea dentro de campos. Los dos archivos juntos admiten hasta 2 MB y 2000 filas; el servicio limita cada comparación a 100 viajes únicos.
- Las fechas deben indicar zona horaria; los importes ambiguos no se adivinan. Los exportados varían entre países: aún falta validar las columnas de un reporte real de esta cuenta. Los formatos en `tests/fixtures/uber-fleet-*-demo.csv` son **datos ficticios de referencia**, no exportaciones auténticas de Uber.
- Se conserva por separado bruto, comisión, neto, medio de pago, UUID del viaje y transacciones. Ganancias netas no equivale al bruto que se factura. Propinas, devoluciones y ajustes no se suman como nuevas ventas.
- El identificador estable usa proveedor, flota y UUID del viaje. La reimportación idéntica no crea otro viaje. Si la fuente cambia, se muestra una diferencia y se conserva la versión anterior; resolver/reemplazar formalmente esa evidencia es trabajo pendiente, no existe un botón para ignorar el conflicto.
- Se detectan transacciones reutilizadas, cobros reales ya vinculados, posibles cobros manuales del mismo conductor/fecha/importe y semanas Uber ya liquidadas. Las coincidencias aproximadas sólo generan observaciones.
- `planned` significa proyección preparada, nunca autorización fiscal ni cobro realizado. `review` necesita revisión y `unchanged` conserva la comparación ya guardada.
- Se reutiliza la política vigente del cobro individual: efectivo +60% y digital −40% sobre el bruto. Las comisiones distintas de cero, destinatario digital desconocido o pago no acreditado dejan el viaje en revisión. No se usa la liquidación OCR semanal para inventar un cobro individual.
- Origen, destino, kilómetros, fecha y alcance fiscal deben corroborarse. No se inventa «Viaje al centro». La alternativa descriptiva es «Servicio de traslado de pasajeros», manteniendo la emisión pendiente si faltan datos fiscales. Los nacionales mayores de 100 km e internacionales quedan en revisión.
- La primera versión consulta hasta 1000 registros históricos por chofer/colección y por flota. Al excederlos se detiene explícitamente; no anuncia una conciliación completa con datos truncados. Ampliar la consulta histórica requiere una mejora posterior.

Sólo hay escrituras en `uber_fleet_shadow_trips`, `uber_fleet_shadow_imports` y `uber_fleet_shadow_settings`. Las reglas bloquean acceso directo del cliente; se usan las funciones administrativas. No hay disparadores financieros en esas colecciones. Los reportes y rutas son privados y quedan dentro de la infraestructura existente de Explora.

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
