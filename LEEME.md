# RODEO

Sistema ganadero de cabaña: un bot que es Claude con acceso directo a la base,
un tablero con todo lo de cada animal, y las herramientas para meter y sacar
datos sin fricción.

## Qué hay

| Archivo | Qué hace |
|---|---|
| `server.js` | el servidor: rutas y conexión de todo |
| `bot.js` | el bot: Claude con razonamiento extendido, sus herramientas, la memoria y las conversaciones |
| `plantel.js` | todo lo que se calcula de cada vientre: estado, eficiencia, bloques, ficha reproductiva |
| `animales.js` | búsqueda de cualquier animal (tolera "011" por "11", "b 332" por "B332"), ficha general, terminación |
| `exportar.js` | emisión de archivos: Excel, CSV, página imprimible, JSON; archivos que arma el bot |
| `relevar.js` | carga de campo con validación: pesadas, sanidad, nacimientos, mediciones, notas; importar CSV; planilla para el campo |
| `xlsx.js` | escribe Excel sin dependencias: encabezado pintado, filtro, panel congelado, números y fechas reales |
| `destinos.js` | a dónde va cada animal cuando sale del plantel |
| `public/index.html` | el tablero |
| `datos/semilla.js` | arma una base de prueba para correr en la compu (`npm run semilla`) |
| `datos/prueba.js` | pruebas automáticas de todo, con un Claude simulado (`npm run prueba`) |
| `datos/preguntas.js` · `datos/evaluar.js` | el banco de preguntas y el corredor que mide al bot de verdad (`npm run evaluar`) |

## Correr en la compu

```bash
npm install
node datos/semilla.js                     # base de prueba en ./data/principal.db
ANTHROPIC_API_KEY=sk-... DB_DIR=./data node server.js
```

Abre en http://localhost:3001. Sin clave de API el tablero anda igual; sólo el chat no responde.

## Variables en Railway

| Variable | Para qué |
|---|---|
| `ANTHROPIC_API_KEY` | la clave de la API |
| `DB_DIR` | dónde vive la base. En Railway: `/data`, con un volumen montado ahí |
| `CAMPOS` | JSON con los campos (ver abajo) |
| `MODELO` | opcional. Por defecto `claude-opus-5`. Para comparar: `claude-sonnet-5`, `claude-fable-5-1` |
| `ESFUERZO` | opcional. `high` por defecto; `medium` para abaratar, `xhigh`/`max` para exprimir |
| `TWILIO_SID` / `TWILIO_TOKEN` | sólo si se usa WhatsApp |
| `RESPALDO_CLAVE` | una clave cualquiera; habilita `/api/respaldo?clave=...` para bajar una copia de la base |
| `WHATSAPP_PERMITIDOS` | números que pueden hablarle, separados por coma (`5491155551234,5491166665678`). Sin esto, cualquiera |
| `URL_PUBLICA` | la dirección de la app (`https://tu-app.up.railway.app`), para que los links lleguen bien al teléfono |
| `WHATSAPP_CAMPOS` | si hay varios campos: JSON número → clave (`{"5491155551234":"videla"}`) |

Node 22 o más nuevo (`engines` en `package.json` lo pide; Railway lo respeta). La
versión 13 de `better-sqlite3` trae el binario compilado para Node 22 a 25, así
no hace falta compilar nada ni en Railway ni en la compu.

Ejemplo de `CAMPOS`:

```json
{"principal":{"nombre":"Angus del Este","empresa":"improlux"}}
```

## Buscar

Arriba a la derecha (o tecla `/`) se busca cualquier animal: RP, caravana
electrónica, HBA, madre, padre o palabras de las notas. Entiende cómo se escribe
en la manga: `011` y `11` son lo mismo, `b 332` es `B332`, `hércules` encuentra
a todos los hijos de Hércules. Enter abre la ficha.

La ficha existe para todos los animales, no sólo los vientres: pesadas con
ganancia diaria, sanidad, lotes, hijos, notas. Desde ahí se pesa, se anota y
se bajan sus pesadas.

Cada tabla tiene su propio filtro (mismo criterio), filtros por pelaje,
categoría, estado, bloque y sexo, y un selector de columnas que se recuerda.

## Las pestañas del tablero

Cada pestaña tiene su propia regla; un animal puede estar en varias.

