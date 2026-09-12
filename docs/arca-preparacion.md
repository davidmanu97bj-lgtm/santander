# Preparación de facturación ARCA

Estado: preparación interna, sin conexión a ARCA ni emisión fiscal.

Los nuevos cobros guardan `invoiceRequest` con fecha, recorrido real, kilómetros,
trayecto nacional/internacional y medio de pago. El formulario habitual no pide
nombre, documento ni condición de IVA del pasajero. Antes de emitir, la futura
integración deberá evaluar si corresponde identificar al receptor según importe
y tipo de comprobante; no se presupone que todos los clientes sean consumidores
finales. Los datos históricos del cliente se conservan. El servidor
genera un único borrador en `arca_invoice_drafts/{paymentId}`. Relee el cobro
actual en una transacción para tolerar eventos repetidos o fuera de orden;
actualiza correcciones y cancela borradores de cobros eliminados. No modifica
documentos con un estado posterior a preparación. Los cobros anteriores sin
solicitud fiscal no generan borradores.

El escenario objetivo es régimen general, con inscripción y tratamiento de IVA
pendientes de verificación. No se supone Responsable Inscripto ni IVA Exento.
Los kilómetros orientan la revisión, nunca autorizan una exención. El total
fiscal propuesto es el importe completo del servicio: no se suma ni descuenta
la caja chica interna. Efectivo: +100% y +5%; digital: −100% y +5%.

No se generan números fiscales, CAE, PDF fiscal ni códigos QR ficticios.
Los borradores son consultables solo por Admin y escribibles solo por servidor.
No hay envío externo ni facturación automática de los gastos o de los choferes.

## Datos del emisor

Configurar exclusivamente en el entorno privado de Functions:

- `ARCA_ISSUER_CUIT`
- `ARCA_ISSUER_LEGAL_NAME` (nombre legal, no solo nombre comercial)
- `ARCA_POINT_OF_SALE`

No incluir CUIT personal, certificados, claves privadas o clave fiscal en Git,
en el frontend ni en archivos públicos. Estos valores no habilitan la emisión:
`emissionEnabled` permanece false incluso si se completa el emisor.

## Trabajo pendiente para emitir

1. Confirmar inscripción fiscal, habilitación municipal y relación contractual
   con los taxistas. Definir tratamiento nacional, internacional y operaciones
   gravadas/exentas con respaldo profesional.
2. Seleccionar tipos de comprobante, requisitos actuales del receptor, fechas,
   moneda, punto de venta y demás datos exigidos por ARCA según el caso.
3. Implementar WSAA y el servicio de facturación que corresponda, con claves en
   Secret Manager y certificados separados para homologación y producción.
4. Validar CUIT y condición fiscal; gestionar numeración concurrente por punto
   de venta y tipo, consulta de comprobantes ante respuestas inciertas y
   reintentos idempotentes. Un timeout nunca equivale a rechazo confirmado.
5. Probar autorización y rechazo en homologación. Generar PDF y QR desde datos
   autorizados. Definir contingencias y notas de crédito; nunca borrar o editar
   una factura ya autorizada como si fuese solo un cobro interno.
6. Habilitar producción únicamente tras verificar inscripción, credenciales,
   pruebas, operación y autorización del titular.

Documentación oficial consultada:

- https://www.afip.gob.ar/ws/documentacion/ws-factura-electronica.asp
- https://www.afip.gob.ar/ws/documentacion/wsaa.asp
- https://www.afip.gob.ar/fe/emision-autorizacion/solicitud-autorizacion.asp
- https://www.argentina.gob.ar/normativa/nacional/decreto-280-1997-42701/actualizacion

Requisitos del receptor: https://www.afip.gob.ar/fe/emision-autorizacion/datos-comprobantes.asp
