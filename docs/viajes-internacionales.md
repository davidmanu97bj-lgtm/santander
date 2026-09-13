# Facturación de traslados internacionales

Estado al 13/09/2026: el titular indicó que todavía no tiene confirmado por su
contador o ARCA qué comprobante corresponde. La emisión internacional continúa
pendiente de esa definición. El cobro se registra; una solicitud en revisión no
es una factura autorizada ni tiene un PDF fiscal válido.

La integración productiva actual usa WSFE y Factura C (código 11) para cobros
nacionales de un emisor monotributista. La caja chica permanece fuera del importe
facturado. Los viajes internacionales conservan su recorrido y su clasificación;
no se convierten en nacionales para emitirlos. Tampoco se vuelven a facturar
operaciones anteriores automáticamente.

## Consulta preparada para el contador o ARCA

> Soy monotributista y presto servicios de traslado de pasajeros desde Puerto
> Iguazú. Explora aporta el vehículo, consigue los clientes y responde ante el
> pasajero; conduce un taxista con habilitación municipal a nombre del chofer.
> Quiero facturar por el importe completo, tanto si el pasajero paga en efectivo
> como por medios digitales. Realizamos traslados entre Argentina, Brasil y
> Paraguay, y el catálogo también permite elegir dos destinos fuera de Argentina.
> ¿Qué comprobante corresponde en cada caso: Factura C por el servicio de
> transporte o Factura E por una operación de exportación? ¿Cambia según que se
> facture al pasajero o a una agencia argentina o extranjera? Necesito confirmar
> el tipo de comprobante, el punto de venta y cualquier dato obligatorio del
> receptor para automatizar la emisión.

## Qué falta para activar

1. Obtener la definición aplicable a estas operaciones concretas. La distancia
   y el país elegido no resuelven por sí solos el tipo fiscal del comprobante.
2. Si corresponde C, adaptar y probar el alcance de la cola existente sin
   modificar el recorrido real ni reenviar solicitudes anteriores.
3. Si corresponde E, integrar el servicio de exportación y habilitar el punto de
   venta y la autorización correspondientes; el cliente WSFE actual solo emite C.
4. Verificar el caso en homologación y activar exclusivamente cobros nuevos.

## Fuentes oficiales consultadas

- [ARCA: comprobantes de monotributistas](https://www.arca.gob.ar/facturacion/monotributo/comprobantes.asp):
  establece comprobantes C, salvo operaciones de exportación, que requieren E.
- [ARCA: exportación de servicios](https://www.afip.gob.ar/monotributo/exportacion-servicios/):
  explica la facturación E de esas operaciones. Esta pauta general no constituye
  una confirmación individual del encuadre de los traslados de Explora.

No se ha enviado esta consulta a terceros.
