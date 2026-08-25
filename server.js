// ─────────────────────────────────────────────────────────────────────────────
// RODEO — servidor
//
// Dos cosas, nada más:
//
//   1. Un bot que es Claude con acceso real a la base. No responde con textos
//      armados: consulta, razona y contesta. Si algo no cuadra, lo dice.
//   2. Los datos para el tablero, con todo lo de cada animal.
//
// Lo que NO hace: calcular estados con reglas fijas y pasárselos masticados al
// bot. Eso fue lo que falló antes — cada regla nueva tapaba un caso y destapaba
// otro. Acá el bot ve los datos y saca sus conclusiones.
// ─────────────────────────────────────────────────────────────────────────────

const express = require("express");
const Database = require("better-sqlite3");
const Anthropic = require("@anthropic-ai/sdk");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const VERSION = "rodeo-1.0";
const PORT = process.env.PORT || 3001;
const DB_DIR = process.env.DB_DIR || "/data";
const MODELO = process.env.MODELO || "claude-sonnet-4-6";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const plantelMod = require("./plantel.js");
let destinosMod; try { destinosMod = require("./destinos.js"); } catch (e) { console.log("destinos.js no disponible:", e.message); }

// ── CAMPOS ───────────────────────────────────────────────────────────────────

const CAMPOS = JSON.parse(process.env.CAMPOS || `{
  "principal": { "nombre": "Angus del Este", "empresa": "improlux" }
}`);
const CAMPO_DEFAULT = Object.keys(CAMPOS)[0];
const bases = {};

function getDB(key) {
  const k = CAMPOS[key] ? key : CAMPO_DEFAULT;
  if (bases[k]) return bases[k];
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
  const db = new Database(path.join(DB_DIR, `${k}.db`));
  db.pragma("journal_mode = WAL");
  crearTablas(db);
  plantelMod.init(db);
  if (destinosMod) { try { destinosMod.init(db); } catch (e) {} }
  bases[k] = db;
  return db;
}
const dbDe = req => getDB(req.query.campo || (req.body && req.body.campo) || CAMPO_DEFAULT);

function crearTablas(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS animales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rp TEXT NOT NULL, chip TEXT, sexo TEXT, categoria TEXT,
      estado TEXT DEFAULT 'ACTIVO', fecha_nac TEXT, pelo TEXT, raza TEXT,
      madre_rp TEXT, padre_rp TEXT, hbu TEXT, registro TEXT, lote TEXT,
      notas TEXT, created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(rp));
    CREATE TABLE IF NOT EXISTS pesadas (
      id INTEGER PRIMARY KEY AUTOINCREMENT, animal_id INTEGER NOT NULL,
      fecha TEXT NOT NULL, peso REAL NOT NULL, contexto TEXT, gdp REAL,
      created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS servicios (
      id INTEGER PRIMARY KEY AUTOINCREMENT, animal_id INTEGER NOT NULL,
      temporada TEXT, tipo_servicio TEXT, semen_iatf TEXT, fecha_iatf TEXT,
      toro_natural TEXT, fecha_ingreso_toro TEXT, fecha_salida_toro TEXT,
      resultado TEXT, fecha_tacto TEXT, notas TEXT,
      created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS mediciones (
      id INTEGER PRIMARY KEY AUTOINCREMENT, animal_id INTEGER NOT NULL,
      fecha TEXT NOT NULL, tipo TEXT NOT NULL, valor REAL,
      created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS sanidad (
      id INTEGER PRIMARY KEY AUTOINCREMENT, animal_id INTEGER NOT NULL,
      fecha TEXT NOT NULL, producto TEXT, dosis TEXT, motivo TEXT,
      created_at TEXT DEFAULT (datetime('now')));
    CREATE INDEX IF NOT EXISTS idx_pes_an ON pesadas(animal_id);
    CREATE INDEX IF NOT EXISTS idx_ser_an ON servicios(animal_id);
    CREATE INDEX IF NOT EXISTS idx_med_an ON mediciones(animal_id);
    CREATE INDEX IF NOT EXISTS idx_ani_madre ON animales(madre_rp);

    -- Los tableros que arma el bot. Cada uno vive aparte: si uno sale roto,
    -- no afecta al tablero principal ni a los demás.
    CREATE TABLE IF NOT EXISTS tableros (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      titulo TEXT NOT NULL,
      pedido TEXT,
      html TEXT NOT NULL,
      creado_por TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')));
  `);
}

// ── EL BOT ───────────────────────────────────────────────────────────────────
//
// Claude con dos herramientas: consultar la base y escribir en ella. No hay
// intenciones precocinadas ni un menú de acciones: entiende lo que le piden y
// arma la consulta o el cambio que corresponda.

function esquema(db) {
  const tablas = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'
    AND name NOT LIKE 'sqlite_%'`).all().map(t => t.name);
  return tablas.map(t => {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all()
      .map(c => `${c.name} ${c.type}`).join(", ");
    const n = db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
    return `${t} (${cols}) — ${n} registros`;
  }).join("\n");
}

const HERRAMIENTAS = [
  {
    name: "consultar",
    description: "Ejecuta un SELECT sobre la base del campo y devuelve las filas. " +
      "Usalo para averiguar cualquier cosa antes de responder. Podés llamarlo varias veces " +
      "si necesitás cruzar datos o verificar algo que no te cierra.",
    input_schema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "Un SELECT. Sólo lectura." },
        porque: { type: "string", description: "Qué estás tratando de averiguar con esto." }
      },
      required: ["sql"]
    }
  },
  {
    name: "escribir",
    description: "Ejecuta un INSERT, UPDATE o DELETE. Usalo sólo cuando te piden cargar o " +
      "corregir algo, y después de haber verificado con `consultar` que tiene sentido. " +
      "Contá siempre qué escribiste.",
    input_schema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "INSERT, UPDATE o DELETE." },
        params: { type: "array", items: {}, description: "Valores para los ? del SQL." },
        que: { type: "string", description: "Qué estás cambiando, en una línea." }
      },
      required: ["sql", "que"]
    }
  },
  {
    name: "crear_tablero",
    description: "Arma una página web propia y la publica en una URL del sistema. Usalo cuando " +
      "te pidan un tablero, un informe visual, una tabla que se pueda mirar, o cualquier cosa " +
      "que se vea mejor en pantalla que en texto. Antes de armarlo consultá los datos que va " +
      "a mostrar, así el HTML sale con los números reales adentro.",
    input_schema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Nombre corto para la URL, sin espacios ni acentos. Ej: 'toros-2026'." },
        titulo: { type: "string", description: "Título que se ve arriba." },
        contenido: { type: "string", description:
          "Sólo el contenido: tablas, párrafos, tarjetas de números. NO pongas <html>, <head>, " +
          "<style> ni <body> — de eso se encarga el sistema, que ya tiene la estética armada. " +
          "Usá <table> para las tablas, <h2> para los títulos de sección, y para los números " +
          "de arriba <div class='kpis'><div class='kpi'><b>42</b><span>VIENTRES</span></div></div>. " +
          "Poné los datos ya calculados adentro, no scripts." },
        subtitulo: { type: "string", description: "Una línea que aclare qué muestra. Opcional." }
      },
      required: ["slug", "titulo", "contenido"]
    }
  }
];

