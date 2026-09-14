# Verificación del instalador V2 — 14/09/2026

## Resultado local

- 27 pruebas Python del instalador: aprobadas (10 conservadas y 17 nuevas).
- 58 pruebas Node seleccionadas: aprobadas (deploy, saldo confirmado, login y colores).
- Sintaxis de 46 archivos JavaScript: correcta. Sintaxis Bash del instalador: correcta.
- Compilación de Hosting: correcta.
- Escenario completo sobre una copia del ZIP79 en un repositorio Git temporal:
  el comparador anterior reprodujo los mismos 14 falsos conflictos del usuario;
  el nuevo comprobó y copió todos los archivos incluidos sin ese bloqueo.
- El control previo al commit admite espacios finales heredados en Rules y archivos
  de pruebas sin cambiar sus bytes. Sigue rechazando marcadores de conflictos.
- Se verifica la extracción del instalador autocontenido y la igualdad de su ZIP.

Los escenarios de eliminación de un archivo original, agregado y posterior borrado,
renombrado, cambios en una rama fusionada, edición desconocida e historia incompleta
siguen bloqueados. El modo de revisión no copia; un conflicto impide todo el copiado.
Los archivos adicionales del remoto se conservan. Reintentar la misma entrega es seguro.

## Alcance

No se cambió ningún archivo de código del cliente, Functions, Rules ni el modelo
contable respecto de `Explora_GitHub_colores_login_saldos.zip`. Se cambian solo los
auxiliares de instalación, su manifiesto, documentación y pruebas. El inventario
está en `CAMBIOS.json`.

GitHub se consultó en modo lectura: main devolvió
`54e76aa02ef90589c88ea95e21f23d720d190c53`, coincidente con el comentario Git del ZIP79.
La reproducción usa un commit sintético con esos archivos, no modifica el repositorio
remoto y no se presenta como un despliegue real.

No se ejecutaron autenticaciones, push, despliegues ni operaciones contra Firebase
real. En esta revisión no se volvió a ejecutar la suite completa con dependencias
ni los emuladores. El asistente mantiene ambas verificaciones obligatorias en Cloud
Shell antes de publicar y conserva los límites explicados en la entrega anterior.

Referencias de los comandos Git usados:
- https://git-scm.com/docs/git-log
- https://git-scm.com/docs/git-merge-base
- https://git-scm.com/docs/git-ls-tree
