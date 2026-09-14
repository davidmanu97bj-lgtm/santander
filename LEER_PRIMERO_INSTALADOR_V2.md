# Explora — instalador V2, corrección de la comparación con GitHub

Esta revisión cambia el instalador y su documentación/pruebas. **No modifica los
colores, el login, las fórmulas, Functions, Rules ni los saldos del proyecto anterior.**
El ZIP sigue conteniendo el proyecto completo, incluida la corrección de saldos.

## El error de la primera entrega

El comparador juntaba las huellas del ZIP original y del ZIP de saldos. Al no
hallar en GitHub un archivo que aparecía en cualquiera de esos ZIP, lo trataba
como una eliminación. Eso es incorrecto para los 14 archivos agregados en la
entrega de saldos cuando esa entrega todavía no había sido subida a GitHub.

El comentario Git del archivo `santander-main (79).zip` identifica el commit
`54e76aa02ef90589c88ea95e21f23d720d190c53`. La consulta de `main` mediante el
conector de GitHub durante esta revisión devolvió exactamente ese mismo commit.
El historial consultado para `financial-store.js` en esa revisión devolvió vacío.
No se realizaron escrituras en GitHub ni en Firebase.

## Qué cambia V2

El manifiesto distingue los archivos ausentes en el ZIP original de los que ya
existían. El comparador verifica el commit original dentro del clon, comprueba que
sea antecesor de HEAD y consulta los cambios posteriores de cada archivo faltante.
Un archivo nuevo que aún no fue incorporado se puede agregar. Un archivo de la
base borrado, o uno nuevo agregado y luego borrado, sigue bloqueando la publicación.
También siguen bloqueados los cambios remotos desconocidos y los clones sin historia
completa. No se usa `--force`, no se ignoran conflictos ni se borran archivos remotos.
Las pruebas, las autorizaciones y la confirmación de publicación siguen vigentes.
El control previo al commit admite espacios finales que ya traían algunas Rules y
registros de pruebas de la entrega anterior, sin editar esos archivos. Sigue
rechazando los marcadores de conflictos de combinación.

## Volver a ejecutar en Cloud Shell

Subir `EXPLORA_AUTOGESTION_V2.sh`, que ya contiene el ZIP completo. Desde la carpeta
donde se subió, ejecutar:

```bash
bash EXPLORA_AUTOGESTION_V2.sh --publicar
```

No hace falta ejecutar el script anterior ni instalar primero otra entrega.
El intento fallido que se frenó en «Comparación segura con main» no alcanzó el
commit/push ni el despliegue de Rules, Functions o Hosting. El nuevo intento usa
otra carpeta privada y conserva la anterior como diagnóstico.

Mantener una copia de seguridad de Firestore y pausar a los choferes antes de la
confirmación final. El respaldo Git no es una copia de la base de datos.
Cuando terminen satisfactoriamente las pruebas, escribir `PUBLICAR EXPLORA`.
El script conserva el orden: GitHub → Rules/índices/Storage → Functions → Hosting.
La disponibilidad de dependencias, las pruebas completas, los permisos y la
publicación en la nube se vuelven a verificar en Cloud Shell. No se simula éxito.

Después de completar la publicación: **Admin → Saldos seguros** para revisar y
activar las cuentas históricas, como se explica en la guía de saldos. Este script
no activa cuentas automáticamente ni agrega ajustes a los movimientos.

## Alcance de las comprobaciones

Consultar `docs/instalador-v2/QA.md`. Las pruebas de esta revisión son locales; no
constituyen una publicación ni una prueba del sistema contra tu Firebase real.
Los módulos de la aplicación se conservan byte por byte respecto del ZIP anterior.
