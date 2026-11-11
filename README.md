# Bot Distribuidor de Tenis
mai
Aplicación local para conservar publicaciones y fotos de calzado, revisar el precio del proveedor, calcular un margen en COP y preparar el flujo de distribución.

**Estado actual: prototipo local con conexión experimental de whatsmeow.** Admite varias cuentas y perfiles de proveedor. Cada foto que llega a un grupo proveedor se conserva como referencia separada junto con su descripción; los importes claros se ajustan por el margen de ese proveedor y los dudosos se dejan para revisión. En el detalle puedes corregir el código, elegir la esquina y comparar la foto original con la copia marcada. Puedes enviar una referencia o pulsar Aprobar todo y enviar todo para la cuenta y el filtro seleccionados. Un envío incierto se detiene y no se reintenta automáticamente. El plan completo está en PLAN.md.

whatsmeow es una biblioteca comunitaria no oficial del protocolo de WhatsApp y no una API aprobada por Meta. WhatsApp puede cambiar el protocolo o restringir cuentas. No hay técnicas para ocultar automatización, evadir controles o rotar cuentas. Usa solo grupos propios/autorizados y publicaciones con permiso del proveedor.

## Requisitos

- Node.js 24 LTS x64 o arm64.
- pnpm 11.25 o una versión compatible con `packageManager`.
- Windows 11 o macOS para desarrollo local.
- Go en una versión compatible con `apps/server/whatsmeow/go.mod` y un compilador C (Xcode Command Line Tools en macOS; GCC/MinGW en Windows).

## Instalación

En macOS:

```sh
corepack enable
corepack prepare pnpm@11.25.0 --activate
pnpm install
cp .env.example .env
pnpm dev
```

En Windows PowerShell:

```powershell
corepack enable
corepack prepare pnpm@11.25.0 --activate
pnpm install
Copy-Item .env.example .env
pnpm dev
```

Abre `http://127.0.0.1:5173`. El servicio guarda su base y las imágenes en una carpeta local de datos de la aplicación, fuera del repositorio. La configuración predeterminada es simulación y enlaza el servidor en loopback.

Para validar la compilación de producción:

```powershell
pnpm build
pnpm start
```

El servidor usa `127.0.0.1:3210`; si se cambia `PORT`, configura también el proxy de Vite para desarrollo. `DATA_DIR`, si se define, debe ser una ruta absoluta y se trata como raíz: el servidor guarda cada modo en `DATA_DIR/simulation` o `DATA_DIR/experimental`. No pongas la base de datos dentro de una carpeta de red o sincronización activa. En el primer arranque, los datos del diseño anterior se copian al modo seleccionado y la carpeta original se conserva.

## Uso

