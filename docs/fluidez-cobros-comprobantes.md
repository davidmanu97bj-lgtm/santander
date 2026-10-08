# Guardado y navegación de comprobantes

El cobro digital conserva el identificador de operación entre reintentos. El botón
informa preparación, porcentaje de subida y confirmación del cobro. Si falló la
subida, no consulta repetidamente una escritura de Firestore que nunca empezó.
Si el cobro ya se confirmó, el reintento lo reconoce antes de subir otra foto.

Las imágenes de más de 350 KiB se preparan en el dispositivo con un máximo de
2000 píxeles en su lado largo y JPEG de calidad 0,82. Se conserva el archivo
original si la conversión no reduce su tamaño o el navegador no puede procesarlo.
Los PDF y archivos pequeños permanecen intactos. El tipo MIME se normaliza para
fotos o PDF reconocidos cuyo dispositivo no lo informa.

La subida se cancela después de 45 segundos sin avance o 120 segundos totales;
obtener el enlace tiene un límite de 15 segundos. La escritura del cobro tiene un
límite de 45 segundos y las comprobaciones posteriores también son acotadas.
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
