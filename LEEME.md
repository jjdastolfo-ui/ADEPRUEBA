# RODEO

Sistema ganadero de cabaña: un bot que es Claude con acceso directo a la base,
un tablero con todo lo de cada animal, y las herramientas para meter y sacar
datos sin fricción.

## Qué hay

| Archivo | Qué hace |
|---|---|
| `server.js` | el servidor: rutas, el bot y sus herramientas |
| `plantel.js` | todo lo que se calcula de cada vientre: estado, eficiencia, bloques, ficha reproductiva |
| `animales.js` | búsqueda de cualquier animal (tolera "011" por "11", "b 332" por "B332"), ficha general, terminación |
| `exportar.js` | emisión de archivos: Excel, CSV, página imprimible, JSON; archivos que arma el bot |
| `relevar.js` | carga de campo con validación: pesadas, sanidad, nacimientos, mediciones, notas; importar CSV; planilla para el campo |
| `xlsx.js` | escribe Excel sin dependencias: encabezado pintado, filtro, panel congelado, números y fechas reales |
| `destinos.js` | a dónde va cada animal cuando sale del plantel |
| `public/index.html` | el tablero |
| `datos/semilla.js` | arma una base de prueba para correr en la compu (`node datos/semilla.js`) |

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
| `MODELO` | opcional, el modelo de Claude |
| `TWILIO_SID` / `TWILIO_TOKEN` | sólo si se usa WhatsApp |

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

No tiene respuestas armadas ni un menú de acciones. Recibe la pregunta,
consulta la base las veces que haga falta, y contesta. Tiene cinco herramientas:

- `consultar` — un SELECT.
- `escribir` — INSERT, UPDATE o DELETE, después de verificar.
- `crear_tablero` — una página con tablas, publicada en `/t/:slug`.
- `exportar_archivo` — un Excel, CSV o imprimible a partir de un conjunto o de un SELECT. Devuelve el link.
- `relevar` — cargar pesadas, sanidad, nacimientos, mediciones o notas con la misma validación que la pestaña Relevar.

Sabe de ganadería sin que nadie le cargue parámetros: la gestación son 283
días, una vaca desteta un ternero por año, la eficiencia es el destete sobre
el peso de la madre. El calendario del campo lo deduce de los propios registros.

## Para verificar que arrancó

`/api/salud` devuelve cuántos animales, vientres, pesadas y archivos ve en cada campo.
