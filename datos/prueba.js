// ─────────────────────────────────────────────────────────────────────────────
// PRUEBA — corre los módulos contra una base de prueba y avisa si algo se rompe.
//
//   npm run prueba
//
// Arma la base de semilla en una carpeta temporal (no toca ./data ni /data),
// y ejercita búsqueda, fichas, exportación, relevamiento, importación de CSV,
// destinos, y el bot con un Claude simulado (así se prueba el circuito de
// herramientas, la memoria, el streaming y el caché sin gastar un token).
// Para probar al bot de verdad: npm run evaluar.
// ─────────────────────────────────────────────────────────────────────────────
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rodeo-prueba-"));
process.env.DB_DIR = dir;
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "sin-clave";
execFileSync(process.execPath, [path.join(__dirname, "semilla.js")], { env: { ...process.env, DB_DIR: dir }, stdio: "ignore" });

const S = require("../server.js");
const db = S.getDB("principal");
const plantelMod = require("../plantel.js"), animalesMod = require("../animales.js"), destinosMod = require("../destinos.js");
const exportarMod = require("../exportar.js"), relevarMod = require("../relevar.js"), xlsx = require("../xlsx.js"), botMod = require("../bot.js");
const mods = { plantelMod, animalesMod, destinosMod };

let fallas = 0, n = 0;
function ok(cond, que) { n++; if (!cond) { fallas++; console.log("  FALLÓ:", que); } }
function seccion(t) { console.log("\n" + t); }

seccion("Buscar");
const b1 = animalesMod.buscar(db, "011");
ok(b1.length && b1[0].rp === "11", "'011' encuentra a la 11 primero");
ok(animalesMod.buscar(db, "b 332")[0].rp === "B332", "'b 332' encuentra al toro B332");
ok(animalesMod.buscar(db, "hércules").length > 5 && animalesMod.buscar(db, "hércules").slice(1).every(a => a.coincide === "padre"), "'hércules' encuentra al toro y después a sus hijos por padre");
ok(animalesMod.buscar(db, "renga").length === 1, "busca en las notas de campo");
ok(animalesMod.porRp(db, " 011 ").rp === "11", "porRp tolera ceros y espacios");

seccion("Fichas");
const f1 = animalesMod.ficha(db, "11");
ok(f1.ok && f1.es_vientre && f1.pesadas.length >= 2, "ficha general de una vaca");
const ternero = animalesMod.listar(db).find(a => a.categoria === "TERNERO");
const f2 = animalesMod.ficha(db, ternero.rp);
ok(f2.ok && !f2.es_vientre && f2.madre_existe && f2.peso_nac > 0, "ficha general de un ternero, con madre");
const f3 = plantelMod.ficha(db, "11");
ok(f3.ok && f3.campanas.length >= 3, "ficha reproductiva de la 11");
ok(!animalesMod.ficha(db, "NOEXISTE").ok, "ficha de un RP inexistente falla con mensaje");

