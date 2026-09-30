# Clasificación visible del cobro

Movimientos y Salidas de hoy presentan lo guardado en `billing_records` mediante
`classifyRecordedCharge` (`ops-salidas.js`). Es una proyección de lectura: no escribe
campos ni reclasifica registros históricos.

| Evidencia guardada | Etiqueta |
| --- | --- |
| `remisNumber` válido, sin bandera privada verdadera | `Nº remis 134` (o el número guardado) |
| `viajePrivado` o `isPrivateTrip` verdadero, sin número ni bandera opuesta | `Viaje privado` |
| Sin número ni bandera privada verdadera | `Sin clasificar` |
| Banderas booleanas opuestas, bandera de otro tipo, número inválido o privado con número | `Por revisar` |

Los números válidos son los ocho del selector del chofer: 28, 57, 104, 31, 43, 154,
15 y 134. Se admite un número entero o su texto decimal. Un alias ausente o `null`
no contradice al otro campo: por ejemplo, un número explícito válido sin banderas
puede mostrarse, pero un registro sin ninguno de estos campos queda sin clasificar.
No se deduce la selección por recorrido, fecha, importe, nombre o texto libre.

En Movimientos solo se etiquetan cobros de viajes, no pagos, compensaciones,
gastos, deudas ni liquidaciones Uber. En Salidas de hoy, **Cobro registrado** se
refiere al cobro vinculado; los candidatos también muestran su clasificación y
pueden desplegarse para leer fecha, chofer, importe y referencia. Un vínculo cuyo
cobro no está disponible se muestra sin clasificar, sin copiar el número de la salida.

El **tipo de salida** administrativa (propio, Uber, cobertura externa, etc.) es
independiente. La etiqueta no modifica el cruce por número y hora, ni certifica
recorrido o chofer. Tampoco cambia saldos, importes, cierres, facturas, notificaciones
o automatizaciones.

## Verificación local

Con Node 22:

```sh
npm ci --prefix functions --ignore-scripts --no-audit --no-fund
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run build
node tools/inspect-charge-classification.mjs
git diff --check
```

El chequeo visual usa Playwright y Edge instalado; `UI_BROWSER_CHANNEL` permite
elegir otro canal de Chromium. Con WebKit instalado, `UI_ENGINES=chromium,webkit`
ejecuta ambos motores. Carga la app real en la vista local con Firebase sustituido
por memoria y bloquea peticiones del navegador a otros orígenes. Rechaza un archivo
de estado local previo para no sobrescribir trabajo ajeno.

Comprueba número, privado, legado, contradicción, número inválido, dos candidatos,
vínculos, filtros, apertura/cierre/reapertura y navegación repetida. Compara los
registros antes y después (excluye únicamente el bootstrap local de disponibilidad).
Guarda capturas en `../charge-classification-evidence/`.

Salidas de hoy se prueba a 320, 390, 768 y 1440 px. Movimientos conserva la regla
existente de acceso desde notebook: se prueba a 768 y 1440 px, y continúa oculto en
teléfono. Las etiquetas contienen texto, admiten salto de línea y no dependen del color.