1. Para habilitar la conexión, cambia `APP_MODE=experimental` y `WHATSAPP_ENABLED=true` en `.env`; reinicia el servidor. Mantén `WHATSAPP_SEND_ENABLED=false` hasta validar la recepción.
2. En **Cuentas de WhatsApp**, conecta cada número por QR, actualiza sus grupos y guarda hasta cinco destinos. Cada cuenta conserva su propia sesión, proveedores y destinos; ahí puedes ajustar el intervalo entre fotos y el rango diario para recuperar historial (16:00–19:00, hora de Colombia, inicialmente). Configura las horas en **Desde** y **Hasta**. Si WhatsApp está conectado, **Guardar y recuperar** guarda el rango e inicia un intento; si todavía no comenzó, lo programa para la hora inicial; **Recuperar historial** permite reintentar el rango guardado sin desconectar. Mantén WhatsApp del teléfono conectado a Internet. La recepción de mensajes nuevos permanece activa a cualquier hora mientras la aplicación y WhatsApp estén conectados. El QR se renueva automáticamente durante el intento; **Generar otro QR** solicita uno nuevo sin borrar la cuenta. **Borrar credenciales y revincular** borra solo las credenciales de esa cuenta para revincularla.
3. En **Reglas por proveedor**, crea un perfil por grupo de origen. Configura por separado la ganancia de **PRECIO** y **CAJA** (incluido $0), la marca de bodega y la esquina predeterminada. Por ejemplo, con $10.000 para PRECIO y $5.000 para CAJA, `PRECIO $45.000` y `CAJA $35.000` se publican como `$55.000` y `$40.000`. Si una bodega ya publica con tu ganancia incluida, configura ambos márgenes en $0. Toda línea que contenga **DOCENA** o **DOCENAS**, incluida **CAJA Y DOCENA**, se excluye del cálculo y se elimina de la descripción publicada, con o sin importe y sin distinguir mayúsculas; la publicación recibida permanece intacta en el catálogo. La aplicación no adivina ni recalcula reglas para referencias existentes.
4. Las fotos y descripciones nuevas de los grupos proveedor seleccionados aparecen en **Catálogo** a cualquier hora mientras la aplicación y WhatsApp estén conectados. Al reconectar, el historial se filtra por el día en curso en Colombia y por la hora original de envío: con 16:00–18:00 solo se recupera lo enviado desde las 16:00 hasta antes de las 18:00, aunque abras la aplicación a las 19:00. Con 16:00–19:00 se incluyen también las publicaciones de las 18:00 a las 18:59. Los mensajes anteriores al rango y los de otros días se omiten. Los rangos que cruzan medianoche corresponden al último inicio de rango. La bandeja local solo mantiene mensajes pendientes de procesar, sin esperar a que abra un horario; los mensajes nuevos guardados allí sobreviven a reinicios. El catálogo, fotos e historial de envíos se conservan al reiniciar. Cada fotografía se analiza automáticamente en segundo plano antes de permitir su envío; el panel muestra si se conservará original, se añadirá una marca o requiere revisión. Revisa precio, código y vista previa. En cada foto puedes elegir siempre **Conservar original**, **Agregar solo código**, **Agregar solo mundo**, **Agregar ambos** o **Usar detección automática**. Las decisiones manuales tienen prioridad sobre el OCR y se conservan al repetir el análisis o cambiar el código y la esquina. Las opciones que agregan código requieren que lo indiques. La descripción que se enviará se puede editar antes de distribuir el producto; usa **Guardar descripción** si ya está aprobado. Se mantienen los importes aprobados y se limpia de nuevo cualquier línea con docena. Los códigos explícitos `COD`/`REF`/`SKU` se reconocen junto con formatos como `015-81` y `096-215` inmediatamente después de `MUJER` o `HOMBRE`; se conserva el cero inicial. También se reconoce una referencia al principio del nombre, como `1059 *ADIDAS REPÓNSE DAMA $75.000*`; no se interpreta como referencia un importe, talla o cantidad. Si no se detecta un código, **Agregar solo código** y **Agregar ambos** abren un cuadro para escribirlo y guardarlo con la decisión de marcado. Si hay conflicto, corrígelo en la revisión. Cada fotografía es un producto; una descripción posterior solo se asocia cuando hay una única foto reciente compatible, en los demás casos queda para revisión.
5. Para autorizar envíos reales, cambia también `WHATSAPP_SEND_ENABLED=true` y reinicia. Usa **Aprobar TODO** para confirmar todos los productos de la cuenta y el proveedor seleccionados, incluidos los precios y las fotos en revisión. El cuadro muestra las descripciones e importes, permite completar precios faltantes y elegir el marcado manual de las fotos dudosas; las fotos listas conservan su decisión. Si faltan fotos, márgenes o datos válidos, se rechaza el lote completo y se indica qué corregir. Esta aprobación no envía mensajes. Después, envía una referencia o usa **Enviar aprobados** o **Enviar seleccionadas**. La confirmación muestra cuenta, cantidad y destinos; los precios o fotografías ambiguos no se envían. El resultado masivo identifica las referencias omitidas. Cada cuenta aplica una pausa configurable entre fotos (10 segundos por defecto, mínimo 5), compartida entre sus grupos y conservada al reiniciar.
6. En Historial, consulta por cuenta la recepción de fotos y descripciones, preparación de precios, conexión, cambios de reglas y resultado de cada foto enviada. Puedes filtrar por tipo, estado y búsqueda; el historial se actualiza mientras la pestaña está abierta. La aceptación del conector no garantiza entrega a los miembros del grupo.

La conexión se habilita en macOS y Windows: la clave maestra queda en el Llavero de macOS o protegida con DPAPI CurrentUser en Windows. La sesión multidispositivo y las claves Signal de whatsmeow se guardan en un archivo SQLite cifrado con SQLCipher; su clave se deriva por cuenta y no se pasa por argumentos de proceso ni se escribe en registros. El primer acceso puede solicitar permiso del almacén seguro. El QR es temporal y se entrega solo al panel local. La clave queda ligada al usuario del sistema; mover solo la base a otra cuenta/equipo no traslada la sesión.

## Alcance del conector