seccion("Exportar");
for (const k of Object.keys(exportarMod.COLUMNAS)) {
  const c = exportarMod.conjunto(db, mods, k);
  ok(Array.isArray(c.filas) && c.columnas.length > 3, `conjunto ${k}`);
}
const ex = exportarMod.armar(db, mods, "plantel", "xlsx", { campoNombre: "Prueba" });
ok(ex.buffer.length > 5000 && ex.buffer.slice(0, 2).toString() === "PK", "plantel.xlsx es un zip");
const todo = exportarMod.armar(db, mods, "rodeo", "xlsx", { campoNombre: "Prueba" });
ok(todo.buffer.length > 50000, "rodeo.xlsx completo");
const csv = exportarMod.armar(db, mods, "plantel", "csv", { rps: ["11", "013"], columnas: ["rp", "pn_prom"] }).buffer.toString();
ok(csv.split("\r\n").length === 3 && csv.includes(";") && /\d,\d/.test(csv), "csv con ; y coma decimal, sólo los RP pedidos");
const html = exportarMod.armar(db, mods, "nacimientos", "html", {}).buffer.toString();
ok(html.includes("<table") && html.includes("window.print"), "html imprimible");
const tablas = exportarMod.tablasDeHtml("<h2>Vacías</h2><table><tr><th>RP</th><th>Peso</th></tr><tr><td>11</td><td>1.234,5</td></tr></table>");
ok(tablas.length === 1 && tablas[0].nombre === "Vacías" && tablas[0].filas[0].c1 === 1234.5, "lee tablas de un tablero del bot");
const arch = exportarMod.desdeConsulta(db, { sql: "SELECT rp AS \"RP\" FROM animales WHERE categoria='TORO'", titulo: "Toros" });
ok(arch.url.startsWith("/archivos/") && arch.filas === 6, "archivo desde un SELECT");
let error = null; try { exportarMod.desdeConsulta(db, { sql: "DELETE FROM animales", titulo: "x" }); } catch (e) { error = e.message; }
ok(error === "Sólo SELECT", "no deja exportar con algo que no sea SELECT");

seccion("Excel");
const buf = xlsx.armar([{ nombre: "H", columnas: [{ k: "a", t: "A" }, { k: "f", t: "F" }], filas: [{ a: 1.5, f: "2026-01-02" }, { a: null, f: null }] }]);
ok(buf.slice(0, 2).toString() === "PK", "xlsx es un zip");
const zlib = require("zlib");
const largoNombre = buf.readUInt16LE(26), largoComp = buf.readUInt32LE(18);
const xml = zlib.inflateRawSync(buf.slice(30 + largoNombre, 30 + largoNombre + largoComp)).toString();
ok(xml.startsWith("<?xml"), "el contenido del zip es XML");

seccion("Relevar");
const antes = db.prepare("SELECT COUNT(*) n FROM pesadas").get().n;
const sim = relevarMod.pesadas(db, { filas: relevarMod.parsearLineas("011 432\n13 470\nZZZ 300\n11 432"), fecha: "03/09/2026", simular: true });
ok(sim.simulado && sim.bien === 3 && sim.mal === 1, "simular pesadas: 3 bien, 1 mal");
ok(sim.filas[0].rp === "11" && sim.filas[0].anterior > 0, "'011' se resuelve a 11 y trae la pesada anterior");
ok(sim.filas[3].avisos.some(a => /repetido/.test(a)), "avisa la fila repetida");
ok(db.prepare("SELECT COUNT(*) n FROM pesadas").get().n === antes, "simular no escribe");
const real = relevarMod.pesadas(db, { filas: [{ rp: "11", peso: "432" }], fecha: "2026-09-03", contexto: "CONTROL" });
ok(real.bien === 1 && db.prepare("SELECT COUNT(*) n FROM pesadas").get().n === antes + 1, "cargar escribe una pesada");
const dup = relevarMod.pesadas(db, { filas: [{ rp: "11", peso: "432" }], fecha: "2026-09-03" });
ok(dup.mal === 1 && /Ya estaba/.test(dup.filas[0].error), "no repite una pesada igual");
const san = relevarMod.sanidad(db, { lote_id: 1, producto: "IVERMECTINA", dosis: "5 ml", simular: true });
ok(san.bien === 18, "sanidad a un lote entero");
// Una madre que ya tiene cría este año, para que avise.
const madreConCria = db.prepare("SELECT madre_rp FROM animales WHERE fecha_nac LIKE '2026%' AND madre_rp IS NOT NULL AND madre_rp NOT LIKE '%0%' LIMIT 1").get().madre_rp;
const nac = relevarMod.nacimientos(db, { filas: [{ rp: "C900", madre_rp: "0" + madreConCria, fecha_nac: "01/09/2026", sexo: "h", pelo: "colorada", peso_nac: "31,5" }] });
ok(nac.bien === 1 && animalesMod.porRp(db, "C900").categoria === "TERNERA", "nacimiento crea la ternera");
ok(nac.filas[0].avisos.some(a => /ya tiene cría/.test(a)), "avisa que la madre ya tiene cría este año");
const nac2 = relevarMod.nacimientos(db, { filas: [{ rp: "C900", madre_rp: madreConCria, fecha_nac: "2026-09-01", sexo: "M" }], simular: true });
ok(nac2.mal === 1, "no deja repetir el RP");
const med = relevarMod.mediciones(db, { filas: [{ rp: "13", valor: "3,5" }], tipo: "CC", simular: true });
ok(med.bien === 1 && med.filas[0].valor === 3.5, "medición con coma decimal");
const nota = relevarMod.notas(db, plantelMod, { filas: [{ rp: "13", texto: "abortó" }], simular: true });
ok(nota.filas[0].avisos.length === 1, "la nota grave avisa");

