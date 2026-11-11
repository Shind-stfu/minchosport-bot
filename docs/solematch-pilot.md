# Piloto local de SoleMatch

El piloto construye un manifiesto con las fotos etiquetadas en la app y puntúa predicciones contra etiquetas verificadas. Solo abre `business.sqlite` en modo de solo lectura; no cambia productos, etiquetas, imágenes ni sesiones. Los resultados y el manifiesto se guardan bajo `data/solematch-pilot/`, carpeta excluida de Git. El manifiesto contiene rutas locales e identificadores SHA-256; no lo publiques.

## Estado de licencia

La app integra el encoder CLIP de `Xenova/clip-vit-base-patch32` con licencia MIT, como búsqueda local entre las referencias verificadas. Esta ruta queda en modo de evidencia y aparece en los detalles y métricas; no decide la marca.

El repositorio público de SoleMatch no incluye un archivo de licencia para su código y la URL `LICENSE` devuelve 404. La lista de archivos tampoco incluye el checkpoint ResNet50 que describe el README; no encontré una descarga oficial de ese peso ni una licencia para él. El conjunto fuente `ipogorelov/sneakers` anuncia licencia MIT, pero eso no concede por sí solo derechos sobre el código o el checkpoint entrenado de SoleMatch. La implementación y los pesos upstream de ResNet50 siguen bloqueados. Se pueden evaluar predicciones producidas por una copia autorizada con el CSV descrito abajo.

## Ejecutar en Windows

Usa Python 3.10 o posterior. Cierra la app para tomar una instantánea estable de la base y ejecuta PowerShell desde la raíz del repositorio:

```powershell
py -3 apps/server/scripts/solematch_pilot.py `
  --data-dir "$env:LOCALAPPDATA\BotDistribuidorTenis\modes\experimental"
```

El comando informa cuántas etiquetas, fotos de referencia y ejemplos de evaluación encontró, calcula las métricas de las señales guardadas en la base y genera `data/solematch-pilot/report.json` y `data/solematch-pilot/manifest.jsonl`. Si `DATA_DIR` está configurado en `.env`, pasa a `--data-dir` su subcarpeta `experimental`.

Para puntuar otro codificador autorizado, entrega sus predicciones con una fila por SHA-256:

```csv
sha256,brand
<sha256 de la foto>,nike_air_jordan_1_high
```

Admite una columna `brand`, `prediction` o `model`; las clases `nike_air_jordan_*` y `jordan_*` se convierten a Jordan antes de las clases Nike. Las predicciones vacías cuentan como abstenciones. Ejecuta con `--clip-predictions ruta.csv` o `--resnet-predictions ruta.csv`; ambas se puntúan sobre los mismos holdouts.

## Reglas de la evaluación

- Las etiquetas holdout nunca pasan al catálogo de referencias. Las fotos repetidas por SHA-256 se cuentan una sola vez; si una misma foto tiene etiquetas incompatibles, se excluye del informe.
- Una etiqueta verificada con marca nula se cuenta como negativa (sin marca legible o sin calzado). La base actual no registra cuál de esas dos causas eligió la persona, así que el reporte las agrupa.
- Se informan precisión (acierto entre predicciones emitidas), cobertura (holdouts con predicción), recuentos por marca esperada, matriz de confusión, omisiones y predicciones faltantes.
- Una métrica por pocas fotos se muestra, pero no demuestra que el modelo generalice ni se usa para aprobar marcas.
- `Recall@1` de búsqueda de modelo del README upstream no se interpreta como precisión de marca.

El informe siempre calcula de nuevo el tamaño del conjunto disponible. Las métricas sobre pocas etiquetas se muestran como diagnóstico, no como prueba de generalización.
