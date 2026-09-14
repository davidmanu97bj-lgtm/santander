# Explora — corrección de saldos confirmados

**Entrega: 14/09/2026. Base: `santander-main (79).zip`.**

Este es el proyecto completo, no un parche para reemplazar únicamente `index.html`.
La corrección está en el navegador, las funciones de Firebase y las reglas de
Firestore. **No se publicó en producción ni se modificaron datos reales.**

## Qué resuelve

Antes, cada comprobante podía guardar «Antes / Después» con una lista local atrasada.
Ahora cada chofer tiene una cuenta del servidor y un número de secuencia. La misma
transacción lee esa cuenta, comprueba los documentos originales, registra la
operación, conserva sus cambios para auditoría y actualiza el saldo y la secuencia.
Dos operaciones concurrentes comparten esa lectura: no pueden confirmar ambas
como sucesoras del mismo estado.

El historial nuevo representa las entradas confirmadas del libro. El saldo principal
usa la cuenta confirmada. Los campos de saldo de los avisos de Telegram se guardan
con el resultado de esa transacción; no se acepta como definitivo el número que
calculó la vista previa del teléfono. Los avisos pueden llegar en un orden diferente
por la entrega de eventos, pero identifican su operación y conservan su saldo propio.

Se mantiene la política del ZIP recibido, sin volver a convertir los cobros nuevos
al 50/50:

| Registro nuevo | Principal | Segundo componente | Neto |
|---|---:|---:|---:|
| Efectivo | +100% | +5% caja efectivo | +105% |
| Digital | −100% | +5% caja digital | −95% |
| Uber verificado vigente | +100% | +5% caja Uber | +105% |
| Gasto compartido | +100% | −50% reintegro | +50% |
| Gasto 100% chofer | +100% | Sin reintegro | +100% |
| Gasto 100% Explora | +100% | −100% reintegro | 0% |

Gestión conserva ±100% según la entrega/cobro. Las deudas pendientes no impactan
antes de su aceptación, y los adelantos conservan su cuenta separada y su flujo de
aprobación existente. El catálogo de gastos no se cambió. Los registros históricos
mantienen sus propias versiones de fórmula, cierres y bases heredadas.

La prueba del incidente parte de $1.406.876: digital $85.000 → $1.326.126;
efectivo $32.500 → **$1.360.251**. El segundo movimiento ya no parte otra vez de
$1.406.876. **No se agregó un ajuste manual de $80.750.**

## Antes de subir a GitHub

Descomprimir el ZIP y copiar el **contenido de `santander-main/`** a la raíz de una
rama de trabajo del repositorio. Conservar la carpeta `.git` de la copia Git local.
No subir el ZIP como único archivo ni colocar el proyecto dentro de otra carpeta
anidada del repositorio. Revisar el diff y los archivos nuevos antes del commit.

La lista exacta está en `docs/saldos-confirmados/CAMBIOS.json`. Se conserva el
código histórico que traía el ZIP, aunque no todo se use en la entrada actual.
`node_modules`, `dist`, cachés y credenciales de servicio no son parte de esta
entrega de fuentes. El comando de compilación genera `dist`.

No mezclar esta entrega con cambios posteriores hechos en otra rama sin resolver
el diff. La base de esta entrega es el ZIP 79, no una lectura de `main` en GitHub.

## Comprobaciones antes de producción

En Node.js 22, desde la raíz:

```sh
npm ci --prefix functions --ignore-scripts
npm run test:ledger
npm test
npm run build
npm run test:ledger:emulator
```

`test:ledger` ejecuta 23 pruebas nuevas sin credenciales ni red. Prueba transacciones
con una base en memoria que detecta conflictos, el adaptador del cliente y los
handlers reales del servidor con servicios externos sustituidos por dobles de
prueba. **No equivale a ejecutar Firebase real.**