seccion("Importar CSV");
const csvV = fs.readFileSync(path.join(__dirname, "nacimientos_el_triunfo_2026-08-31.csv"), "utf8");
const imp = relevarMod.importarCsv(db, plantelMod, { texto: csvV, simular: true });
ok(imp.tipo === "nacimientos" && imp.separador === ";" && imp.mapa.rp === "caravana_numero" && imp.mapa.madre_rp === "madre_rp", "detecta un CSV de nacimientos con ;");
ok(imp.leidas === 15 && imp.bien === 15, "lee las 15 filas");
const csvP = fs.readFileSync(path.join(__dirname, "triunfo_pesadas.csv"), "utf8");
const imp2 = relevarMod.importarCsv(db, plantelMod, { texto: csvP, simular: true });
ok(imp2.tipo === "pesadas" && imp2.mapa.peso === "peso" && imp2.mapa.fecha === "fecha", "detecta un CSV de pesadas con ,");
const pl = relevarMod.planilla(db, { lote_id: 1, campoNombre: "Prueba" }, exportarMod, mods);
ok(pl.buffer.length > 2000, "planilla de relevamiento en Excel");
const plh = relevarMod.planilla(db, { conjunto: "recria", formato: "html" }, exportarMod, mods);
ok(plh.buffer.toString().includes("Observaciones"), "planilla imprimible con las columnas para anotar");

seccion("Toros");
const tor = animalesMod.toros(db);
ok(tor.filas.length === 6 && tor.resumen.total === 6, "seis toros activos");
const her = tor.filas.find(t => t.nombre === "HERCULES");
ok(her && her.rp === "B332" && her.hijos > 5 && her.destete_prom_hijos > 100 && her.ce >= 36, "Hércules tiene hijos (por nombre), destete promedio y CE");
ok(animalesMod.buscar(db, "hercules")[0].rp === "B332" && animalesMod.buscar(db, "hercules")[0].coincide === "nombre", "buscar hercules encuentra al toro por nombre, primero");
ok(animalesMod.porRp(db, "Hércules").rp === "B332", "porRp entiende el nombre del toro");
ok(animalesMod.ficha(db, "B332").hijos.length === her.hijos, "la ficha del toro lista los mismos hijos");
ok(exportarMod.conjunto(db, mods, "toros").filas.length === 6, "conjunto toros para exportar");

