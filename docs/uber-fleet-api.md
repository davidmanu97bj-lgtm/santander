# Adaptador oficial Uber Supplier: lectura en paralelo

Revisado contra documentación pública oficial el 29 de septiembre de 2026. El módulo no está conectado a una función desplegada, tarea programada, billetera, factura ni Telegram. Importarlo o construir un cliente no hace solicitudes. No se buscaron credenciales ni se hicieron llamadas autenticadas a Uber. Las pruebas usan únicamente un transporte inyectado y datos ficticios.

## Contrato local

CommonJS, servidor Node 22:

```js
const {
  createSupplierClient,
  verifySupplierWebhookSignature,
  SupplierApiError,
  SUPPLIER_SCOPES,
} = require('./uber-fleet-api');
```

`createSupplierClient({clientId, clientSecret, fetchImpl, now = Date.now, timeoutMs = 10000})` devuelve solamente los métodos siguientes. `fetchImpl` es obligatorio: no hay transporte global por defecto ni lectura de variables de entorno. `now()` devuelve milisegundos Unix. `timeoutMs` admite 1–10000 para poder probar vencimientos sin esperas largas. Las credenciales y los tokens quedan dentro del cierre del cliente, sin registros ni persistencia.

- `await client.getOrganizations()` → `{organizations: [{id, parentOrganizationId, name, types}]}`. Los campos opcionales ausentes son `null`. Las organizaciones autorizadas se guardan internamente; la consulta de transacciones las vuelve a obtener cuando la lista tiene al menos un minuto. La API de Uber sigue aplicando sus permisos a cada solicitud.
- `await client.getRealtimeTransactions({organizationId, startTime, endTime, cursor?})` → `{observations, nextCursor, issues}`. Tiempos en milisegundos Unix UTC, ventana mayor que cero y de hasta 15 minutos, dentro de las últimas 24 horas, sin fechas futuras. Obtiene una página de hasta 500 filas. No sigue automáticamente la paginación.
- Cada observación tiene `{kind: 'transaction_observation', source: 'uber_supplier_api', mode: 'shadow', organizationId, transactionId, tripId, uberDriverId, processedAt, description, raw}`. `raw` es la fila JSON recibida. `tripId`, `processedAt` y `description` pueden ser `null`. `processedAt` se conserva como texto de origen; no se convierte en fecha de realización del viaje. No hay importe derivado, bruto, neto, comisión, cobro, saldo, factura ni orden de notificación.
- `issues` contiene `UBER_AMOUNTS_UNINTERPRETED`: se debe revisar el contrato monetario antes de conectar estas observaciones a una conciliación de importes.
- `nextCursor` es `null` al terminar, o un identificador opaco que sólo sirve en la misma instancia, con la misma organización y ventana. Vence a los diez minutos, se consume al obtener la siguiente página y está limitado a veinte páginas por recorrido. No es el token original de Uber. No se debe persistir como cursor de sincronización. Si vence, se reinicia la ventana y se deduplica por organización e identificador de transacción en la capa de observación.

Los errores son `SupplierApiError` con `code`, opcionalmente `status` HTTP o `retryAfterMs`. No incluyen URL, respuesta, causa original, credenciales ni datos de conductores. La demora local mínima entre solicitudes de transacciones es un segundo; su código es `UBER_RATE_LIMIT_LOCAL`. No hay reintentos automáticos. El coordinador deberá repartir el límite de Uber entre instancias si en el futuro utiliza varias.

## Contrato oficial utilizado

| Función | Ruta oficial | Scope |
|---|---|---|
| Token OAuth Client Credentials | `POST https://auth.uber.com/oauth/v2/token` | Se solicita sólo el scope necesario para la operación |
| Organizaciones autorizadas | `GET https://api.uber.com/v1/vehicle-suppliers/orgs` | `vehicle_suppliers.organizations.read` |
| Transacciones | `POST https://api.uber.com/v1/vehicle-suppliers/transactions?org_id=...` | `supplier.partner.payments` |

