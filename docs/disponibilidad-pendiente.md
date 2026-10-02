# Disponibilidad retirada

Pedido de David del 02/10/2026: retirar Adjudicar número y Libre/Ocupado.

Se retiraron la tarjeta del chofer, el acceso administrativo, los diálogos de
estado/contacto, las suscripciones, las llamadas del cliente y las vistas de
prueba de esta función. Salidas de hoy, su registro y la comparación de cobros
siguen siendo independientes; el selector de número remis del cobro conserva
sus estilos propios.

Los siete nombres de Cloud Functions se conservan como handlers inertes para
no requerir borrados de funciones al publicar una versión posterior. Las tres
llamadas antiguas responden failed-precondition; los eventos de perfil, el
aviso de Telegram y el cron no leen ni escriben datos ni envían mensajes.
Las reglas deniegan el acceso del cliente a las colecciones retiradas.
No hay migración, limpieza ni eliminación de documentos: se conservan estados,
reservas, contactos, auditoría y eventos históricos, además de todos los datos
de salidas y finanzas.

Estos cambios locales no desactivan el backend actualmente desplegado. Una
publicación aprobada de reglas y Functions es necesaria para bloquear también
los clientes antiguos; publicar solo la web retira la interfaz pero no actualiza
las funciones remotas. No se realizó ningún despliegue como parte de este cambio.
