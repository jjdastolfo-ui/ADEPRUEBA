# RODEO — repo de prueba

## Qué hay

- `server.js` — el servidor. El bot es Claude con acceso directo a la base.
- `plantel.js` — todo lo que se calcula de cada vaca. Una sola lista, sin particiones.
- `public/index.html` — el tablero.

## Variables en Railway

| Variable | Para qué |
|---|---|
| `ANTHROPIC_API_KEY` | la clave de la API |
| `DB_DIR` | dónde vive la base. En Railway: `/data`, con un volumen montado ahí |
| `CAMPOS` | JSON con los campos (ver abajo) |
| `TWILIO_SID` / `TWILIO_TOKEN` | sólo si se usa WhatsApp |

Ejemplo de `CAMPOS`:

```json
{"principal":{"nombre":"Angus del Este","empresa":"improlux"}}
```

## Cargar el backup

Subí el `.db` de Angus del Este al volumen, con el nombre de la clave del campo:
`/data/principal.db`.

## Para verificar que arrancó

`/api/salud` devuelve cuántos animales y cuántos vientres ve en cada campo.

## Endpoints

| Ruta | Qué devuelve |
|---|---|
| `GET /api/plantel` | todos los vientres con sus datos |
| `GET /api/ficha/:rp` | una vaca con su historial por campaña |
| `GET /api/animales` | todos los animales |
| `POST /api/chat` | el bot: `{ "mensaje": "..." }` |
| `POST /api/notas` | nota de campo: `{ "rp": "...", "texto": "..." }` |

## Cómo funciona el bot

No tiene respuestas armadas ni un menú de acciones. Recibe la pregunta, consulta
la base las veces que haga falta, y contesta. Si algo no le cierra, lo dice.

Sabe de ganadería sin que nadie le cargue parámetros: la gestación son 283 días,
una vaca desteta un ternero por año, la eficiencia es el destete sobre el peso de
la madre. El calendario del campo lo deduce de los propios registros.
