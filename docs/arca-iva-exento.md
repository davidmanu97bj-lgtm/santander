# Emisor IVA exento: facturas C

Implementación del 01/11/2026 para acompañar la inscripción del titular como IVA exento desde noviembre de 2026. La condición del emisor es independiente de la exención de un traslado individual y de la condición fiscal del pasajero.

## Contrato fiscal

- `regime: "iva_exento"` y `invoiceType: 11` seleccionan factura C para consumidor final, monotributista, responsable inscripto o sujeto exento. Pedir una factura nominada no convierte el comprobante en A.
- Se mantiene el nombre, documento y condición IVA real del receptor. Los requisitos de identificación y validación de CUIT siguen aplicándose.
- El importe fiscal es el total del cobro original. No se toman porcentajes del chofer, caja chica ni liquidaciones como base de una venta.
- En WSFE, una C informa el subtotal en `ImpNeto`, `ImpOpEx: 0`, `ImpIVA: 0` e `ImpTotConc: 0`, sin objeto `Iva`. Con los tributos actualmente soportados en cero, `ImpTotal` coincide con `ImpNeto`. El nombre técnico `ImpNeto` no significa que se esté discriminando IVA.
- Cada solicitud guarda `issuerRegime: "iva_exento"`, `issuer.vatCondition: "IVA Exento"`, `regimeEffectiveFrom`, tipo, punto, ambiente y políticas fiscales. PDF y QR se generan desde esa fotografía, no desde la configuración actual.
- Se conservan los controles de chofer real autorizado, exclusión de simulaciones, servicio completo y alcance fiscal. Para viajes nacionales se mantiene la política verificada de taxi/remis hasta 100 km. Los internacionales requieren su propia habilitación y no se convierten automáticamente en exportaciones.
- El disparador de preparación también lee `arca_settings/current` para borradores nuevos; no hereda un régimen monotributo desde variables de entorno antiguas. Los borradores ya creados conservan su régimen y emisor originales. Si falta configuración, registra régimen desconocido y verificaciones pendientes; una falla de lectura impide guardar un borrador incorrecto. Este flujo no autoriza facturas y no agrega lecturas a cobros del flujo automático `arca_c_v1`.

## Configuración

La configuración reside en `arca_settings/current`. Además de los datos completos del titular y los controles existentes, el contrato requiere:

```json
{
  "enabled": false,
  "environment": "production",
  "regime": "iva_exento",
  "invoiceType": 11,
  "regimeEffectiveFrom": "2026-11-01T00:00:00-03:00",
  "activeFrom": "2026-11-01T00:00:00-03:00",
  "ivaExemptRegistrationVerified": false,
  "registrationVerified": false,
  "ivaExemptHomologationPassed": false,
  "exclusivePointOfSale": true,
  "pointOfSale": 5,
  "pointEmissionType": "CAE - Exento",
  "taxPolicy": "domestic_taxi_exempt_up_to_100km_v1",
  "domesticTaxiExemptionVerified": false,
  "approvedDriverUids": []
}
```

Es un ejemplo de estructura, no una instrucción para activar banderas. El punto y su `EmisionTipo` deben ser los verificados en ARCA. La inscripción vigente, la homologación real, el uso exclusivo del punto y las políticas de los servicios efectivamente prestados deben respaldar los indicadores. `enabled` no alcanza para habilitar producción.

La fecha efectiva es el comienzo legal del régimen. `activeFrom` indica desde cuándo se aceptan nuevos cobros para esta automatización y no puede anteceder a la fecha efectiva. Ambas fechas exigen ISO con zona horaria explícita y calendario válido; una fecha sin hora o zona no se acepta, para evitar desplazar el día al convertir desde UTC. El 01/11/2026 a las 00:00 de Argentina corresponde a las 03:00 UTC.

Producción exige `registrationVerified`, `ivaExemptRegistrationVerified` e `ivaExemptHomologationPassed`. Las banderas antiguas `homologationPassed`, `generalHomologationPassed` o las de factura A no sustituyen ninguna de las nuevas verificaciones.

Para internacionales se requieren también:

```json
{
  "internationalInvoiceType": 11,
  "internationalTaxPolicy": "international_passenger_transport_exempt_v1",
  "internationalTransportExemptionVerified": false,
  "internationalActiveFrom": "2026-11-01T00:00:00-03:00"
}
```