| Pestaña | Quién aparece |
|---|---|
| Plantel | hembras activas que son VACA o VIENTRE, o que ya tienen cría, o que entraron a servicio |
| Toros | machos activos con categoría TORO. Sus hijos se cuentan por `padre_rp` igual al RP **o al nombre** del toro |
| Nacimientos | nacidos en el año de parición en curso, con madre cargada |
| Recría | activos de 6 a 20 meses |
| Terminación | los que están en un **lote** cuyo nombre contiene TERMINACION o CORRAL, más los marcados con un destino de terminación que todavía no salieron (columna Origen: "en corral" o "marcado") |
| Destinos | lo marcado en la tabla `destinos` para la temporada actual |
| No destetaron | las del plantel con estado FALLÓ |
| Todos | todos los registrados, con filtro por estado |

Los animales tienen columna `nombre` (se agrega sola en bases viejas): sirve
sobre todo para los toros, así "Hércules" se encuentra y se cuenta como padre.

## Exportar

Botón **Exportar** en cada tabla:

- **Excel / CSV / Imprimir** de lo que se ve: respeta filtros, orden y columnas elegidas.
- **Planilla de relevamiento** con los animales a la vista y columnas vacías para anotar.
- **Rodeo completo**: un Excel con una hoja por tabla.
- Pesadas, servicios, sanidad, notas y lotes completos.

Rutas, por si se usan de afuera:

| Ruta | Qué devuelve |
|---|---|
| `GET /api/exportar/:conjunto.:formato` | `plantel`, `animales`, `nacimientos`, `recria`, `terminacion`, `destinos`, `fallos`, `pesadas`, `servicios`, `sanidad`, `mediciones`, `notas`, `lotes`, `rodeo` · en `xlsx`, `csv`, `html`, `json` · `?rps=a,b&columnas=rp,peso&orden=rp&desc=1` |
| `POST /api/exportar` | lo mismo con `{conjunto, formato, rps, columnas, filtro, orden}` |
| `GET /t/:slug.xlsx` · `.csv` | las tablas de un tablero armado por el bot |
| `GET /api/archivos` · `/archivos/:id/:nombre` | los archivos que armó el bot |
| `GET /api/planilla?lote_id=` · `?rps=` · `?conjunto=` | planilla para el campo (`&formato=html` para imprimir) |

El CSV sale con `;` y coma decimal, que es lo que abre bien el Excel en
español. `?sep=,` para el otro.

## Relevar

Pestaña **Relevar**. Todo tiene dos pasos: *Revisar* muestra fila por fila qué
entendió, qué RP no reconoce y qué no cierra; *Confirmar* escribe.

- **Pesadas**: se pega `RP peso`, una línea por animal, como está en la libreta. Avisa si un peso bajó más de 12% o subió más de 3 kg/día respecto de la pesada anterior, y no repite una pesada ya cargada.
- **Sanidad**: un producto a una lista de RP, a un lote o a todos.
- **Nacimientos**: `RP-ternero madre fecha sexo peso [pelaje] [padre]`. Avisa si la madre no existe o ya tiene cría este año.
- **Mediciones**: CC, CE, altura, frame.
- **Notas**: `RP texto`. Las palabras clave (renga, mala madre, abortó…) se entienden solas.
- **Importar planilla**: un CSV de otro sistema, de la balanza o la planilla de RODEO llenada. Detecta separador y columnas por sinónimos.
- **Planilla para el campo**: la lista de animales con columnas vacías, en Excel o para imprimir.

Rutas: `POST /api/relevar/pesadas|sanidad|nacimientos|mediciones|notas` y
`POST /api/importar/csv`, todas con `simular: true` para ver sin escribir.

## El bot

Es Claude Opus 5 con razonamiento extendido (adaptive thinking, esfuerzo alto)
y la base en la mano. No tiene respuestas armadas ni un menú de acciones:
recibe la pregunta, piensa, consulta lo que necesita y contesta. Diez herramientas:

- `plantel` — los vientres con lo que calcula el sistema (estado, eficiencia, bloques). Es lo mismo que ve el tablero, así no lo contradice.
- `ficha` — todo de un animal, sea vaca, toro o ternero.
- `buscar` — por RP tolerante, caravana, madre, padre o notas.
- `consultar` — un SELECT para lo que lo anterior no cubre.
- `relevar` — pesadas, sanidad, nacimientos, mediciones y notas con validación.
- `destinar` — a dónde va cada animal (entiende "engorde", "gordas", "corral" → terminación).
- `escribir` — correcciones puntuales por SQL, después de verificar.
- `crear_tablero` — una página con tablas, publicada en `/t/:slug`.
- `exportar_archivo` — un Excel, CSV o imprimible. Devuelve el link.
- `recordar` — guarda lo que le enseñás del campo.

