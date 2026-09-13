# Calendario de viajes

El acceso «Calendario» abre una pantalla completa. «Mi calendario» y «Todos» empiezan en el mes actual de Argentina y pueden navegar por meses de forma independiente. Cada día muestra la cantidad de viajes; al seleccionarlo se ven todos sus detalles. El formulario pide día, detalle y WhatsApp o teléfono. No registra importes, cobros ni solicitudes de factura.

Cada viaje se guarda una sola vez en `trip_calendar`, con `driverUid`, `driverName`, `serviceDate` (YYYY-MM-DD), `detail`, `phone`, `createdAt` del servidor y claves de idempotencia. Ambos calendarios derivan de ese registro. El mismo formulario conserva su clave cuando un envío necesita reintentar; una nueva carga confirmada permite otro viaje, incluso con los mismos datos.

La pantalla comparte una escucha de Firestore por mes visible (máximo dos), con rango y orden sobre `serviceDate`; no necesita un índice compuesto. Al cerrar detiene las escuchas. Retiene hasta cuatro meses en memoria para reabrir rápido y borra ese caché al cambiar la sesión. Solo administradores y choferes activos pueden consultar el calendario del equipo. Un chofer solo puede crear viajes propios; no puede modificar viajes ni escribir estados internos de Telegram.

`notifyCalendarTrip` envía un aviso breve al crear un viaje: chofer y fecha del servicio. Si ya existía otro viaje ese día, del mismo chofer o de otro, agrega un aviso de coincidencia en «Todos». Es una coincidencia por día; no se detectan cruces horarios porque no se pide hora. Teléfono y detalle del pasajero permanecen en la aplicación y no se incluyen en estos avisos.

La decisión se guarda en `calendar_notification_plans`, una colección accesible solo desde el servidor. Se consideran únicamente viajes anteriores, ordenados por timestamp del servidor e ID en caso de empate. Los reintentos reutilizan la decisión y cada aviso tiene su propia clave en `telegram_notifications`. Se conserva la limitación de los envíos remotos descrita en `telegram.md`.

Validación: `node tools/check.mjs` cubre fechas, meses, filtros personales, caché, cancelación de escuchas, sesiones, formato y reintentos de notificaciones. También se probó en emuladores con dos usuarios simultáneos, varios viajes por día, envío duplicado, permisos, navegación de meses y plan de avisos usando un transporte simulado. Las pruebas no envían mensajes al grupo real ni emiten facturas.

Publicar reglas, backend y hosting del mismo commit mediante `tools/deploy.mjs`. La función usa los secretos de Telegram ya configurados. No hace falta una API de calendarios externa ni una cuenta por chofer.
