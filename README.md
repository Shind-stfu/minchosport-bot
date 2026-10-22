# Bot Distribuidor de Tenis
mai
Aplicación local para conservar publicaciones y fotos de calzado, revisar el precio del proveedor, calcular un margen en COP y preparar el flujo de distribución.

**Estado actual: prototipo local con conexión experimental de Baileys.** Admite varias cuentas y perfiles de proveedor. Cada foto que llega a un grupo proveedor se conserva como referencia separada junto con su descripción; los importes claros se ajustan por el margen de ese proveedor y los dudosos se dejan para revisión. En el detalle puedes corregir el código, elegir la esquina y comparar la foto original con la copia marcada. Puedes enviar una referencia o pulsar **Aprobar todo y enviar todo** para la cuenta y el filtro seleccionados. Un envío incierto se detiene y no se reintenta automáticamente. El plan completo está en [`PLAN.md`](./PLAN.md).

Baileys es una implementación comunitaria no oficial del protocolo de WhatsApp Web, no una API aprobada por Meta. [Los términos de WhatsApp](https://www.whatsapp.com/legal/terms-of-service) y su [guía de uso responsable](https://faq.whatsapp.com/361005896189245/?eea=0&locale=en_US) restringen usos no permitidos y pueden ocasionar restricciones de cuenta; el [proyecto Baileys](https://github.com/WhiskeySockets/Baileys) también advierte que es una biblioteca no oficial y que desaconseja mensajería automatizada o masiva. No hay técnicas para ocultar automatización, evadir controles o rotar cuentas. Usa solo grupos propios/autorizados y publicaciones con permiso del proveedor.

## Requisitos

- Node.js 24 LTS x64.
- pnpm 11.25 o una versión compatible con `packageManager`.
- Windows 11 o macOS para desarrollo local.

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

El servidor usa `127.0.0.1:3210`; si se cambia `PORT`, configura también el proxy de Vite para desarrollo. `DATA_DIR` debe ser una ruta absoluta. No pongas la base de datos dentro de una carpeta de red o sincronización activa.

## Uso

1. Para habilitar la conexión, cambia `APP_MODE=experimental` y `WHATSAPP_ENABLED=true` en `.env`; reinicia el servidor. Mantén `WHATSAPP_SEND_ENABLED=false` hasta validar la recepción.
2. En **Cuentas de WhatsApp**, conecta cada número por QR, actualiza sus grupos y guarda hasta cinco destinos. Cada cuenta conserva su propia sesión, proveedores y destinos; ahí puedes ajustar el intervalo entre fotos y el horario diario de recepción (09:00–21:00, hora de Colombia, inicialmente).
3. En **Reglas por proveedor**, crea un perfil por grupo de origen. Configura por separado la ganancia de **PRECIO** y **CAJA** (incluido $0), la marca de bodega y la esquina predeterminada. Por ejemplo, con $10.000 para PRECIO y $5.000 para CAJA, `PRECIO $45.000` y `CAJA $35.000` se publican como `$55.000` y `$40.000`. Si una bodega ya publica con tu ganancia incluida, configura ambos márgenes en $0. Toda línea que contenga **DOCENA** o **DOCENAS**, incluida **CAJA Y DOCENA**, se excluye del cálculo y se elimina de la descripción publicada, con o sin importe y sin distinguir mayúsculas; la publicación recibida permanece intacta en el catálogo. La aplicación no adivina ni recalcula reglas para referencias existentes.
4. Las fotos y descripciones de grupos proveedor seleccionados aparecen en **Catálogo** durante el horario de recepción. Lo que llegue fuera de horario queda en una bandeja local y se incorpora al abrirse la siguiente ventana; las publicaciones ya visibles no se ocultan al cerrar. El catálogo, fotos e historial de envíos se conservan al reiniciar. Cada fotografía se analiza automáticamente en segundo plano antes de permitir su envío; el panel muestra si se conservará original, se añadirá una marca o requiere revisión. Revisa precio, código y vista previa. En cada foto puedes elegir siempre **Conservar original**, **Agregar solo código**, **Agregar solo mundo**, **Agregar ambos** o **Usar detección automática**. Las decisiones manuales tienen prioridad sobre el OCR y se conservan al repetir el análisis o cambiar el código y la esquina. Las opciones que agregan código requieren que lo indiques. La descripción que se enviará se puede editar antes de distribuir el producto; usa **Guardar descripción** si ya está aprobado. Se mantienen los importes aprobados y se limpia de nuevo cualquier línea con docena. Los códigos explícitos `COD`/`REF`/`SKU` se reconocen junto con formatos como `015-81` y `096-215` inmediatamente después de `MUJER` o `HOMBRE`; se conserva el cero inicial. También se reconoce una referencia al principio del nombre, como `1059 *ADIDAS REPÓNSE DAMA $75.000*`; no se interpreta como referencia un importe, talla o cantidad. Si no se detecta un código, **Agregar solo código** y **Agregar ambos** abren un cuadro para escribirlo y guardarlo con la decisión de marcado. Si hay conflicto, corrígelo en la revisión. Cada fotografía es un producto; una descripción posterior solo se asocia cuando hay una única foto reciente compatible, en los demás casos queda para revisión.
5. Para autorizar envíos reales, cambia también `WHATSAPP_SEND_ENABLED=true` y reinicia. Usa **Aprobar TODO** para confirmar todos los productos de la cuenta y el proveedor seleccionados, incluidos los precios y las fotos en revisión. El cuadro muestra las descripciones e importes, permite completar precios faltantes y elegir el marcado manual de las fotos dudosas; las fotos listas conservan su decisión. Si faltan fotos, márgenes o datos válidos, se rechaza el lote completo y se indica qué corregir. Esta aprobación no envía mensajes. Después, envía una referencia o usa **Enviar aprobados** o **Enviar seleccionadas**. La confirmación muestra cuenta, cantidad y destinos; los precios o fotografías ambiguos no se envían. El resultado masivo identifica las referencias omitidas. Cada cuenta aplica una pausa configurable entre fotos (10 segundos por defecto, mínimo 5), compartida entre sus grupos y conservada al reiniciar.
6. En **Historial**, consulta por cuenta la recepción de fotos y descripciones, preparación de precios, conexión, cambios de reglas y resultado de cada foto enviada. Puedes filtrar por tipo, estado y búsqueda; el historial se actualiza mientras la pestaña está abierta. La confirmación de Baileys no garantiza entrega a los miembros del grupo.

La opción de conexión se habilita en macOS y Windows: la clave maestra queda en el Llavero de macOS o protegida con DPAPI CurrentUser en Windows, y credenciales/claves Signal se guardan cifradas con AES-256-GCM dentro de SQLite. El primer acceso puede solicitar permiso del almacén seguro. El QR es temporal y se entrega solo al panel local. La clave del almacén está ligada al usuario del sistema; mover solo SQLite a otra cuenta/equipo no traslada la sesión.

## Alcance del conector

Al vincular o reconectar una cuenta, el adaptador acepta los lotes de historial inicial, reciente y las respuestas a solicitudes puntuales que Baileys entregue, con una ventana máxima de 24 horas y procesamiento de mensajes únicamente si pertenecen a grupos proveedor activos de esa cuenta. Baileys/WhatsApp no garantiza que entregue todo el historial ni permite asegurar que la recuperación esté completa; el panel muestra cuántos mensajes fueron entregados y una advertencia. La sincronización de historial completo queda desactivada. El horario controla cuándo aparecen los mensajes recibidos, no cuándo se conecta la cuenta: mantenla conectada para que se guarden fuera de horario. Si llegan después de terminar el intento inicial de recuperación, el panel actualiza el estado y el contador; también cuenta los mensajes recientes entregados como anexados (`append`), sin volver a contar los ya guardados. Las consultas de grupos se comparten entre eventos y usan una pausa si WhatsApp responde `rate-overlimit`. El programa reconecta al iniciar solo cuentas con credenciales guardadas y no genera QR para cuentas nuevas automáticamente. Cada foto abre una referencia independiente. Una descripción en el mismo mensaje se asocia a esa foto; una descripción en un mensaje cercano solo se adjunta si existe una única fotografía compatible del mismo remitente en esa cuenta y grupo. Si hay varias fotos posibles, la asociación queda pendiente para revisión. El envío publica una foto marcada por grupo con el texto ajustado como descripción.

Después de escanear un QR, WhatsApp puede cerrar el primer socket con `restartRequired` (515) para que el cliente vuelva a abrirlo con las credenciales recién emitidas. El adaptador guarda esos cambios antes de reiniciar el socket; otros cierres quedan visibles en el panel para diagnóstico y reconexión manual.

La descripción enviada quita los emojis decorativos y conserva el texto, los saltos y el formato; `💲` se convierte en `$` para mantener clara la moneda. La descripción recibida permanece intacta para consulta.

El OCR de [Tesseract.js](https://github.com/naptha/tesseract.js/) y la búsqueda visual empiezan automáticamente al guardar la fotografía y se ejecutan en este computador. Se revisan las cuatro esquinas para asociar código y mundo en una misma etiqueta; por ejemplo, `960 A 🌍` se conserva sin cambios cuando el código del producto es `960`. Si hay una etiqueta parcial clara, se añade únicamente lo que falta. Si la lectura falla, es incierta o muestra un código diferente, el envío queda bloqueado hasta que confirmes la foto original, corrijas el código o indiques qué marcar. **Volver a analizar las fotos** repite la lectura local. El original permanece intacto. En macOS la etiqueta usa San Francisco y Apple Color Emoji del sistema; en Windows usa Segoe UI y Segoe UI Emoji, y otros sistemas usan los recursos Noto/Twemoji incluidos. Las fuentes del sistema no se copian ni distribuyen. La etiqueta queda desplazada hacia el interior de la foto en cualquiera de las cuatro esquinas. La primera inspección necesita conexión para descargar y guardar los archivos de idioma del OCR en `ocr-cache/` dentro de la carpeta local de datos; las imágenes no se envían al servicio de descarga. Los importes incrustados no se alteran mediante OCR. Solo se aprueba automáticamente un precio textual con etiqueta inequívoca y sin conflicto. El estado `submitted` indica que Baileys devolvió el identificador de mensaje; no prueba entrega o lectura por los miembros.

## Datos y seguridad

- Windows: `%LOCALAPPDATA%\BotDistribuidorTenis\simulation\business.sqlite`; macOS: `~/Library/Application Support/BotDistribuidorTenis/simulation/business.sqlite`. Incluye cuentas, proveedores, productos, grupos, publicaciones, auditoría, actividad local y registros cifrados de autenticación.

El catálogo y el historial de publicaciones quedan guardados en SQLite entre reinicios. Para borrar productos enviados, usa **Eliminar enviados** en el catálogo; las publicaciones pendientes o inciertas se conservan para conciliación. Los mensajes recibidos se deduplican por cuenta, grupo e ID de WhatsApp aunque el producto se elimine.
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