function correrConsulta(db, sql) {
  const limpio = String(sql).trim().replace(/;+\s*$/, "");
  if (!/^select\b/i.test(limpio)) throw new Error("Sólo SELECT en consultar");
  if (/;/.test(limpio)) throw new Error("Una sola consulta por vez");
  const filas = db.prepare(limpio).all();
  // Un resultado enorme no aporta: se recorta y se avisa.
  if (filas.length > 300) return { filas: filas.slice(0, 300), total: filas.length, recortado: true };
  return { filas, total: filas.length };
}

function correrEscritura(db, sql, params) {
  const limpio = String(sql).trim().replace(/;+\s*$/, "");
  if (!/^(insert|update|delete)\b/i.test(limpio)) throw new Error("Sólo INSERT, UPDATE o DELETE en escribir");
  if (/;/.test(limpio)) throw new Error("Una sola sentencia por vez");
  if (/\bdrop\b|\balter\b|\btruncate\b/i.test(limpio)) throw new Error("No puedo hacer eso");
  const r = db.prepare(limpio).run(...(params || []));
  return { cambios: r.changes, id: r.lastInsertRowid };
}

function instrucciones(db, campoNombre) {
  const hoy = new Date().toISOString().slice(0, 10);
  const cal = plantelMod.calendario(db);
  return `Sos el asistente de ${campoNombre}, una cabaña de Angus. HOY ES ${hoy}.

Tenés acceso directo a la base del campo. Consultá lo que necesites antes de responder: no adivines
ni respondas de memoria. Si algo no te cierra, consultá otra vez desde otro ángulo.

ESTRUCTURA DE LA BASE:
${esquema(db)}

EL CALENDARIO DE ESTE CAMPO, sacado de sus propios registros:
Servicios: ${cal.servicios.map(s => `${s.temporada} (${s.desde} a ${s.hasta}, ${s.n} vientres)`).join(" · ") || "sin datos"}
Pariciones: ${cal.pariciones.map(p => `${p.anio} (${p.primero} a ${p.ultimo}, ${p.n} terneros)`).join(" · ") || "sin datos"}

LO QUE SABÉS DE GANADERÍA y no hace falta que nadie te cargue:
· La gestación de un bovino son 283 días.
· Una vaca desteta un ternero por año. El destete es a los 6-8 meses del parto.
· Un tacto "PREÑADA" dice que estaba preñada ESE DÍA. Va a parir unos nueve meses y medio
  después del SERVICIO, no del tacto.
· Cabeza, cuerpo y cola son tramos de la parición. Cuanto antes pare, más pesado llega el
  ternero al destete.
· Lo que mide de verdad a una vaca es cuánto desteta EN RELACIÓN A SU PROPIO PESO: una de
  430 kg que desteta 255 rinde 59%, mejor que una de 600 que desteta 250 (42%), porque come
  menos todo el año.
· De dónde vino una preñez se confirma con la fecha de nacimiento: ±10 días de la fecha
  probable de la IATF es IATF; después, tramos de 20 días son toro cabeza, cuerpo y cola.

EL ERROR QUE NO PODÉS COMETER: si una vaca figura preñada y no tiene cría registrada, NO
concluyas que abortó sin mirar CUÁNDO fue el servicio. Si fue hace menos de nueve meses, esa
vaca simplemente todavía no parió. Es la diferencia entre un problema sanitario y una parición
que está por empezar.

CÓMO TRABAJAR:
· Consultá primero, respondé después. Cruzá datos si hace falta.
· Decí lo que concluís y en qué te basás, con las fechas en la mano.
· Si los datos no alcanzan para responder, decilo. No inventes.
· Si encontrás algo que está mal cargado, avisalo aunque no te lo hayan preguntado. Lo típico:
  una madre que era más joven que su cría, una vaca con dos crías el mismo año, una fecha de
  nacimiento imposible (1970 suele ser un campo vacío), un peso que no cierra con su historia,
  o un RP que se repite entre animales distintos.
· Cuando te pidan cargar o corregir algo, verificá primero que exista y tenga sentido, después
  escribí, y contá qué hiciste.

ARMAR TABLEROS: si te piden un tablero, un informe visual o una tabla para mirar, usá crear_tablero.
Consultá los datos primero y ponelos ya calculados adentro.

NO escribas la página entera: mandá sólo el contenido. Los estilos y el encabezado los pone el
sistema. Usá <table> con <thead>/<tbody>, <h2> para separar secciones, class="n" en las celdas de
números, class="al" en rojo y class="bi" en verde. Para los números grandes de arriba:
<div class="kpis"><div class="kpi"><b>42</b><span>VIENTRES</span></div></div>

Después de crearlo, decile en qué URL quedó y qué muestra.

DESTINOS: todo animal que sale del plantel va a algún lado, y no todas las salidas son fracasos — el mejor toro de la camada también se va, como reproductor.

Los destinos posibles son:
· Para vientres: VENTA PREÑADA (se vende servida), TERMINACION (al corral, se vende gorda), VENTA DIRECTA.
· Para machos: TORO REPRODUCTOR (queda de padre), TORO TERMINACION (no calificó), NOVILLO TERMINACION (a carne).
· QUEDA: sigue en el plantel.

El motivo es aparte del destino: una vaca puede descartarse por edad y venderse preñada igual. Motivos: NO_DESTETO, VACIA, EDAD, PRODUCTIVIDAD, CARACTER, APLOMOS, UBRE, SANIDAD, SELECCION, COMERCIAL.

Si te piden marcar animales — "las vacías van a terminación", "el S402 queda de reproductor", "la 2077 se vende preñada" — usá la herramienta escribir sobre la tabla destinos, o consultá primero quiénes cumplen la condición y marcá a cada uno. Contá cuántos marcaste y cuáles.

Una vaca vacía no necesariamente va a terminación: si está gorda puede venderse directa. Preguntá si no está claro.

CUANDO TE CORRIGEN: si te dicen que un dato está mal — "la 23 no tiene ternero", "esa vaca no existe",
"el RP correcto es otro" — no es una pregunta: es una corrección. Verificá qué hay cargado, mostrale
lo que encontraste, y proponé el cambio concreto antes de hacerlo. Si hay dos animales con el mismo RP,
decilo claro y preguntá cuál es cuál.

NO TE QUEDES INVESTIGANDO: consultá lo necesario y respondé. Si después de unas consultas no llegás a
una conclusión, contá qué encontraste y qué te falta. Es mejor una respuesta parcial que ninguna.

CÓMO HABLAR: como un asesor que conoce el campo. Frases cortas, sin listas de más, sin repetir
la pregunta. Números concretos. Si algo es una estimación, decilo.`;
}