`test:ledger:emulator` descarga/usa la misma versión fijada de Firebase CLI que el
script de despliegue y utiliza Firestore y Auth locales con el proyecto
`demo-explora-ledger`. Requiere poder instalar las dependencias y los requisitos
locales que indique Firebase para los emuladores. Comprueba transacciones con el
SDK real, el encadenamiento y el rechazo de escrituras directas con Rules. El test
se niega a usar un host no local o un proyecto que no empiece por `demo-`.

La ejecución de esa prueba dentro de la suite normal aparece omitida cuando no
hay emuladores. Por eso **`npm test` no sustituye a `test:ledger:emulator`** para
aprobar esta migración. Revisar también el inicio de sesión y los formularios en
un entorno aislado de datos reales; una URL de preview con la configuración actual
seguiría apuntando al proyecto de producción.

### Qué se verificó en el entorno de entrega

- Sintaxis: **44 archivos**, sin errores.
- Validación de configuración/recursos y compilación de Hosting: correctas.
- Pruebas nuevas del saldo: **23 aprobadas, 0 fallos**.
- Intento de suite completa: **195 aprobadas, 4 archivos de prueba no pudieron
  cargar sus dependencias y 1 prueba de emuladores omitida**. La suite completa
  no se declara aprobada.

La instalación npm falló por conectividad/DNS (`EAI_AGAIN` al registro npm).
Los cuatro archivos bloqueados requieren `node-forge` o los paquetes Firebase;
no se quitaron ni se marcaron artificialmente como aprobados. Sus resultados
están en `docs/saldos-confirmados/PRUEBAS_COMPLETAS.txt`. **No se ejecutó una prueba
contra Firestore real, no se compilaron Rules en el emulador en este entorno y no
se envió un Telegram real.** Completar esas verificaciones antes de producción.

## Publicación: hacerla completa y en una ventana de mantenimiento

Primero realizar una copia/exportación de Firestore y conservar la versión
anterior del repositorio. Coordinar que los choferes terminen los registros en curso.

Esta entrega bloquea las escrituras financieras directas de los clientes antiguos.
Si solo se publican reglas, las pantallas viejas no podrán guardar. Si solo se
publica Hosting, faltarán los endpoints o su protección. No usar `--only hosting`
para introducir este cambio.

Después de verificar las pruebas, revisar el commit e integrarlo en `main`, utilizar
el script de despliegue existente del proyecto desde una copia Git limpia:

```sh
npm run deploy -- --deploy <SHA_COMPLETO_DE_MAIN>
```

Sustituir el marcador por el SHA real de 40 caracteres. El script valida repositorio,
commit y dependencias y despliega reglas/índices/Storage, Functions y Hosting en ese
orden. Requiere acceso autorizado al Firebase de Explora. Esta entrega **no ejecutó**
el comando de publicación ni cambió permisos de GitHub.

Si una etapa falla, no reabrir la operación normal antes de verificar las etapas
completadas. Un rollback solo del cliente no restaura compatibilidad con estas
reglas. Evitar regresar a escrituras directas después de activar las cuentas;
conciliar primero cualquier operación realizada durante una transición incompleta.

## Activar las cuentas históricas, una por vez

Después de completar el despliegue, ingresar como David y abrir **Admin → Saldos
seguros**. Elegir el chofer y pulsar **Revisar saldo**.

La consulta es de solo lectura. Reconstruye el total con las reglas originales,
informa la cantidad de documentos y posibles saltos entre fotografías históricas.
Estas alertas **no prueban una deuda incorrecta**: pueden deberse a fotografías
viejas, registros sin fotografía, bajas, modificaciones o fechas simultáneas.
Se muestran como pistas, no como órdenes de cargar ajustes.

Contrastar el total con los registros y respaldos. Una vez revisado, marcar la
confirmación y activar. La activación guarda una base inicial y su huella, sin
crear cobros, gastos ni ajustes. Si los documentos cambiaron entre revisión y
confirmación, la activación se rechaza y debe revisarse nuevamente.