**Archivos.** Le podés mandar cualquier cosa, por el chat del tablero (clip,
arrastrar o pegar) o por WhatsApp: **fotos** (la libreta, la balanza, un
animal), **PDF** (informes, liquidaciones), **Excel, CSV y TSV** (planillas de
pesadas, nacimientos, sanidad), **Word y texto**. Fotos y PDF los ve el modelo
directamente; las planillas las lee, te dice qué contienen y las carga con la
misma validación que Relevar cuando confirmás (herramientas `leer_adjunto` e
`importar_adjunto`). Las fotos se achican en el navegador antes de subirse.
Audio no: la API no transcribe. Los adjuntos quedan guardados (`/api/adjuntos`).

**Memoria.** Lo que le contás ("al potrero 7 le decimos La Loma", "Hércules ya
no se usa") lo guarda y lo usa en todas las respuestas. Se ve y se edita en la
pestaña Archivos. Las conversaciones quedan guardadas por sesión del navegador
(al recargar sigue) y por número de WhatsApp (últimas 48 horas).

**En vivo.** El chat muestra qué está haciendo mientras piensa: "miro el
plantel", "abro la ficha de 23", y la respuesta va apareciendo. Por
`POST /api/chat/stream` (Server-Sent Events); `POST /api/chat` sigue
devolviendo todo junto.

**Caché.** El prompt tiene una parte estable (reglas, esquema, memoria) que se
cachea y una cola volátil (fecha, conteos, calendario). Las llamadas repetidas
salen mucho más baratas.

Sabe de ganadería sin que nadie le cargue parámetros: la gestación son 283
días, una vaca desteta un ternero por año, la eficiencia es el destete sobre
el peso de la madre. El calendario del campo lo deduce de los propios registros.

## Medir al bot

```bash
ANTHROPIC_API_KEY=sk-... npm run evaluar
MODELO=claude-sonnet-5 ESFUERZO=medium npm run evaluar   # para comparar
npm run evaluar -- vacias corral                          # sólo algunas
```

Corre las 20 preguntas de `datos/preguntas.js` contra la base de prueba (la
respuesta correcta se calcula, no se adivina) e imprime cuántas acertó, los
tokens y el costo aproximado. El informe queda en `datos/evaluaciones/`. Es
la forma de saber si un cambio de modelo, esfuerzo o prompt mejoró o empeoró.

## Probar con la base real antes de desplegar

1. En Railway, agregá la variable `RESPALDO_CLAVE` (una palabra cualquiera) y redesplegá lo que ya tenés, o hacelo junto con esta versión.
2. Bajá una copia de la base:
   ```bash
   curl -o ~/rodeo/data/principal.db "https://TU-APP.up.railway.app/api/respaldo?clave=LA_CLAVE"
   ```
3. Corré el sistema en tu compu con esa copia (`DB_DIR=./data node server.js`) y revisá el tablero, las pestañas y el bot con tus animales de verdad. Nada de lo que hagas acá toca Railway.
4. Cuando esté bien, subí los archivos al repo. Al arrancar, el servidor agrega solo las tablas y columnas nuevas a la base real, sin tocar los datos.

Si tenés más de un campo, cada uno es un archivo (`/data/<clave>.db`) y se baja con `&campo=<clave>`.

## WhatsApp

El bot atiende por WhatsApp a través de Twilio. Para probarlo alcanza con el
*sandbox* de Twilio (gratis, sin aprobación de Meta):

1. Cuenta en twilio.com → Messaging → Try it out → **Send a WhatsApp message**.
2. Desde tu teléfono, mandá al número del sandbox el código que te muestra (`join algo-algo`).
3. En la pestaña **Sandbox settings**, en "When a message comes in" poné
   `https://TU-APP.up.railway.app/webhook` (método POST) y guardá.
4. En Railway, variables: `TWILIO_SID` y `TWILIO_TOKEN` (del panel de Twilio),
   `WHATSAPP_PERMITIDOS` con tu número, `URL_PUBLICA` con la dirección de la app.

Y ya está: le escribís como al chat del tablero. Recuerda la conversación de
las últimas 48 horas por número, parte las respuestas largas, manda "Estoy
mirando la base…" si tarda, y si le mandás una **foto de la libreta** la lee,
te muestra qué entendió y carga cuando confirmás.

El sandbox pide volver a mandar `join …` cada 72 horas y sólo desde números
que se unieron. Para producción (número propio, sin códigos) se aprueba un
remitente de WhatsApp Business en Twilio; el webhook es el mismo.

## Para verificar que arrancó

`/api/salud` devuelve cuántos animales, vientres, pesadas y archivos ve en cada campo.
