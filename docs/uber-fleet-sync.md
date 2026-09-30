# Sincronización automática Supplier en observación

El servidor puede ejecutar `createFleetShadowSync(...).run()` desde una tarea programada, sin abrir Explora ni pulsar botones. Este módulo no registra una tarea por su cuenta ni activa producción. Hace lecturas oficiales de Uber y guarda observaciones en colecciones separadas; nunca escribe cobros, billeteras, facturas, Telegram ni cierres semanales.

## Integración

Exporta CommonJS `{createFleetShadowSync, readSyncEnvironment, syncStateId, FleetSyncError, SYNC_COLLECTIONS, SYNC_LIMITS}`.

```js
const {createFleetShadowSync} = require('./uber-fleet-sync');
const sync = createFleetShadowSync({
  db,
  fetchImpl: serverFetch,
  loadConfig: async () => ({enabled, organizationId, startTimeMs}),
  loadCredentials: async () => ({clientId, clientSecret}),
});
// Llamar desde el planificador del servidor; no desde una petición del navegador.
const outcome = await sync.run();
```

`loadCredentials` se invoca sólo cuando está habilitado. El llamador debe obtener esos valores del almacenamiento de secretos del servidor. No hay búsqueda de credenciales en archivos, navegador o Firestore. El cliente de API se inyecta únicamente para las pruebas; el predeterminado es `createSupplierClient`. Todas las pruebas inyectan respuestas y no hacen solicitudes reales.

El cargador predeterminado utiliza `UBER_FLEET_SYNC_ENABLED === 'true'`, `UBER_FLEET_ORGANIZATION_ID` y `UBER_FLEET_SYNC_START_MS`. Sin la bandera exacta queda inactivo. La fecha inicial es obligatoria: evita declarar una cobertura histórica que nunca se observó. No se puede cambiar una cobertura ya iniciada silenciosamente. Si el planificador añade configuración desde un documento, debe combinarla con la bandera de entorno como condición de habilitación, no sustituirla.

## Estado y aislamiento

- `uber_fleet_shadow_sync/application_lock`: exclusión global por aplicación; propietario, vencimiento y próxima solicitud permitida.
- `uber_fleet_shadow_sync/${syncStateId(organizationId)}`: progreso y último resultado. `captureThroughMs` representa captura reciente; `continuousThroughMs` se detiene ante el primer hueco. `coverageStartMs` fija el comienzo explícito de la cobertura.
- `uber_fleet_shadow_observations/<id>`: observaciones inmutables, deduplicadas por organización, transacción y hash canónico del contenido. Un cambio de contenido conserva una nueva versión, sin reemplazar la anterior. `rawJson` conserva los valores de origen; no expresa centavos ni unidades monetarias interpretadas.
- `uber_fleet_shadow_sync_gaps/<id>`: intervalos que necesitan recuperar reportes oficiales. Incluye `fromMs`, `toMs` y estado `requires_official_report_backfill`.

Los datos crudos pueden contener información personal; estas colecciones deben permanecer sin acceso directo del navegador. Un estado administrativo puede devolver sólo contadores, códigos estáticos y fechas. `apiAccessVerifiedAtMs` significa que se verificó pertenencia a la organización en ese momento; no significa que haya cobros automáticos activos ni que todas las consultas posteriores hayan funcionado.

`run()` devuelve `mode: 'shadow'`, `liveEnabled: false`, `financialWritesEnabled: false` y un estado: `disabled`, `busy`, `caught_up`, `catching_up`, `history_gap`, `blocked` o `budget_exhausted`. Los resultados habilitados incluyen contadores y progreso. Los fallos sólo devuelven códigos controlados, sin respuestas, tokens, credenciales ni mensajes privados del proveedor.

## Continuidad

El proceso tiene un bloqueo con vencimiento de dos minutos y comprueba su propietario antes de cada escritura. Un trabajador que perdió ese bloqueo no puede guardar una respuesta tardía ni liberar el bloqueo del nuevo trabajador. La separación global mínima de solicitudes es 1100 ms; persiste entre ejecuciones. El cliente también verifica el límite local.

Cada ejecución procesa hasta cuatro ventanas de quince minutos y veinte páginas por ventana, con presupuesto de cuatro minutos. Vuelve a leer dos minutos anteriores y espera cinco minutos antes de dar por capturada la parte reciente. Estos márgenes son decisiones conservadoras del adaptador, no una promesa de definitividad de los datos de Uber.

El progreso temporal avanza sólo después de guardar todas las páginas. Los cursores de páginas no se persisten: son temporales y pertenecen a una instancia del cliente. Ante una caída se vuelve a consultar la ventana desde el principio; las observaciones ya guardadas se deduplican. Los lotes incompletos no adelantan el progreso.

La API limita el histórico a 24 horas. Si el progreso se aproxima al límite, se conserva un hueco explícito y se reanuda captura reciente con margen. `recoveryRequired` permanece activo y el estado nunca pasa a `caught_up` mientras exista ese hueco; `continuousThroughMs` no salta el intervalo ausente. Esta versión **detecta y registra** los huecos: no implementa todavía la descarga y conciliación de reportes históricos para cerrarlos. Evita perderlos silenciosamente, pero no puede recuperar por sí sola lo que Uber ya no entrega por esta API. [Contrato de transacciones](https://developer.uber.com/docs/vehicles/references/api/v1/supplier-performance-data/get-realtime-transactions), [reportes oficiales para recuperación](https://developer.uber.com/docs/vehicles/references/api/v1/vehicle-suppliers/suppliers/generate-report).

## Límites para cobros reales

El acceso Supplier debe estar autorizado para la organización y los scopes. El formato monetario público presenta discrepancias entre `amountE5` y `amountES`, por lo que el adaptador conserva el valor original sin inferir bruto, comisión o neto. Confirmar que el reparto corresponde al neto define la regla de negocio, pero no resuelve las unidades ni categorías del proveedor. Hace falta verificar una respuesta real autorizada y su desglose antes de llevarla al circuito financiero. La API de transacciones no ofrece sandbox. [Documentación y limitaciones del adaptador](uber-fleet-api.md).

Validación local:

```text
node --test --test-isolation=none functions/tests/uber-fleet-sync.test.js functions/tests/uber-fleet-api.test.js
```