seccion("Destinos");
ok(destinosMod.normalizarDestino("engorde", false) === "TERMINACION", "'engorde' es TERMINACION para una vaca");
ok(destinosMod.normalizarDestino("a engorde", true) === "NOVILLO TERMINACION", "'engorde' es NOVILLO TERMINACION para un macho");
ok(destinosMod.normalizarDestino("venta preñada", false) === "VENTA PREÑADA", "'venta preñada' tal cual");
ok(destinosMod.normalizarDestino("reproductor", true) === "TORO REPRODUCTOR", "'reproductor'");
ok(destinosMod.normalizarDestino("cualquier cosa", false) === null, "lo desconocido no se adivina");
const dm = destinosMod.marcarVarios(db, ["011", "13", "B332", "ZZZ"], "engorde", { motivo: "VACIA", temporada: "2099" });
const marcados = db.prepare("SELECT animal_rp, destino FROM destinos WHERE temporada='2099' ORDER BY animal_rp").all();
ok(dm.hechos.length === 3 && dm.fallados.length === 1, "marca 3 y avisa 1 (ZZZ)");
ok(marcados.find(m => m.animal_rp === "11").destino === "TERMINACION" && marcados.find(m => m.animal_rp === "B332").destino === "TORO TERMINACION", "vaca → TERMINACION, toro → TORO TERMINACION");
db.prepare("DELETE FROM destinos WHERE temporada='2099'").run();

// ── El bot, con un Claude simulado ───────────────────────────────────────────
// El cliente falso recibe un guion: una función por llamada, que mira los
// parámetros y devuelve el contenido del mensaje. Emite los eventos que emite
// el SDK ("text", "streamEvent") y resuelve finalMessage().
let _ultimosParams = null;
const clienteFalsoParams = () => _ultimosParams;
function clienteFalso(guion) {
  const llamadas = [];
  return {
    llamadas,
    messages: {
      stream(params) {
        llamadas.push(params); _ultimosParams = params;
        const paso = guion[Math.min(llamadas.length - 1, guion.length - 1)](params, llamadas.length);
        const handlers = {};
        const st = {
          on(ev, fn) { handlers[ev] = fn; return st; },
          async finalMessage() {
            for (const c of paso.content) {
              if (c.type === "thinking" && handlers.streamEvent) handlers.streamEvent({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: c.thinking } });
              if (c.type === "text" && handlers.text) handlers.text(c.text);
            }
            return { content: paso.content, stop_reason: paso.stop_reason || (paso.content.some(c => c.type === "tool_use") ? "tool_use" : "end_turn"),
              usage: { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: llamadas.length > 1 ? 900 : 0, cache_creation_input_tokens: llamadas.length > 1 ? 0 : 900 } };
          }
        };
        return st;
      }
    }
  };
}
const uso = (id, name, input) => ({ type: "tool_use", id, name, input });
const texto = t => ({ type: "text", text: t });

seccion("El bot (simulado)");
const bot1 = botMod.crear({ plantelMod, animalesMod, destinosMod, exportarMod, relevarMod, guardarTablero: S.guardarTablero, CAMPOS: S.CAMPOS,
  cliente: clienteFalso([
    () => ({ content: [{ type: "thinking", thinking: "Miro el plantel." }, uso("t1", "plantel", { estado: "FALLÓ" })] }),
    (params) => {
      const ultimo = params.messages[params.messages.length - 1];
      const out = JSON.parse(ultimo.content[0].content);
      return { content: [texto(`Fallaron ${out.total} vacas.`)] };
    }
  ]) });