El conector activo usa whatsmeow para vincular cuentas por QR, recibir mensajes, consultar grupos y publicar fotos con descripción. El catálogo, las reglas por proveedor, los destinos, las pausas entre envíos, la revisión de precios, el marcado de imágenes y el procesamiento local se conservan. Las credenciales de Baileys no se pueden importar a whatsmeow: al migrar una cuenta antigua, conecta esa cuenta y escanea un QR. Los grupos, proveedores, productos, imágenes y configuración de la cuenta se conservan; el almacén viejo de credenciales no se borra hasta que uses Borrar credenciales y revincular.

La recuperación solicita mensajes anteriores con una referencia real de grupo y mensaje mediante la sincronización puntual ON_DEMAND de whatsmeow. El programa conserva el timestamp en milisegundos y lo convierte a segundos al construir la petición, como requiere el campo de WhatsApp pese a su nombre histórico. Cada lote solicita hasta 50 mensajes; se recorren hasta 20 páginas respondidas por grupo, con al menos un segundo entre cada envío. Si el envío no se confirma o WhatsApp no responde, la misma página se intenta hasta tres veces y esos intentos no consumen el límite de páginas. Solo se consideran grupos proveedor activos y publicaciones del rango diario configurado, según la hora original del mensaje; el límite de antigüedad de recepción es 24 horas. Si el rango todavía no comienza, el intento espera hasta la hora inicial.

El panel separa grupos solicitados, pendientes y respondidos, referencias faltantes, errores, mensajes recibidos y publicaciones guardadas. Cada respuesta, incluso un lote vacío, se vincula primero con el identificador de sesión que devuelve el protocolo; si falta, el puente usa grupo y ancla únicamente cuando no hay ambigüedad. Las respuestas tardías se aceptan sin duplicar publicaciones ni cerrar solicitudes de un intento nuevo. Si no hay referencia real, se espera a que llegue un mensaje del grupo antes de solicitar historial. Una desconexión marca el intento como interrumpido y whatsmeow intenta restablecer la conexión; los fallos transitorios durante el primer enlace también se reintentan con pausa creciente hasta que aparezca el QR. Desconectar cancela la reconexión.

Los registros de diagnóstico guardan identificadores y resultados necesarios para correlacionar las solicitudes, sin almacenar claves, QR ni cuerpos de mensajes en esos registros. Las referencias de recuperación retienen solo el último identificador, hora, autor y grupo; la bandeja de recepción guarda localmente el contenido pendiente necesario para procesarlo. Cuando WhatsApp indica que venció el enlace temporal de una foto, whatsmeow puede pedir al teléfono que vuelva a subirla antes de registrar un error definitivo de descarga.

La recuperación depende de lo que WhatsApp entregue al vincular la cuenta o responder a una petición ON_DEMAND; una solicitud aceptada o una reconexión no garantizan que llegue todo el historial. La aplicación limita la incorporación al día y rango configurados y no afirma que la recuperación esté completa. Si WhatsApp no puede descifrar una publicación de proveedor, queda identificada aparte de los errores de descarga y no se incorpora al catálogo. Se espera la nueva entrega/reintento del cliente; si el error persiste tras reconectar, el panel indica que hay que revincular manualmente con el QR.

La descripción enviada quita los emojis decorativos y conserva el texto, los saltos y el formato; `💲` se convierte en `$` para mantener clara la moneda. La descripción recibida permanece intacta para consulta.