async function conversar(db, campoNombre, mensajes, opciones = {}) {
  const pasos = [];
  let historia = [...mensajes];

  const MAX = 14;
  for (let vuelta = 0; vuelta < MAX; vuelta++) {
    // En la última vuelta se le sacan las herramientas: así se ve obligado a
    // responder con lo que ya averiguó en vez de seguir consultando.
    const ultima = vuelta === MAX - 1;
    const r = await anthropic.messages.create({
      model: MODELO,
      max_tokens: 8000,
      system: instrucciones(db, campoNombre) + (ultima
        ? "\n\nSE TE ACABÓ EL TIEMPO DE CONSULTAR. Respondé ahora con lo que averiguaste. Si te falta algo, decí qué encontraste y qué te falta."
        : ""),
      ...(ultima ? {} : { tools: HERRAMIENTAS }),
      messages: historia
    });

    const usos = (r.content || []).filter(c => c.type === "tool_use");
    if (!usos.length) {
      const texto = (r.content || []).filter(c => c.type === "text").map(c => c.text).join("\n");
      return { respuesta: texto.trim(), pasos };
    }

    historia.push({ role: "assistant", content: r.content });
    const resultados = [];
    for (const u of usos) {
      let out;
      try {
        if (u.name === "consultar") {
          out = correrConsulta(db, u.input.sql);
          pasos.push({ tipo: "consulta", sql: u.input.sql, porque: u.input.porque, filas: out.total });
        } else if (u.name === "crear_tablero") {
          if (opciones.soloLectura) throw new Error("Esta sesión es de sólo lectura");
          out = guardarTablero(db, u.input, opciones.campoKey);
          pasos.push({ tipo: "tablero", slug: out.slug, url: out.url });
        } else if (u.name === "escribir") {
          if (opciones.soloLectura) throw new Error("Esta sesión es de sólo lectura");
          out = correrEscritura(db, u.input.sql, u.input.params);
          pasos.push({ tipo: "escritura", que: u.input.que, cambios: out.cambios });
        } else out = { error: "herramienta desconocida" };
      } catch (e) {
        out = { error: e.message };
        pasos.push({ tipo: "error", detalle: e.message });
      }
      resultados.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify(out) });
    }
    historia.push({ role: "user", content: resultados });
  }
  // No debería llegar acá, pero si pasa se cuenta qué se averiguó en vez de
  // dejar al usuario sin nada.
  const consultas = pasos.filter(p => p.tipo === "consulta");
  return {
    respuesta: `Revisé la base ${consultas.length} veces pero no llegué a una conclusión. ` +
      `Estuve mirando: ${consultas.slice(0, 4).map(c => c.porque || "datos").join("; ")}. ` +
      `Probá siendo más específico — por ejemplo, nombrando el RP o la temporada.`,
    pasos };
}

