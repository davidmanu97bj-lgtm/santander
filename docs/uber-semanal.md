# Liquidación semanal de Uber

Desde el cierre del lunes 14 de septiembre de 2026, la tarjeta del inicio se habilita el martes siguiente, a las 00:00 de Argentina. La regla se repite semanalmente y contempla cambios de mes/año. Solo se ofrece la última semana disponible. Al enviarla desaparece aunque esté pendiente de aprobación; un rechazo permite volver a presentar esa semana. Los registros históricos siguen accesibles para administración.

Flujo: monto de ganancias semanales (incluye centavos) → captura de ganancias → vista de los dos movimientos → enviar. El importe informado corresponde al total después de la comisión de Uber.

Para nuevas liquidaciones, `uber_gross_cash_cashbox_5_v1` agrega 100% del monto y 5% de caja chica a la deuda del conductor. Ejemplo: 100.000 + 5.000 = 105.000. Los registros sin esa versión conservan sus fórmulas, incluso si aún estaban pendientes. El envío sigue pendiente de revisión administrativa y no mueve el saldo hasta su aprobación. No se crea una solicitud fiscal en ARCA por esta operación interna.

El lector Tesseract.js se ejecuta en Firebase Functions y carga el modelo español empaquetado. No requiere otra cuenta ni una API externa de OCR. Solo se ejecuta al verificar la captura, con límites por usuario (3 intentos/minuto, 20/día), concurrencia 1 por instancia y un máximo de 2 instancias. Consume cómputo normal de Firebase; no se activan instancias permanentes.

Se exige una pantalla legible de Ganancias, el rango semanal esperado y el importe principal correcto. Una imagen dudosa, de otro período, con monto distinto o marcada como ejemplo impide continuar y muestra una guía. El lector no acredita autenticidad y no puede inferir el año de una captura que lo omite. La aprobación humana permanece obligatoria.

Las capturas que no pasan el control no se guardan. Las aprobadas por el lector se guardan en `uber_verified`, sin permisos de reemplazo para el cliente, junto con una validación del servidor ligada a usuario, fechas, monto y archivo. Firestore exige esa validación vigente (una hora) para crear la liquidación. Un cambio de monto o de captura exige verificar nuevamente. Las imágenes válidas abandonadas durante el formulario permanecen en Storage; no hay eliminación automática de comprobantes.

Verificación: pruebas de cálculo mixto/histórico, calendario de 80 semanas, lector real con imagen sintética, rango y monto incorrectos, y permisos en emuladores. La imagen de `tests/fixtures/uber-ganancias-sinteticas.jpg` contiene únicamente datos artificiales y no es un comprobante real.
