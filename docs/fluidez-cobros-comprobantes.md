# Guardado y navegación de comprobantes

## Cobros digitales 2.5.6 (23/10/2026)

La foto empieza a prepararse y subirse al seleccionarla, mientras el chofer
completa la confirmación fiscal. Esto solo adjunta un archivo privado: todavía
no crea un cobro, mueve saldos, solicita factura ni envía Telegram. La confirmación
reutiliza la misma subida por archivo/usuario y espera el acuse de la transacción.
Si falla Firestore, la operación pendiente conserva el enlace y la huella del
archivo; después de recargar se puede reintentar sin volver a subir esa misma
foto. Un archivo distinto o una sesión distinta no reutilizan ese comprobante.

Para comprobantes de cobros digitales se acotan las etapas: preparación 5 s por
operación de imagen, subida 15 s sin progreso o 45 s totales y enlace 8 s. La
transacción del formulario de cobros tiene un límite de 15 s.
Las comprobaciones de un resultado incierto conservan el ID original y nunca
anuncian éxito desde datos locales sin confirmar. Sin conexión no se promete
guardado inmediato. Los campos se bloquean durante la confirmación para evitar
que se muestre otro importe o archivo distinto al que se está enviando.

Los adelantos se leen en paralelo, dentro de la misma transacción antes de sus
escrituras. Se mantienen las fórmulas, la vinculación con ARCA, los avisos del
servidor y los permisos actuales. No se migran registros históricos.

Pruebas añadidas: caché concurrente, separación por archivo y usuario, subida
fallida/reintento, respuesta tardía, acuse perdido, recuperación después de
recargar y conservación del importe/caja chica. La prueba visual usa únicamente
Firebase simulado local: sus tiempos no son mediciones de la red de producción.

## Comportamiento general de gastos y comprobantes

El cobro digital conserva el identificador de operación entre reintentos. El botón
informa preparación, porcentaje de subida y confirmación del cobro. Si falló la
subida, no consulta repetidamente una escritura de Firestore que nunca empezó.
Si el cobro ya se confirmó, el reintento lo reconoce antes de subir otra foto.

Las imágenes de más de 350 KiB se preparan en el dispositivo con un máximo de
2000 píxeles en su lado largo y JPEG de calidad 0,82. Se conserva el archivo
original si la conversión no reduce su tamaño o el navegador no puede procesarlo.
Los PDF y archivos pequeños permanecen intactos. El tipo MIME se normaliza para
fotos o PDF reconocidos cuyo dispositivo no lo informa.

En los demás formularios la subida se cancela después de 45 segundos sin avance
o 120 segundos totales; obtener el enlace tiene un límite de 15 segundos. Las
transacciones conservan 45 segundos y las comprobaciones posteriores son acotadas.
Estos son límites independientes por etapa, no una promesa de duración del cobro.
Una escritura ya enviada puede confirmarse después de perder la conexión: por
eso los reintentos usan siempre el mismo documento y verifican su identidad.

En administración, Comprobantes y Cierres muestran primero 50 registros, con
**Ver más** para consultar los siguientes. La vista derivada se reutiliza entre
clics y se invalida al recibir nuevos datos, cambiar de sesión o cambiar de mes.
No se eliminan históricos ni cambian las fórmulas de saldos.

El módulo principal del inicio se precarga con la misma URL que luego ejecuta
la página, evitando una segunda descarga de una versión distinta. Los controles
de autenticación y de cuentas desactivadas permanecen vigentes.

Pruebas: `receipt-upload.test.mjs`, `admin-driver-cards.test.mjs`,
`admin-driver-context.test.mjs`, `login-performance.test.mjs` y la suite completa
`node tools/check.mjs`. El escenario visual aislado de login se ejecuta mediante
`node tools/inspect-login-layout.mjs`; no usa cuentas ni datos de producción.