// ── TABLEROS QUE ARMA EL BOT ─────────────────────────────────────────────────

// La estética del sistema, para que todos los tableros salgan parejos sin que
// el bot tenga que escribirla cada vez (y sin gastar tokens en eso).
function plantilla(titulo, subtitulo, contenido) {
  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${titulo}</title>
<link href="https://fonts.googleapis.com/css2?family=Oswald:wght@300;400;500;600&family=JetBrains+Mono:wght@400&display=swap" rel="stylesheet">
<style>
:root{--azul:#0B3D7C;--azul2:#072957;--oro:#C9A24B;--tinta:#10243f;--papel:#F7F3EC;--linea:#E2D9CB;--gris:#8A827A;--verde:#1a7a4a;--rojo:#B83232}
*{box-sizing:border-box}
body{margin:0;background:var(--papel);color:var(--tinta);font-family:Oswald,system-ui,sans-serif;font-weight:300;font-size:14px}
header{background:var(--azul2);color:#fff;padding:18px 24px;border-bottom:4px solid var(--oro)}
header h1{margin:0;font-size:22px;font-weight:600;letter-spacing:2.5px;text-transform:uppercase}
header p{margin:4px 0 0;font-size:11px;color:var(--oro);letter-spacing:2px;text-transform:uppercase}
main{padding:20px 24px 50px;max-width:1400px}
h2{font-size:13px;letter-spacing:2px;text-transform:uppercase;color:var(--azul);font-weight:500;
   margin:26px 0 10px;border-bottom:2px solid var(--linea);padding-bottom:6px}
h2:first-child{margin-top:0}
.kpis{display:flex;gap:1px;background:var(--linea);border:1px solid var(--linea);flex-wrap:wrap;margin-bottom:20px}
.kpi{background:#fff;padding:12px 18px;flex:1;min-width:112px}
.kpi b{display:block;font-size:25px;font-weight:500;color:var(--azul);line-height:1.1}
.kpi span{font-size:9.5px;letter-spacing:1.1px;text-transform:uppercase;color:var(--gris)}
.kpi.al b{color:var(--rojo)}.kpi.bien b{color:var(--verde)}.kpi.oro b{color:#B8860B}
table{width:100%;border-collapse:collapse;background:#fff;font-size:13px;margin-bottom:18px}
th{background:var(--azul2);color:#fff;text-align:left;font-size:9.5px;letter-spacing:1.2px;
   text-transform:uppercase;font-weight:400;padding:10px 8px;white-space:nowrap}
td{padding:8px;border-bottom:1px solid var(--linea)}
tr:hover td{background:#FAF7F0}
th.n,td.n,.n{text-align:right;font-variant-numeric:tabular-nums}
.mut{color:var(--gris)}.al{color:var(--rojo);font-weight:500}.bi{color:var(--verde);font-weight:500}
.tag{font-size:9px;letter-spacing:1.1px;text-transform:uppercase;padding:2px 8px;border-radius:2px;
  background:rgba(11,61,124,.1);color:var(--azul)}
p{line-height:1.6;color:var(--gris);max-width:80ch}
a{color:var(--azul)}
footer{padding:16px 24px;font-size:11px;color:var(--gris);border-top:1px solid var(--linea)}
</style></head><body>
<header><h1>${titulo}</h1>${subtitulo ? `<p>${subtitulo}</p>` : ""}</header>
<main>${contenido}</main>
<footer>Generado por RODEO · <a href="/">volver al tablero</a></footer>
</body></html>`;
}

function guardarTablero(db, t, campoKey) {
  const slug = String(t.slug || "").toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!slug) throw new Error("El nombre para la url no sirve");

  const cuerpo = String(t.contenido || t.html || "").trim();
  if (!cuerpo) throw new Error("Falta el contenido del tablero");

  // Si mandó una página entera igual se acepta; si no, se envuelve.
  let html = /<html/i.test(cuerpo) ? cuerpo
    : plantilla(t.titulo || slug, t.subtitulo, cuerpo);
  if (campoKey) html = html.replace(/CAMPO_AQUI|__CAMPO__/g, campoKey);

  db.prepare(`INSERT INTO tableros (slug,titulo,pedido,html,creado_por) VALUES (?,?,?,?,?)
    ON CONFLICT(slug) DO UPDATE SET titulo=excluded.titulo, html=excluded.html,
      pedido=excluded.pedido, updated_at=datetime('now')`)
    .run(slug, t.titulo || slug, t.pedido || null, html, t.creado_por || null);

  return { ok: true, slug, url: `/t/${slug}`,
    mensaje: `Quedó en /t/${slug}` };
}

// Un tablero armado por el bot.
app.get("/t/:slug", (req, res) => {
  const db = getDB(req.query.campo || CAMPO_DEFAULT);
  try {
    const t = db.prepare("SELECT html FROM tableros WHERE slug=?").get(req.params.slug);
    if (!t) return res.status(404).type("html").send(
      `<body style="font-family:system-ui;padding:60px;text-align:center;color:#666">
       <h2>No existe ese tablero</h2><p><a href="/">Volver</a></p></body>`);
    res.type("html").send(t.html);
  } catch (e) { res.status(500).send(e.message); }
});

app.get("/api/tableros", (req, res) => {
  const db = getDB(req.query.campo || CAMPO_DEFAULT);
  try {
    res.json(db.prepare(`SELECT slug,titulo,pedido,created_at,updated_at
      FROM tableros ORDER BY updated_at DESC`).all()
      .map(t => ({ ...t, url: `/t/${t.slug}` })));
  } catch (e) { res.json([]); }
});

app.delete("/api/tableros/:slug", (req, res) => {
  const db = getDB(req.query.campo || CAMPO_DEFAULT);
  try {
    const r = db.prepare("DELETE FROM tableros WHERE slug=?").run(req.params.slug);
    res.json({ ok: !!r.changes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API ──────────────────────────────────────────────────────────────────────

app.get("/api/campos", (req, res) => {
  res.json(Object.entries(CAMPOS).map(([key, c]) => {
    let n = 0;
    try { n = getDB(key).prepare("SELECT COUNT(*) n FROM animales WHERE upper(COALESCE(estado,'ACTIVO'))='ACTIVO'").get().n; }
    catch (e) {}
    return { key, nombre: c.nombre, empresa: c.empresa, animales: n };
  }));
});

// Todo el plantel con los datos de cada vaca.
app.get("/api/plantel", (req, res) => {
  try { res.json(plantelMod.plantel(dbDe(req), { anio: req.query.anio })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/ficha/:rp", (req, res) => {
  try {
    const f = plantelMod.ficha(dbDe(req), req.params.rp);
    res.status(f.ok ? 200 : 404).json(f);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Todos los animales, para las otras vistas del tablero.
app.get("/api/animales", (req, res) => {
  const db = dbDe(req);
  try {
    res.json(db.prepare(`
      SELECT a.*,
        (SELECT peso FROM pesadas p WHERE p.animal_id=a.id AND upper(COALESCE(p.contexto,''))='NACIMIENTO'
         ORDER BY p.fecha LIMIT 1) peso_nac,
        (SELECT peso FROM pesadas p WHERE p.animal_id=a.id AND upper(COALESCE(p.contexto,''))='DESTETE'
         ORDER BY p.fecha DESC LIMIT 1) destete,
        (SELECT peso FROM pesadas p WHERE p.animal_id=a.id ORDER BY p.fecha DESC LIMIT 1) peso_actual,
        (SELECT fecha FROM pesadas p WHERE p.animal_id=a.id ORDER BY p.fecha DESC LIMIT 1) ultima_pesada,
        (SELECT COUNT(*) FROM animales h WHERE upper(COALESCE(h.madre_rp,''))=upper(a.rp)) crias
      FROM animales a
      WHERE upper(COALESCE(a.estado,'ACTIVO')) = ?
      ORDER BY a.rp`).all(String(req.query.estado || "ACTIVO").toUpperCase()));
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// Los lotes con sus animales. La terminación se define por lote, no por
// categoría: un toro en el corral está terminando, el mismo en el potrero no.
app.get("/api/lotes", (req, res) => {
  const db = dbDe(req);
  try {
    const lotes = db.prepare(`
      SELECT l.id, l.nombre, l.potrero, l.descripcion,
             COUNT(la.animal_id) animales
      FROM lotes l LEFT JOIN lote_animales la ON la.lote_id = l.id
      GROUP BY l.id ORDER BY animales DESC`).all();
    res.json(lotes);
  } catch (e) { res.json([]); }
});

app.get("/api/lote/:id/animales", (req, res) => {
  const db = dbDe(req);
  try {
    res.json(db.prepare(`
      SELECT a.*, la.fecha_ingreso,
        (SELECT peso FROM pesadas p WHERE p.animal_id=a.id ORDER BY p.fecha DESC LIMIT 1) peso_actual,
        (SELECT fecha FROM pesadas p WHERE p.animal_id=a.id ORDER BY p.fecha DESC LIMIT 1) ultima_pesada,
        (SELECT peso FROM pesadas p WHERE p.animal_id=a.id AND upper(COALESCE(p.contexto,''))='DESTETE'
         ORDER BY p.fecha DESC LIMIT 1) destete
      FROM lote_animales la JOIN animales a ON a.id = la.animal_id
      WHERE la.lote_id = ? ORDER BY a.rp`).all(req.params.id));
  } catch (e) { res.json([]); }
});

// Todo lo que está en corral, con cuánto viene ganando cada uno.
app.get("/api/terminacion", (req, res) => {
  const db = dbDe(req);
  const hoy = new Date().toISOString().slice(0, 10);
  try {
    const filas = db.prepare(`
      SELECT a.id, a.rp, a.sexo, a.categoria, a.fecha_nac, a.pelo, a.padre_rp,
             l.nombre lote, l.potrero, la.fecha_ingreso
      FROM lote_animales la
      JOIN lotes l ON l.id = la.lote_id
      JOIN animales a ON a.id = la.animal_id
      WHERE upper(l.nombre) LIKE '%TERMINACION%' OR upper(l.nombre) LIKE '%CORRAL%'
         OR upper(COALESCE(l.potrero,'')) LIKE '%CORRAL%'
      ORDER BY a.rp`).all();

    const dias = (a, b) => (a && b) ? Math.round((new Date(b) - new Date(a)) / 86400000) : null;
    const out = filas.map(f => {
      const pes = db.prepare(`SELECT fecha,peso FROM pesadas WHERE animal_id=? ORDER BY fecha`).all(f.id);
      const ult = pes[pes.length - 1] || null;
      // Peso al entrar al corral: la pesada más cercana al ingreso.
      const entrada = f.fecha_ingreso
        ? pes.filter(p => p.fecha <= f.fecha_ingreso).pop() || pes[0] : pes[0];
      const d = (entrada && ult && entrada.fecha !== ult.fecha) ? dias(entrada.fecha, ult.fecha) : null;
      const gdp = (d && d > 0) ? Math.round(((ult.peso - entrada.peso) / d) * 1000) / 1000 : null;
      return {
        rp: f.rp, sexo: f.sexo, categoria: f.categoria, pelo: f.pelo, padre_rp: f.padre_rp,
        lote: f.lote, potrero: f.potrero, fecha_ingreso: f.fecha_ingreso,
        meses: f.fecha_nac ? Math.round(dias(f.fecha_nac, hoy) / 30.44) : null,
        peso_entrada: entrada ? entrada.peso : null,
        peso_actual: ult ? ult.peso : null,
        ultima_pesada: ult ? ult.fecha : null,
        dias_corral: f.fecha_ingreso ? dias(f.fecha_ingreso, hoy) : null,
        ganancia: (entrada && ult) ? Math.round((ult.peso - entrada.peso) * 10) / 10 : null,
        gdp, destete: f.destete,
        dias_sin_pesar: ult ? dias(ult.fecha, hoy) : null
      };
    });

    const num = a => a.filter(x => x != null && isFinite(x));
    const prom = a => a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10 : null;
    const gdps = num(out.map(f => f.gdp));
    res.json({
      filas: out,
      resumen: {
        total: out.length,
        lotes: [...new Set(out.map(f => f.lote))],
        peso_prom: prom(num(out.map(f => f.peso_actual))),
        gdp_prom: gdps.length ? Math.round(prom(gdps) * 1000) / 1000 : null,
        ganancia_prom: prom(num(out.map(f => f.ganancia))),
        dias_prom: prom(num(out.map(f => f.dias_corral))),
        kg_totales: Math.round(num(out.map(f => f.peso_actual)).reduce((a, b) => a + b, 0)),
        sin_pesar: out.filter(f => f.dias_sin_pesar > 30).length
      }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ── DESTINOS ─────────────────────────────────────────────────────────────────
// A dónde va cada animal cuando sale del plantel. No todas las salidas son
// fracasos: el mejor toro también se va, como reproductor.
app.get("/api/destinos", (req, res) => {
  if (!destinosMod) return res.status(503).json({ error: "Módulo no disponible" });
  const db = dbDe(req);
  try {
    const pl = plantelMod.plantel(db);
    res.json(destinosMod.listar(db, pl.filas, { temporada: req.query.temporada }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/destinos", (req, res) => {
  if (!destinosMod) return res.status(503).json({ error: "Módulo no disponible" });
  const { rp, rps, destino } = req.body;
  if (!destino) return res.status(400).json({ error: "Falta el destino" });
  const db = dbDe(req);
  try {
    const r = Array.isArray(rps) && rps.length
      ? destinosMod.marcarVarios(db, rps, destino, req.body)
      : destinosMod.marcar(db, rp, destino, req.body);
    res.status(r.ok ? 200 : 400).json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/destinos/:rp", (req, res) => {
  if (!destinosMod) return res.status(503).json({ error: "Módulo no disponible" });
  try { res.json(destinosMod.sacar(dbDe(req), req.params.rp, req.query.temporada)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Cuando el animal efectivamente sale del campo.
app.post("/api/destinos/:rp/salida", (req, res) => {
  if (!destinosMod) return res.status(503).json({ error: "Módulo no disponible" });
  try { res.json(destinosMod.concretar(dbDe(req), req.params.rp, req.body)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/notas", (req, res) => {
  const { rp, texto } = req.body;
  if (!rp || !texto) return res.status(400).json({ error: "Falta el RP o el texto" });
  const db = dbDe(req);
  const a = db.prepare("SELECT rp FROM animales WHERE upper(rp)=upper(?)").get(String(rp).trim());
  if (!a) return res.status(404).json({ error: `No encuentro ${rp}` });
  try { res.json(plantelMod.guardarNota(db, a.rp, texto, req.body)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/notas", (req, res) => {
  const db = dbDe(req);
  try {
    res.json(req.query.rp
      ? db.prepare("SELECT * FROM notas_campo WHERE upper(animal_rp)=upper(?) ORDER BY fecha DESC").all(req.query.rp)
      : db.prepare("SELECT * FROM notas_campo ORDER BY fecha DESC LIMIT 200").all());
  } catch (e) { res.json([]); }
});

// El chat. Es Claude con la base en la mano.
app.post("/api/chat", async (req, res) => {
  const { mensaje, historia } = req.body;
  if (!mensaje) return res.status(400).json({ error: "Falta el mensaje" });
  const campoKey = req.query.campo || req.body.campo || CAMPO_DEFAULT;
  const db = getDB(campoKey);
  const nombre = (CAMPOS[campoKey] || {}).nombre || "el campo";
  try {
    const msgs = [...(Array.isArray(historia) ? historia : []), { role: "user", content: mensaje }];
    const r = await conversar(db, nombre, msgs, {
      soloLectura: req.body.solo_lectura, campoKey });
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message, respuesta: `No pude procesarlo: ${e.message}` });
  }
});

// WhatsApp: responde vacío y manda la respuesta después, para no cortar por tiempo.
app.post("/webhook", async (req, res) => {
  res.type("text/xml").send("<Response></Response>");
  const de = req.body.From || "";
  const texto = req.body.Body || "";
  if (!texto.trim()) return;
  const db = getDB(CAMPO_DEFAULT);
  try {
    const r = await conversar(db, CAMPOS[CAMPO_DEFAULT].nombre, [{ role: "user", content: texto }]);
    if (process.env.TWILIO_SID) {
      const twilio = require("twilio")(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);
      await twilio.messages.create({ from: req.body.To, to: de, body: r.respuesta.slice(0, 1500) });
    }
  } catch (e) { console.error("webhook:", e.message); }
});


// ── TRAER LA BASE DESDE OTRO SERVIDOR ────────────────────────────────────────
// Railway no comparte volúmenes entre servicios. En vez de bajar el archivo a
// mano y volver a subirlo, este servidor se lo pide al viejo y lo guarda.
// Es para la puesta en marcha: una vez copiada la base, no se usa más.
app.post("/api/importar-base", async (req, res) => {
  const { url, campo, clave } = req.body;
  if (!url) return res.status(400).json({ error: "Falta la url del servidor viejo" });
  const destino = path.join(DB_DIR, `${campo || CAMPO_DEFAULT}.db`);

  try {
    if (fs.existsSync(destino) && !req.body.pisar) {
      const kb = Math.round(fs.statSync(destino).size / 1024);
      return res.status(409).json({
        error: `Ya hay una base en ${destino} de ${kb} KB. Mandá "pisar": true si querés reemplazarla.` });
    }
    const r = await fetch(url + (url.includes("?") ? "&" : "?") + `clave=${encodeURIComponent(clave || "")}`);
    if (!r.ok) return res.status(502).json({ error: `El servidor viejo respondió ${r.status}` });

    const buf = Buffer.from(await r.arrayBuffer());
    // Un SQLite empieza siempre con esta firma: si no está, bajó otra cosa.
    if (buf.slice(0, 15).toString() !== "SQLite format 3")
      return res.status(400).json({ error: "Lo que llegó no es una base SQLite. Revisá la url y la clave." });

    if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
    fs.writeFileSync(destino, buf);
    // Se cierra la conexión vieja para que la próxima abra el archivo nuevo.
    const k = campo || CAMPO_DEFAULT;
    if (bases[k]) { try { bases[k].close(); } catch (e) {} delete bases[k]; }

    const db = getDB(k);
    const animales = db.prepare("SELECT COUNT(*) n FROM animales").get().n;
    const vientres = plantelMod.plantel(db).filas.length;
    res.json({ ok: true, archivo: destino, kb: Math.round(buf.length / 1024), animales, vientres,
      mensaje: `Listo: ${animales} animales, ${vientres} vientres.` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Qué hay en el volumen.
app.get("/api/volumen", (req, res) => {
  try {
    if (!fs.existsSync(DB_DIR)) return res.json({ dir: DB_DIR, existe: false, archivos: [] });
    res.json({ dir: DB_DIR, existe: true, archivos: fs.readdirSync(DB_DIR).map(f => {
      const st = fs.statSync(path.join(DB_DIR, f));
      return { archivo: f, kb: Math.round(st.size / 1024), modificado: st.mtime };
    })});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/salud", (req, res) => {
  const out = { version: VERSION, campos: {} };
  for (const k of Object.keys(CAMPOS)) {
    try {
      const db = getDB(k);
      out.campos[k] = {
        nombre: CAMPOS[k].nombre,
        animales: db.prepare("SELECT COUNT(*) n FROM animales").get().n,
        vientres: plantelMod.plantel(db).filas.length
      };
    } catch (e) { out.campos[k] = { error: e.message }; }
  }
  res.json(out);
});

app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => {
  const html = path.join(__dirname, "public", "index.html");
  if (fs.existsSync(html)) return res.sendFile(html);
  // Sin el tablero el sistema igual funciona: se avisa qué falta.
  res.type("html").send(`<!DOCTYPE html><html lang="es"><meta charset="utf-8">
    <title>RODEO</title>
    <body style="font-family:system-ui;max-width:640px;margin:60px auto;padding:0 20px;line-height:1.6;color:#10243f">
    <h1 style="letter-spacing:2px">RODEO ${VERSION}</h1>
    <p>El servidor está andando, pero falta el tablero.</p>
    <p>Subí el archivo <b>index.html</b> dentro de una carpeta <b>public</b> en el repo.
       En GitHub, al subirlo escribí el nombre como <code>public/index.html</code> — la barra
       crea la carpeta sola.</p>
    <p>Mientras tanto, el sistema responde por acá:</p>
    <ul>
      <li><a href="/api/salud">/api/salud</a> — qué ve el sistema</li>
      <li><a href="/api/plantel">/api/plantel</a> — los vientres</li>
      <li><a href="/api/animales">/api/animales</a> — todos los animales</li>
    </ul></body></html>`);
});

app.listen(PORT, () => {
  console.log(`${VERSION} en el puerto ${PORT}`);
  for (const k of Object.keys(CAMPOS)) {
    try {
      const db = getDB(k);
      const n = db.prepare("SELECT COUNT(*) n FROM animales").get().n;
      console.log(`  ${CAMPOS[k].nombre} (${k}): ${n} animales`);
    } catch (e) { console.log(`  ${k}: ${e.message}`); }
  }
});
