# Atlas de fuego · San Juan

## Abrir localmente

Con Node.js 22 o posterior, desde la carpeta del proyecto:

```sh
node scripts/build.mjs
node --env-file-if-exists=.env scripts/serve-local.mjs
```

Abrí http://127.0.0.1:8080. Para activar la descarga automática, copiá `.env.example` como `.env` y configurá `FIRMS_MAP_KEY` en ese archivo. La clave de producción se configura como secreto del servidor. El mapa, el piloto LETKF y el histórico agregado se incluyen precalculados.

El directorio `laboratorio_original/` conserva el código, ejemplos y pruebas del paquete original. La aplicación actual usa `web/`, `worker/` y los scripts Python de la raíz.

## Piloto LETKF

Datos originales de los productos públicos FIRMS NRT de MODIS, NOAA-20 y NOAA-21 del 8 al 15 de noviembre de 2026 (último día parcial). El CSV S-NPP descargado solo contenía encabezado para la descarga seleccionada. Las observaciones se recortan por el límite departamental de Georef/IGN. Para la asimilación se aplican filtros de confianza, FRP positivo y tipo de anomalía si la fuente lo trae. La descarga web conserva las filas originales normalizadas que entraron al recorte, incluidas las descartadas por esos filtros.

La preparación usa el código LETKF recibido, un operador de observación por sensor y una malla plana fija de 375 m. Las teselas tienen un margen de 6 km y se computan independientemente. El modelo usa el mismo prior y semilla por tesela y se ejecuta con ambos sensores y con cada familia por separado. Para el piloto el sesgo multiplicativo queda fijo en 1, se evita introducir no detecciones sintéticas y se limita la energía publicada a las celdas a hasta 6 km de una detección en las últimas 12 horas. Esos límites son decisiones experimentales. El producto fino contiene celdas-día con energía de al menos 0,01 MWh.

En la web se suma a 1,5 km antes de aplicar el umbral por celda-día. El valor inicial es 1 MWh, ajustable. El calendario mensual muestra valores diarios y el resumen de período suma celdas-día. Los resultados muestran celdas estimadas con actividad térmica, no incendios únicos ni área quemada. Las horas del calendario reciente son UTC-3. El valor en blanco indica que falta una estimación positiva suficiente o queda fuera de los datos. La cobertura válida no se infiere a partir de CSV positivos.

```sh
pip install -r requirements.txt
python preparar.py CARPETA_CSV --start 2026-11-08 --end 2026-11-15 --members 12
python validar.py > web/validacion_piloto.csv
```

La comparación exploratoria incluye 0,375, 1,5, 3 y 6 km y cuatro umbrales. El Jaccard cuenta el solapamiento espacial entre las celdas activas de ambas ejecuciones por fecha. Un cero puede reflejar falta de registros y no verifica ausencia real de fuego. Los resultados no calibran el umbral ni validan equivalencia histórica.

## Histórico

La vista histórica usa conteos FIRMS archivados ya agregados por celda-día (V10, 50 km, UTC) y estados mensuales del modelo anterior V12 (desde 2003), independientes del piloto LETKF. Se eligieron celdas con centro dentro de San Juan a partir de los límites de Georef/IGN. Las celdas de borde abarcan territorio externo y los cortes por departamento son aproximados. Las descargas históricas llevan el soporte de 50 km. Los píxeles originales se incluyen para el piloto reciente.

```sh
python importar_historico.py Atlas_Fuego_V12_Proyecto_Web.zip ENTRADA_HISTORICA_REPRODUCIBLE.zip
```

No hay una serie LETKF continua 2000–presente. Las anomalías V12 y la energía del piloto no se empalman. Para completar ese producto hacen falta los históricos de detecciones nativas, las máscaras de observación L2, procesamiento por ventanas con continuidad espacial y temporal y validación fuera del período utilizado para fijar los parámetros.

## Consultar otro intervalo desde el navegador

Elegir las fechas y pulsar **Analizar**. El servidor solicita los registros pendientes a NASA con el secreto `FIRMS_MAP_KEY`. El motor usa el mismo código Python en un Web Worker y se carga desde la CDN de Pyodide. El visor incorpora resultados por bloques de hasta 14 días, pide CSV de hasta 5 días y usa los productos estándar donde estén disponibles. El día previo al bloque da un margen de arranque al modelo. Las fechas ya procesadas o consultadas sin datos se reutilizan durante la sesión. Los resultados se pueden exportar como JSON.

Ejecutar `node scripts/build.mjs` para generar el Worker. El servidor estático de Python permite probar el mapa. La descarga bajo demanda usa el endpoint del Worker.

Después de editar el motor, regenerar su paquete estático desde el directorio del proyecto:

```sh
python -m zipfile -c web/motor-letkf.zip preparar.py frp_enkf/*.py
```
