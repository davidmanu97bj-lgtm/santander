# Régimen general: factura B por traslado exento

Esta implementación agrega B (código 6) sin activar producción. Conserva las C históricas (código 11), sus series y sus PDF. No modifica pagos, saldos, porcentajes de choferes ni documentos de liquidación.

## Alcance

- Responsable inscripto: B para consumidor final o sujeto exento, exclusivamente por traslado nacional en taxi/remis hasta 100 km, cuando la exención haya sido verificada al configurar el emisor.
- El total se informa en `ImpOpEx`; `ImpNeto`, `ImpIVA` e `ImpTotConc` quedan en cero. No equivale a una venta gravada al 0%.
- Clientes responsables inscriptos o monotributistas quedan en revisión: la emisión A y sus variantes necesitan habilitación separada.
- El transporte internacional de pasajeros puede habilitarse como B exenta mediante una política y fecha de activación específicas, luego de verificar su encuadre. No hereda la habilitación internacional del antiguo emisor C. No se le aplica el límite nacional de 100 km.
- Traslados internacionales sin esa habilitación, nacionales mayores a 100 km, datos incompletos y servicios anteriores a la activación quedan en revisión. La distancia por sí sola no determina el tratamiento de un cruce de frontera.
- Solo los identificadores de choferes reales incluidos expresamente en `approvedDriverUids` pueden generar solicitudes B automáticas. Los perfiles de prueba quedan en revisión.
- No implementa el futuro cambio del emisor a IVA exento ni presume que esa inscripción haya sido aprobada.

## Activación pendiente

Se requieren comprobación registral, prueba B autorizada en homologación, revisión del alcance fiscal y aprobación de la activación. Las pruebas automáticas con respuestas simuladas **no** equivalen a homologación ante ARCA.

Configuración adicional en `arca_settings/current`:

```json
{
  "regime": "general",
  "invoiceType": 6,
  "taxPolicy": "domestic_taxi_exempt_up_to_100km_v1",
  "domesticTaxiExemptionVerified": true,
  "pointEmissionType": "CAE - Ri Iva",
  "generalHomologationPassed": false,
  "approvedDriverUids": []
}
```

Además deben verificarse los campos existentes de emisor, punto exclusivo, inscripción, ambiente y fecha de activación. El ejemplo no debe copiarse como autorización para marcar las verificaciones en verdadero. El nuevo indicador `generalHomologationPassed` no se hereda de la prueba de monotributo. Usar un corte de activación nuevo, nunca reutilizar la fecha histórica del emisor C.

Para transporte internacional verificado se requieren adicionalmente `internationalInvoiceType: 6`, `internationalTaxPolicy: "international_passenger_transport_exempt_v1"`, `internationalTransportExemptionVerified: true` e `internationalActiveFrom` nuevo. La matrícula del pasajero, su nacionalidad o una etiqueta de distancia no acreditan por sí solas un transporte internacional. El alcance configurado debe corresponder a los traslados efectivamente vendidos por el emisor.

## Protección contra duplicados

El ID del cobro conserva una sola solicitud. No se reemplazan solicitudes C al cambiar de configuración. La serie contiene ambiente, CUIT, punto y tipo de comprobante. El tipo y la condición del emisor quedan guardados en cada solicitud y gobiernan consulta, autorización, PDF y QR.

Ante una respuesta incierta se consulta el mismo número y tipo; no se reenvía ni se avanza la serie. Los rechazos previos necesitan conciliación individual con ARCA/RCEL antes de cualquier reemisión. No hay migración ni reintento masivo en este cambio.

## Validación

`functions/tests/arca-general.test.js` cubre bruto exento, límites y revisión, habilitación separada, concurrencia, tipo/serie, respuesta perdida, conflicto con C, preservación de registros previos, punto incompatible, XML B y PDF/QR. Las pruebas de interfaz conservan el diagnóstico de rechazos y muestran motivos de revisión.

## Fuentes oficiales consultadas el 23/09/2026

- [ARCA: régimen general y clases de comprobantes](https://www.arca.gob.ar/facturacion/regimen-general/).
- [Ley de IVA, artículo 7 inciso h puntos 12 y 13](https://biblioteca.arca.gob.ar/dcp/TOR_C_020631_1997_03_26).
- [Manual WSFE v4.7, septiembre de 2026](https://www.arca.gob.ar/ws/documentacion/manuales/manual-desarrollador-ARCA-COMPG.pdf): campos de importe exento y tipo de comprobante.
- [Acta AFIP 29 del 11/03/2019, tema 5](https://www.afip.gob.ar/EspaciosdeDialogoInstitucional/documentos/Acta-29-Espacio-de-Dialogo-AFIP-Profesionales-11-03.pdf): explica que el transporte internacional no es exportación de servicios aunque tenga el tratamiento del artículo 43. La pregunta trata cargas; el criterio del organismo se refiere al transporte internacional del mismo artículo 7 h.13, que comprende también pasajeros. En combinación con las reglas generales de comprobantes, sustenta B al consumidor final para el transporte exento, sin convertir todo cruce en factura E.