Fuentes: [autorización Supplier](https://developer.uber.com/docs/vehicles/guides/authorization), [Get Organizations](https://developer.uber.com/docs/vehicles/references/api/v1/org-management/get-orgs), [Get Realtime Transactions](https://developer.uber.com/docs/vehicles/references/api/v1/supplier-performance-data/get-realtime-transactions).

El adaptador envía el cuerpo de transacciones del ejemplo oficial: `filters` por `timeRange`, `FILTER_OPERATOR_IN_RANGE`, dos tiempos en texto, orden ascendente por `processedAt` y `pagination_options: {pageSize: 500, pageToken}`. Acepta la respuesta directa `{transactions, paginationResult}` y la envoltura del ejemplo `{statusCode: 200, body: {...}}`. Un error o una fila inválida rechaza la página completa; no se omiten filas silenciosamente.

La documentación de transacciones anuncia una frescura menor a un minuto y un máximo de una solicitud por segundo por aplicación. Tiene inconsistencias: usa `pagination_options` en el ejemplo y `paginationOptions` en la tabla; `breakDown`/`breakDowns` y `amountE5`/`amountES` tampoco coinciden. La nota sobre los cinco minutos del inicio de la ventana resulta ambigua respecto del histórico de 24 horas. Se sigue el ejemplo para la solicitud, se conservan las cantidades crudas y no se prueban variantes automáticamente. **Antes de activar una lectura real hay que confirmar esas discrepancias con Uber y validar una respuesta autorizada.** Una prueba con respuestas ficticias verifica el adaptador local, no la disponibilidad ni el contrato de la cuenta.

La aplicación sólo conoce dos hosts fijos y tres rutas. Desactiva redirecciones, aborta solicitudes vencidas, limita cada respuesta a 2 MiB antes de analizarla, verifica IDs de organización autorizados y acota las páginas/cursors. No descarga URLs de las respuestas ni acepta una URL de destino del llamador. Un fallo 401 elimina el token de ese scope; 401/403 invalidan las organizaciones y las continuaciones. `raw` puede contener datos personales: se entrega sólo al servidor para su observación y no debe enviarse a registros o respuestas públicas.

## Webhooks

`verifySupplierWebhookSignature({rawBody, signature, clientSecret})` devuelve un booleano. `rawBody` debe ser un `Buffer` con los bytes originales de la solicitud, antes de analizar o serializar JSON; `signature` es el encabezado `X-Uber-Signature` hexadecimal. La función compara HMAC-SHA256 en tiempo constante. No acepta objetos o texto que hayan sustituido el cuerpo original.

Esto comprueba integridad, pero no autoriza organizaciones ni resuelve reenvíos. El futuro receptor también debe comprobar la organización y el entorno de entrega, validar el esquema y deduplicar `event_id`. El evento Fleet actual recomendado es `REALTIME_STATUS_CHANGE`; tiene ID de conductor, vehículo, organización, hora y estado. Su esquema publicado no proporciona ID de viaje, importe ni método de pago. Un `STATUS_DROPPED_OFF` no autoriza un cobro o una factura. Este trabajo no registra ni publica ningún receptor. [Configuración y firma](https://developer.uber.com/docs/vehicles/getting-started), [evento Fleet](https://developer.uber.com/docs/vehicles/references/api/v1/supplier-performance-data/realtime-driver-status-change).

## Requisitos para una futura conexión

La cuenta debe tener una organización Supplier habilitada y los dos scopes autorizados en una aplicación propia. Hay pasos manuales de alta de organizaciones y de suscripción de webhooks con un contacto de Uber. Las credenciales se deben suministrar exclusivamente al servidor mediante el almacenamiento de secretos de la infraestructura. No deben entrar en el navegador, archivos del repositorio, ejemplos de configuración, mensajes o logs. [Alta de organizaciones](https://developer.uber.com/docs/vehicles/references/api/v1/org-management/overview), [inicio](https://developer.uber.com/docs/vehicles/getting-started).

Uber Argentina permite empezar en el portal con un vehículo; ello no garantiza habilitación de APIs para esa cuenta o mercado. No se verificó acceso de esta cuenta. [Portal y flotas de Argentina](https://www.uber.com/ar/es/earn/fleet-management/).

Las transacciones en tiempo real y el webhook de estado indican expresamente que **no tienen sandbox**. El sandbox general Supplier tiene cobertura parcial; no sirve para afirmar que esta integración financiera fue ensayada contra Uber. [Limitaciones generales del sandbox](https://developer.uber.com/docs/vehicles/guides/sandbox-experience).

Mientras no exista acceso confirmado, el camino es descargar los reportes oficiales e importarlos en el proceso local de revisión. La API de reportes es una futura alternativa con scope `solutions.suppliers.reports`: generar, consultar estado y pedir enlace temporal. Los reportes de viajes anuncian actualización cada 30 minutos y los de pagos cada cuatro horas. No se implementaron sus solicitudes en este módulo. [Reportes](https://developer.uber.com/docs/vehicles/references/api/v1/vehicle-suppliers/suppliers/generate-report), [campos de viajes](https://developer.uber.com/docs/vehicles/references/api/v1/vehicle-suppliers/suppliers/performance-based-reports-fleet), [campos de pagos](https://developer.uber.com/docs/vehicles/references/api/v1/vehicle-suppliers/suppliers/payment-based-reports-fleet).

Prueba local sin red ni procesos auxiliares:

```text
node --test --test-isolation=none functions/tests/uber-fleet-api.test.js
```