El OCR de [Tesseract.js](https://github.com/naptha/tesseract.js/) y la búsqueda visual empiezan automáticamente al guardar la fotografía y se ejecutan en este computador. Se revisan las cuatro esquinas para asociar código y mundo en una misma etiqueta; por ejemplo, `960 A 🌍` se conserva sin cambios cuando el código del producto es `960`. Si hay una etiqueta parcial clara, se añade únicamente lo que falta. Si la lectura falla, es incierta o muestra un código diferente, el envío queda bloqueado hasta que confirmes la foto original, corrijas el código o indiques qué marcar. **Volver a analizar las fotos** repite la lectura local. La letra de la etiqueta se toma de palabras completas de la descripción: **D** para DAMA, MUJER o D; **H** para HOMBRE, VARÓN/VARON, CABALLERO o H. Se aceptan minúsculas y plurales. Las letras aisladas no se buscan dentro de marcas ni códigos; si aparecen ambos géneros no se adivina uno. La letra se coloca inmediatamente después del código y antes del mundo, por ejemplo `1059D 🌎` o `1059H 🌎`, sin repetir el mismo sufijo cuando ya forma parte de un código numérico. El original permanece intacto. En macOS la etiqueta usa San Francisco y Apple Color Emoji del sistema; en Windows usa Segoe UI y Segoe UI Emoji, y otros sistemas usan los recursos Noto/Twemoji incluidos. Las fuentes del sistema no se copian ni distribuyen. La etiqueta queda desplazada hacia el interior de la foto en cualquiera de las cuatro esquinas. La primera inspección necesita conexión para descargar y guardar los archivos de idioma del OCR en `ocr-cache/` dentro de la carpeta local de datos; las imágenes no se envían al servicio de descarga. Los importes incrustados no se alteran mediante OCR. Solo se aprueba automáticamente un precio textual con etiqueta inequívoca y sin conflicto. El estado `submitted` indica que whatsmeow devolvió el identificador de mensaje; no prueba entrega o lectura por los miembros.

## Motor local de análisis de imágenes

El motor `local-ocr-consensus-v2` mantiene el OCR español/inglés y la comparación visual en el computador. El análisis completo se ejecuta en workers de Node, fuera del proceso que atiende WhatsApp y el panel. Por defecto usa un worker, o dos si hay al menos cuatro CPU disponibles y 2 GiB de memoria libre al iniciar. `IMAGE_ANALYSIS_WORKERS=1` a `4` permite ajustar el límite; cada worker reutiliza su OCR. Un análisis que falle o supere 120 segundos queda para revisión y el worker se reemplaza si se cerró o quedó bloqueado. Al cerrar, las fotos que aún estaban esperando permanecen pendientes y se retoman al iniciar.

Se comparan las lecturas de cada esquina y se envían a revisión los códigos contradictorios o con confianza insuficiente. Cuando hay un mundo localizado, se prepara un recorte de texto separado del emoji: así se evita leer el mundo como un dígito adicional. Los recortes se amplían para leer etiquetas pequeñas. La puntuación del OCR es una señal interna, no una probabilidad calibrada de acierto.

El resultado visual se reutiliza para fotos con exactamente el mismo SHA-256 y versión de motor, incluso entre reinicios. Las decisiones manuales permanecen separadas por fotografía. **Volver a analizar las fotos** fuerza una lectura nueva; los errores no se guardan en caché. El resultado cacheado se elimina al borrar la última foto que lo utiliza. Una nueva versión del motor vuelve a analizar los resultados automáticos anteriores al arrancar y conserva las decisiones manuales.

Los detalles del análisis de cada foto muestran su tiempo y si se reutilizó un resultado. La actividad guarda también la versión y las lecturas OCR realizadas. `GET /api/image-engine?sessionId=main` devuelve la versión, concurrencia y estados del análisis de esa cuenta.

Para repetir la prueba funcional con diez imágenes **sintéticas**, sin utilizar fotos de clientes:

```sh
pnpm --filter @tenis/server benchmark:images --output /tmp/image-engine-report.json
```

En Windows utiliza una ruta de salida válida para ese equipo. `--cache-dir RUTA` permite reutilizar los idiomas OCR ya descargados; la primera ejecución necesita internet para descargarlos. La prueba cubre código/mundo en cuatro esquinas, compresión JPEG, código solo, mundo solo, foto idéntica repetida y un código que no corresponde al producto. Informa tiempos, decisión esperada/obtenida y uso de caché; termina con error si una decisión no coincide. Estos casos comprueban regresiones concretas y no miden la precisión del catálogo real. El arranque en frío y las fotos nuevas tienen costes diferentes de reutilizar un resultado: esta mejora no promete que toda foto nueva se analice más rápido.

## Datos y seguridad

- Windows: `%LOCALAPPDATA%\BotDistribuidorTenis\modes\<modo>\business.sqlite`; macOS: `~/Library/Application Support/BotDistribuidorTenis/modes/<modo>/business.sqlite`, donde `<modo>` es `simulation` o `experimental`. Cada modo conserva su catálogo, grupos, publicaciones y registros cifrados de autenticación por separado. La carpeta anterior se conserva y solo se importa una vez al modo activo.

Actualizar la lista de grupos conserva los destinos guardados y los grupos proveedor aunque WhatsApp no los incluya en una respuesta parcial. En el detalle de cada producto se muestran también los destinos seleccionados que aún no tienen publicación. Si un producto fue enviado a dos grupos y falta un tercero, **Completar envío a 1 grupo** envía únicamente al pendiente; los envíos individuales y por lote omiten los destinos ya aceptados. Agregar un destino por sí solo no inicia envíos. Los envíos inciertos siguen bloqueados hasta su conciliación.

El catálogo y el historial de publicaciones quedan guardados en SQLite entre reinicios. Marca la casilla de una foto o de una referencia para seleccionar sus fotos; **Seleccionar fotos visibles** respeta la búsqueda y los filtros actuales. **Eliminar foto seleccionada** o **Eliminar fotos seleccionadas** borra únicamente la selección, sin confirmación y en cualquier estado. En el detalle también puedes usar **Eliminar esta foto**. El botón independiente **Eliminar todos** detiene los envíos y vacía todo el catálogo de la cuenta activa, sin aplicar filtros ni selección y sin confirmación, independientemente del estado. Las fotos restantes de una referencia se conservan; al borrar su última foto, también se elimina la referencia. Se interrumpen los envíos de las referencias afectadas y los de las demás pueden continuar. Una foto que ya se haya entregado al conector de WhatsApp puede completarse; los mensajes publicados no se retiran. Las fotos restantes cuyo envío estaba en curso quedan para conciliación. Se conservan las otras cuentas, los proveedores y la configuración, y el evento queda en Actividad. La recepción de nuevas publicaciones sigue activa. Los mensajes recibidos se deduplican por cuenta, grupo e ID de WhatsApp aunque la foto se elimine. El envío por selección incluye solo referencias listas con todas sus fotos seleccionadas.
- La carpeta `media/` junto a la base guarda las fotografías originales por SHA-256. Las copias marcadas se guardan en `media/derived/` y se generan de nuevo desde el original; nunca se superponen marcas sobre marcas.
- El material de autenticación se cifra con AES-256-GCM y una clave maestra guardada en el Llavero de macOS o protegida por DPAPI para el usuario actual de Windows. No subas la base local, `.env`, credenciales, medios de clientes ni capturas de QR; `.gitignore` excluye archivos de runtime.
- El servicio rechaza otros `Host` y orígenes que no sean el panel local.

Las fotos y los datos comerciales del prototipo no están cifrados; protege tu usuario y activa el cifrado de disco del equipo. La protección de autenticación usa el almacén seguro del sistema operativo; la primera conexión de WhatsApp aún requiere una prueba manual en el equipo donde la usarás.

El marcado usa [Sharp](https://sharp.pixelplumbing.com/api-constructor/) y gráficos [Twemoji](https://github.com/jdecked/twemoji) como recursos incluidos o de respaldo; consulta sus licencias y atribución en [`apps/server/assets/THIRD-PARTY-NOTICES.md`](./apps/server/assets/THIRD-PARTY-NOTICES.md). No se descargan fuentes ni emojis al procesar cada foto.

## Desarrollo

```powershell
pnpm typecheck
pnpm test
pnpm build
```

La conexión QR, recepción del proveedor, cola por destino y envío experimental están implementados para probarse localmente. La sesión y las publicaciones requieren un piloto controlado con grupos propios; la automatización no es una integración oficial ni garantiza entrega. Revisa [`PLAN.md`](./PLAN.md) para los límites investigados y las fases futuras.

### Clasificador local de zapatillas

El análisis de marcas puede usar `dima806/popular_sneakers_detection` junto con las señales existentes. Para instalar su entorno local desde la raíz del proyecto:

```bash
python3 -m venv data/sneaker-model-venv
data/sneaker-model-venv/bin/pip install 'torch==2.2.2' 'transformers==4.46.3' 'pillow>=10,<12' 'numpy<2' 'safetensors>=0.4'
```

La primera ejecución descarga los pesos desde Hugging Face; las imágenes se procesan localmente. También se puede indicar otro intérprete con `SNEAKER_MODEL_PYTHON`. El modelo clasifica modelos concretos de un conjunto cerrado; se agrupan sus puntuaciones por marca y Jordan se mantiene separado de Nike. Esas puntuaciones no son probabilidades de acierto calibradas. Las marcas desconocidas o fotos sin calzado requieren revisión. La asignación automática exige la calibración específica de esta versión; si el modelo no está disponible, se conservan las otras señales y no se asigna automáticamente.

### Detección de marca con Florence-2 y Qwen3.5

Florence-2-base-ft localiza hasta dos zapatillas en la imagen y Qwen3.5-0.8B analiza los recortes para leer el logo; esa respuesta es la sugerencia principal y se agrega automáticamente al borrador antes del código REF. SigLIP 2, las referencias guardadas y el clasificador de zapatillas quedan como señales de contraste. Si discrepan, la marca conserva el estado «por revisar», pero la sugerencia permanece en el borrador; esto no aprueba el producto ni inicia un envío. Las revisiones exactas de los dos modelos ONNX están fijadas; la primera inferencia descarga sus pesos y luego se ejecuta localmente.

Las correcciones manuales se guardan como etiquetas verificadas. Por cada marca, cuatro de cada cinco ejemplos pueden servir como referencias; cada quinto se reserva para una evaluación independiente y se excluye del buscador de referencias. El panel muestra cobertura, precisión, avance por marca y resultados separados por señal. La confirmación automática requiere al menos 20 predicciones de evaluación independiente, 95 % de precisión para esa marca, y que Florence + Qwen concuerden en el logo. Las fotos ya revisadas con modelos anteriores se vuelven a analizar al iniciar esta versión y no se cuentan como si fueran resultados de la actual.

### Comparar fotos de referencia con SigLIP 2

La aplicación utiliza SigLIP 2 localmente. Al comparar una foto con referencias guardadas, promedia las tres similitudes más altas por marca. Las referencias solo se usan como señal cuando hay al menos tres fotos distintas de esa marca y una diferencia mínima frente a la siguiente; la selección distribuye hasta ocho fotos por marca entre las fechas disponibles. La similitud coseno no representa una probabilidad y el modelo de clases cerradas solo aporta evidencia secundaria.

### Búsqueda visual SoleMatch con CLIP

La app también calcula embeddings con `Xenova/clip-vit-base-patch32` (licencia MIT, revisión fijada) y busca la foto verificada más parecida por marca entre las referencias locales. Es una señal independiente de SigLIP que aparece en los detalles y en las métricas de evaluación. Su similitud es una distancia visual, no una probabilidad; no cambia la marca sugerida, no aprueba productos ni inicia envíos. La primera inferencia descarga el modelo y guarda la caché fuera del repositorio.

El encoder ResNet50 ajustado de SoleMatch no se integra: el repositorio upstream no declara licencia de código ni distribuye ese checkpoint. El piloto y sus comandos para Windows están en [`docs/solematch-pilot.md`](docs/solematch-pilot.md).

Además, `identificar_marcas.py` permite probar por separado el checkpoint oficial `google/siglip2-base-patch16-224`, sin modificar la base de datos de la aplicación. Requiere Python 3.10 o posterior:

```bash
python3 -m venv .venv-marcas
source .venv-marcas/bin/activate
pip install -r requirements_marcas.txt
pip install pytest
python -m pytest -q tests/test_identificar_marcas.py
python identificar_marcas.py --help
```

Para un catálogo propio, organiza las fotos en carpetas como `referencias/Nike/` y `referencias/Adidas/` y ejecuta:

```bash
python identificar_marcas.py foto.jpg --referencias referencias --top-k 5
python identificar_marcas.py foto.jpg --referencias referencias --device cpu --json
```

Para usar las referencias ya guardadas en la aplicación, indica la ruta de su `business.sqlite`. Por ejemplo, en macOS con los datos predeterminados del modo experimental:

```bash
python identificar_marcas.py foto.jpg --base-de-datos "$HOME/Library/Application Support/BotDistribuidorTenis/modes/experimental/business.sqlite" --json
```

La consulta se excluye del catálogo si su contenido es idéntico a una referencia. Las imágenes dañadas se informan y se omiten. La primera ejecución descarga el modelo; las posteriores utilizan la caché local y pueden funcionar sin internet. Las fotos nunca se envían a un servicio externo. Se selecciona CUDA, MPS o CPU automáticamente; `--device` permite elegir el dispositivo, y `--lote` controla la cantidad de imágenes procesadas a la vez.

El resultado es una **marca estimada por parecido visual**, no necesariamente por un logo visible. La similitud coseno no es una probabilidad. Sin `--umbral` siempre se propone la marca más cercana; si la marca real no está en el catálogo, esta propuesta puede ser incorrecta. `--umbral` permite obtener «Desconocida», pero debe elegirse y evaluarse previamente con fotos separadas y ejemplos negativos; no hay un valor recomendado o calibrado por defecto. Las referencias que se usan para buscar coincidencias no sirven para medir por sí solas la precisión de generalización.