Su fecha tampoco puede preceder a la vigencia de IVA exento. Conservar la fecha histórica internacional del régimen general no habilita el nuevo régimen.

## Punto y numeración

ARCA exige para el emisor exento un punto de tipo **COMPROBANTES – EXENTO EN IVA – WEB SERVICES**. `pointMatches` exige un punto no bloqueado, sin baja y con la cadena `EmisionTipo` exactamente igual a la verificada en la configuración; rechaza los puntos de monotributo y responsable inscripto. El código admite las variantes de etiqueta WSFE `CAE - Exento`, `CAE - Exento IVA` y `CAE - Exento en IVA`, sin equiparar etiquetas diferentes durante la comparación.

Las series siguen identificándose por ambiente, CUIT, punto y tipo. El último número se consulta en ARCA antes de reservarlo; un comprobante C no reutiliza la numeración de A o B.

## Transición e historia

1. Verificar la inscripción y fecha efectiva en ARCA, respaldar configuración anterior y revisar solicitudes pendientes o inciertas.
2. Confirmar el nuevo punto WSFE de exento y homologar una C sin emitir pruebas en producción.
3. Desplegar el soporte del nuevo régimen y su presentación. Activar exclusivamente la configuración verificada.
4. Los eventos nuevos se preparan una sola vez por ID de cobro. Un viaje de octubre registrado en noviembre queda en revisión; la fecha de carga no cambia el período del servicio.
5. La activación no reemplaza ni reencola automáticamente solicitudes ya existentes, aunque estén rechazadas, deshabilitadas o en revisión. Durante una pausa operativa, una solicitud puede haber quedado deshabilitada: necesita conciliación posterior y tratamiento acotado, no un reintento masivo.
6. Antes de corregir una solicitud individual se debe comprobar que no tiene CAE ni un envío incierto y que su servicio corresponde al régimen nuevo. Conservar respaldo y auditoría del intento anterior. No editar el cobro original ni sus saldos.

Las A/B históricas y las C de monotributo mantienen régimen, condición del emisor, punto, número, CAE, PDF y QR originales. Incluso si una C antigua coincidiera en punto y tipo, el worker no la emite bajo `iva_exento`. Una reversión de configuración a monotributo tampoco puede emitir una solicitud de exento.

Los registros `sent` o `uncertain` de regímenes anteriores y sus bloqueos de serie se conservan para conciliación individual. No se convierten en C ni se vuelven a enviar. Para una C nueva con respuesta incierta, el worker consulta el mismo punto, tipo y número y exige coincidencia de importes, documentos, fechas y condición IVA del receptor antes de adoptar un CAE. Sin coincidencia, mantiene el bloqueo.

## Validación

`functions/tests/arca-iva-exento.test.js` cubre C para todas las condiciones de receptor soportadas, montos WSFE, controles de registro/homologación, límite de fecha en Argentina, servicios anteriores cargados tarde, simulaciones, punto incompatible, concurrencia, reintentos, respuesta perdida, preservación histórica y ausencia de escrituras en billeteras/cierres/cobros. También ejecuta el disparador real de preparación con una base simulada para comprobar lectura de configuración actual, conservación del emisor previo y fallas de configuración. Las pruebas previas de A/B y monotributo continúan vigentes.

El 01/11/2026 se realizó una prueba real **en homologación**, C punto 5 número 1, autorizada y conciliada mediante consulta independiente. Su evidencia está en `outputs/iva-exento-20261101/homologation-C-consumer.json` del espacio de trabajo, fuera del repositorio. Esa prueba no es una factura de producción. La confirmación del estado de despliegue y de la configuración productiva se registra separadamente en la evidencia de entrega.

## Fuentes oficiales

- [ARCA: clases de comprobantes según emisor y receptor](https://www.afip.gob.ar/facturacion/regimen-general/).
- [Manual WSFE v4.7, 01/09/2026](https://www.arca.gob.ar/ws/documentacion/manuales/manual-desarrollador-ARCA-COMPG.pdf): páginas 47–48, importes de C; página 53, validación 10096 para punto de venta de exento.
- [RG 1415, artículo 16 y datos de los comprobantes](https://biblioteca.afip.gob.ar/search/query/norma.aspx?p=t%3ARAG%7Cn%3A1415%7Co%3A3%7Ca%3A2003%7Cf%3A07%2F01%2F2003).