Las cuentas con historia **no aceptan movimientos nuevos hasta esta activación**.
Una cuenta verdaderamente vacía puede empezar automáticamente desde cero. Una
cuenta ya activa no puede reiniciarse para esconder una diferencia: si diverge
del cálculo de sus fuentes, el guardado se bloquea y exige conciliación.

Los saltos de «Antes / Después» previos a la activación **no se reescriben
masivamente**. Se conserva la evidencia original y se abre una cadena nueva desde
la base revisada. Para corregir fotografías antiguas hace falta una conciliación
histórica separada; no corresponde inventar movimientos para que las tarjetas
parezcan continuas.

## Comprobación manual después de activar

En un entorno aislado, confirmar un digital y un efectivo de la misma cuenta desde
dos sesiones. Verificar que las operaciones tienen números distintos consecutivos,
que cada «Antes» sigue al «Después» anterior y que el total coincide con la suma.
Repetir un envío tras una respuesta interrumpida y comprobar que no se duplicó.

Verificar un gasto compartido, otro de responsabilidad completa, Gestión, aceptación
de deuda, cierre aprobado/pagado y una corrección administrativa. Comparar cada
comprobante de Telegram con la operación a la que pertenece, no necesariamente con
el saldo más reciente si hubo movimientos posteriores. No usar una cuenta real
para insertar el caso sintético de $1.406.876.

## Protecciones y cambios de operación importantes

El reset masivo, el borrado completo y la eliminación del perfil desde «Borrar
chofer» quedan bloqueados para no destruir la identidad ni la evidencia contable.
**Desactivar un chofer continúa disponible.** Las anulaciones individuales se
registran con su efecto y auditoría; no borran la entrada original del libro.
Los archivos de comprobantes no se eliminan al anular una operación.

Los cambios fiscales existentes conservan sus restricciones: no se habilitó editar
libremente un cobro vinculado a una solicitud fiscal. Tampoco se cambió la política
de aceptación de semanas Uber o su verificación de comprobantes.

Sin conexión no hay confirmación financiera local definitiva: el guardado necesita
respuesta del servidor. Un aviso de error no autoriza sumar o restar manualmente;
reintentar la misma operación conserva sus identificadores de idempotencia.

## Diseño, costo y límites de esta primera implementación

Por prudencia con las fórmulas heredadas, cada transacción vuelve a contrastar las
cinco colecciones contables del chofer. **No es un guardado de una sola lectura**:
el costo y la latencia de lectura crecen con su historial, y los reintentos por
conflicto vuelven a ejecutar lecturas. Revisar el consumo de Firestore y los tiempos
antes de extender el uso a una flota mayor.

El límite conservador es de 12.000 documentos fuente por cuenta y 40 escrituras
financieras por solicitud del cliente. No se recorta la historia para aparentar
un saldo válido: si se supera el límite, la operación falla sin aplicar dinero.
Esta entrega no incluye archivado automático. Antes de llegar a ese tamaño hace
falta diseñar/validar un archivado o una agregación incremental con bases auditadas.
No ampliar el límite sin revisar tiempos, costos y límites del servicio.

Colecciones nuevas: `driver_settlement_accounts`, `driver_settlement_entries`,
`settlement_entry_changes`, `settlement_account_reviews` y
`settlement_commit_requests`. Los clientes no pueden escribirlas directamente.
El cálculo público `team_realtime_balances` se actualiza junto con la cuenta;
sus procesos de actualización releen la cuenta vigente para no publicar saldos
anteriores por eventos retrasados.

## Archivos principales

`functions/settlement-ledger.js` implementa la cuenta, secuencia, auditoría y revisión;
`functions/settlement-api.js` valida las operaciones del cliente; `financial-store.js`
redirige los formularios existentes al endpoint transaccional. También se modifican
`app.js`, `functions/index.js`, `functions/uber-submission.js`,
`functions/telegram-billing-balance.js`, Rules, interfaz, compilación y pruebas.

Consultar `docs/saldos-confirmados/CAMBIOS.json` para el inventario exacto y
`docs/saldos-confirmados/RESUMEN_QA.md` para las comprobaciones y limitaciones.
