# Disponibilidad de choferes — implementación 2026-09-21

Primera entrega: diseño interactivo aislado en tools/availability-preview.html, accesible mediante tools/availability-preview-server.mjs en localhost:8083. No forma parte del paquete de producción. Datos de ejemplo, sin mensajes, reservas reales ni teléfonos persistidos. No se alteró la facturación ni los saldos.

## Requisitos de implementación

- Insertar tarjeta debajo del saludo del chofer. Libre verde #eaf7ef; ocupado rosado #fdf0f3. Contador solo libres/ocupados, sin contador aeropuerto.
- Cambiar alterna libre/ocupado. Zonas dentro de la misma tarjeta: Ciudad, Aeropuerto, Brasil, Paraguay. No usar ventanas para elegir zona o número.
- Libre en Ciudad/Aeropuerto ofrece 28, 57, 104, 31, 15, 154, 43, 134 y No. Ocupados se muestran tachados e inhabilitados. Brasil/Paraguay no ofrecen números.
- Reservas compartidas por todos los choferes mediante transacción del servidor: una sola adjudicación por número/día, aun con selecciones simultáneas o reintentos. Conservar la reserva del día hasta medianoche; cambiar de estado no debe permitir que otro reclame una reserva anterior antes del reinicio.
- Día operativo y reinicio 00:00 America/Argentina/Buenos_Aires. El acceso debe descartar reservas de días previos incluso si el trabajo programado se retrasa. No cambiar el estado del chofer por reiniciar números.
- Primer uso pide WhatsApp con país y número; validación/normalización internacional en servidor. El chofer solo puede crear el suyo una vez; modificaciones posteriores exclusivamente por admin, controladas en servidor y auditadas. No confiar solo en esconder el botón.
- Lista en tiempo real con nombre, estado, zona y “por 57”. WhatsApp solo en otros choferes libres con teléfono válido. Admin ve Editar número.
- WhatsApp: navegación por acción del usuario al chat del número normalizado, sin window.open ni pestañas intermedias propias. Probar Android/iOS con WhatsApp instalado y alternativa si no lo está; no prometer control absoluto sobre pantallas que muestra el sistema o WhatsApp.
- Telegram breve: NOMBRE ESTÁ OCUPADO EN CIUDAD / NOMBRE ESTÁ LIBRE EN AEROPUERTO / NOMBRE SE ADJUDICÓ 57. Emitir tras guardar estado definitivo; evitar duplicados por reintentos. Usar Brasil como zona según los cuatro botones solicitados; Foz fue un ejemplo, no una quinta zona.
- Verificar permisos, usuarios inactivos, cierre de sesión, reconexión, concurrencia de reservas y cambio de día. Evitar que estados optimistas sin confirmación aparenten una reserva conseguida.

La configuración fiscal solicitada previamente (B, punto 00003, exento) sigue pendiente de aclarar si “exento” corresponde al servicio o al emisor. No se modificó.

## Implementación lista para publicar

Integrada en driver-availability.js/css; servidor functions/driver-availability*.js. Reserva transaccional por día argentino, revisión de estado para sesiones concurrentes, claves de reintento y eventos con deduplicación de Telegram. Teléfono inicial y edición administrativa protegidos en servidor, auditoría privada, consultas en tiempo real limitadas al equipo activo. Estados iniciales sin confirmar aparecen como Sin estado; no se supone que un chofer está libre.

277 pruebas completas aprobadas; recorrido de alta de WhatsApp y reserva local probado en interfaz móvil. Enlaces oficiales wa.me en la misma pestaña, sin window.open; aún requieren verificación física en iOS/Android y no controlan pantallas propias de WhatsApp o del sistema.

Se mantiene el prototipo aislado en localhost:8083; no se incluye en Hosting. La configuración fiscal B/00003 sigue pendiente de aclaración.