ok(bot1.HERRAMIENTAS.map(h => h.name).join() === "plantel,ficha,toros,buscar,consultar,escribir,relevar,crear_tablero,exportar_archivo,destinar,recordar", "las once herramientas, en orden fijo");
const eventos = [];
(async () => {
  const r = await bot1.responder(db, "Prueba", "¿cuántas fallaron?", { campoKey: "principal", canal: "web", usuario: "prueba", onEvento: e => eventos.push(e) });
  const esperado = plantelMod.plantel(db).resumen.fallaron;
  ok(r.respuesta === `Fallaron ${esperado} vacas.`, "la respuesta usa el resultado de la herramienta plantel");
  ok(r.pasos.length === 1 && r.pasos[0].tipo === "consulta" && r.pasos[0].herramienta === "plantel" && r.pasos[0].filas === esperado, "el paso queda registrado");
  ok(eventos.some(e => e.tipo === "pensando") && eventos.some(e => e.tipo === "paso") && eventos.some(e => e.tipo === "texto") && eventos[eventos.length - 1].tipo === "fin", "emite pensando, paso, texto y fin");
  ok(r.uso.cache_read === 900 && r.uso.cache_creation === 900, "cuenta los tokens de caché");
  const conv = bot1.conversacion(db, "web", "prueba");
  ok(conv.length === 2 && conv[0].role === "user" && conv[1].role === "assistant", "la conversación queda guardada");

  // Segunda pregunta en la misma sesión: la historia sale de la base.
  const bot2 = botMod.crear({ plantelMod, animalesMod, destinosMod, exportarMod, relevarMod, guardarTablero: S.guardarTablero, CAMPOS: S.CAMPOS,
    cliente: clienteFalso([(params) => ({ content: [texto(`Tengo ${params.messages.length} mensajes de historia.`)] })]) });
  const r2 = await bot2.responder(db, "Prueba", "¿y las preñadas?", { campoKey: "principal", canal: "web", usuario: "prueba" });
  ok(r2.respuesta === "Tengo 3 mensajes de historia.", "la segunda pregunta lleva la historia de la base (2 previos + 1)");

  // Caché: la parte estable no cambia entre llamadas ni lleva la fecha; la volátil sí.
  const est1 = bot2.parteEstable(db, "Prueba"), est2 = bot2.parteEstable(db, "Prueba");
  ok(est1 === est2 && !est1.includes(new Date().toISOString().slice(0, 10)), "la parte estable es idéntica entre llamadas y no tiene la fecha");
  ok(bot2.parteVolatil(db).includes(new Date().toISOString().slice(0, 10)), "la fecha va en la parte volátil");
  // Los parámetros de la llamada: modelo, thinking adaptativo, esfuerzo, caché en el system.
  const params = clienteFalsoParams();
  ok(params.thinking.type === "adaptive" && params.output_config.effort === bot2.esfuerzo && params.system[0].cache_control.type === "ephemeral", "manda thinking adaptativo, esfuerzo y cache_control");
  ok(params.model === bot2.modelo && bot2.modelo === (process.env.MODELO || "claude-opus-5"), "usa el modelo configurado (Opus 5 por defecto)");

  // Memoria: el bot guarda y después lo lee en el prompt.
  const bot3 = botMod.crear({ plantelMod, animalesMod, destinosMod, exportarMod, relevarMod, guardarTablero: S.guardarTablero, CAMPOS: S.CAMPOS,
    cliente: clienteFalso([
      () => ({ content: [uso("t2", "recordar", { texto: "Al potrero 7 le dicen La Loma", categoria: "campo" })] }),
      () => ({ content: [texto("Anotado.")] })
    ]) });
  const r3 = await bot3.responder(db, "Prueba", "acordate que al potrero 7 le decimos La Loma", { campoKey: "principal", canal: "web", usuario: "prueba" });
  ok(r3.pasos.some(p => p.tipo === "memoria") && bot3.memorias(db).some(m => /La Loma/.test(m.texto)), "recordar guarda la memoria");
  ok(bot3.parteEstable(db, "Prueba").includes("La Loma"), "la memoria entra en el prompt");
  const idMem = bot3.memorias(db)[0].id;
  bot3.recordar(db, { olvidar_id: idMem });
  ok(!bot3.memorias(db).length, "olvidar la saca");

  // Destinar por el bot: "los 5 a engorde".
  const bot4 = botMod.crear({ plantelMod, animalesMod, destinosMod, exportarMod, relevarMod, guardarTablero: S.guardarTablero, CAMPOS: S.CAMPOS,
    cliente: clienteFalso([
      () => ({ content: [uso("t3", "destinar", { rps: ["011", "13", "15", "17", "19"], destino: "engorde", motivo: "VACIA" })] }),
      (params) => ({ content: [texto(JSON.parse(params.messages[params.messages.length - 1].content[0].content).mensaje)] })
    ]) });
  const r4 = await bot4.responder(db, "Prueba", "poné los 5 en destino engorde", { campoKey: "principal", canal: "web", usuario: "prueba" });
  const anio = new Date().toISOString().slice(0, 4);
  const dest = db.prepare("SELECT animal_rp, destino FROM destinos WHERE temporada=? ORDER BY animal_rp").all(anio);
  ok(dest.length === 5 && dest.every(d => d.destino === "TERMINACION"), "destinar marca los 5 como TERMINACION");
  ok(r4.pasos[0].tipo === "escritura" && /5 animales a ENGORDE/i.test(r4.respuesta), "cuenta como escritura y responde cuántos marcó");
  const lista = destinosMod.listar(db, plantelMod.plantel(db).filas);
  ok(lista.filas.length === 5 && lista.resumen.marcados === 5, "la pestaña Destinos los ve");
  db.prepare("DELETE FROM destinos WHERE temporada=?").run(anio);

  // Sólo lectura y errores de herramienta.
  const bot5 = botMod.crear({ plantelMod, animalesMod, destinosMod, exportarMod, relevarMod, guardarTablero: S.guardarTablero, CAMPOS: S.CAMPOS,
    cliente: clienteFalso([
      () => ({ content: [uso("t4", "escribir", { sql: "DELETE FROM animales", que: "borrar todo" })] }),
      (params) => ({ content: [texto(JSON.parse(params.messages[params.messages.length - 1].content[0].content).error)] })
    ]) });
  const r5 = await bot5.responder(db, "Prueba", "borrá todo", { campoKey: "principal", soloLectura: true });
  ok(/sólo lectura/.test(r5.respuesta) && r5.pasos[0].tipo === "error", "en sólo lectura no escribe y el error vuelve al modelo");
  ok(db.prepare("SELECT COUNT(*) n FROM animales").get().n > 200, "no borró nada");

  // Refusal.
  const bot6 = botMod.crear({ plantelMod, animalesMod, destinosMod, exportarMod, relevarMod, guardarTablero: S.guardarTablero, CAMPOS: S.CAMPOS,
    cliente: clienteFalso([() => ({ content: [], stop_reason: "refusal" })]) });
  const r6 = await bot6.responder(db, "Prueba", "x", { campoKey: "principal" });
  ok(r6.motivo === "refusal" && r6.respuesta.length > 0, "un refusal devuelve un mensaje, no rompe");

  // Herramientas viejas del bot siguen andando.
  const e1 = bot1.exportarDesdeBot(db, { titulo: "Vacías", conjunto: "fallos" }, { campoKey: "principal" });
  ok(e1.url.startsWith("/archivos/"), "el bot exporta un conjunto");
  const e2 = bot1.exportarDesdeBot(db, { titulo: "Toros", sql: "SELECT rp FROM animales WHERE categoria='TORO'", formato: "csv" }, { campoKey: "principal" });
  ok(e2.filas === 6, "el bot exporta un SELECT");
  const r7 = bot1.relevarDesdeBot(db, { tipo: "pesadas", filas: [{ rp: "011", peso: 440 }], simular: true });
  ok(r7.bien === 1, "el bot releva pesadas");
  const inst = bot1.instrucciones(db, "Prueba");
  ok(inst.includes("destinar") && inst.includes("recordar") && inst.includes("HOY ES"), "las instrucciones nombran las herramientas nuevas y la fecha");
  ok(require("./preguntas.js").length >= 18 && require("./preguntas.js").every(p => typeof p.verificar === "function"), "el banco de preguntas carga");

  console.log(`\n${n} pruebas, ${fallas} fallas`);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(fallas ? 1 : 0);
})().catch(e => { console.error("ERROR en las pruebas:", e); process.exit(1); });
