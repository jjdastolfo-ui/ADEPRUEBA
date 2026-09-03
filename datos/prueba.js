// ─────────────────────────────────────────────────────────────────────────────
// PRUEBA — corre los módulos contra una base de prueba y avisa si algo se rompe.
//
//   npm run prueba
//
// Arma la base de semilla en una carpeta temporal (no toca ./data ni /data),
// y ejercita búsqueda, fichas, exportación, relevamiento, importación de CSV
// y las herramientas del bot. Si termina sin "FALLÓ", está todo bien.
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
const exportarMod = require("../exportar.js"), relevarMod = require("../relevar.js"), xlsx = require("../xlsx.js");
const mods = { plantelMod, animalesMod, destinosMod };

let fallas = 0, n = 0;
function ok(cond, que) { n++; if (!cond) { fallas++; console.log("  FALLÓ:", que); } }
function seccion(t) { console.log("\n" + t); }

seccion("Buscar");
const b1 = animalesMod.buscar(db, "011");
ok(b1.length && b1[0].rp === "11", "'011' encuentra a la 11 primero");
ok(animalesMod.buscar(db, "b 332")[0].rp === "B332", "'b 332' encuentra al toro B332");
ok(animalesMod.buscar(db, "hércules").length > 5 && animalesMod.buscar(db, "hércules")[0].coincide === "padre", "'hércules' encuentra hijos por padre");
ok(animalesMod.buscar(db, "renga").length === 1, "busca en las notas de campo");
ok(animalesMod.porRp(db, " 011 ").rp === "11", "porRp tolera ceros y espacios");

seccion("Fichas");
const f1 = S.app ? require("../animales.js").ficha(db, "11") : null;
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
// El primer archivo del zip es [Content_Types].xml: se descomprime para ver que sea XML.
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
const nac = relevarMod.nacimientos(db, { filas: [{ rp: "C900", madre_rp: "011", fecha_nac: "01/09/2026", sexo: "h", pelo: "colorada", peso_nac: "31,5" }] });
ok(nac.bien === 1 && animalesMod.porRp(db, "C900").categoria === "TERNERA", "nacimiento crea la ternera");
ok(nac.filas[0].avisos.some(a => /ya tiene cría/.test(a)), "avisa que la madre ya tiene cría este año");
const nac2 = relevarMod.nacimientos(db, { filas: [{ rp: "C900", madre_rp: "11", fecha_nac: "2026-09-01", sexo: "M" }], simular: true });
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

seccion("Herramientas del bot");
ok(S.HERRAMIENTAS.map(h => h.name).join() === "consultar,escribir,crear_tablero,exportar_archivo,relevar", "las cinco herramientas");
const inst = S.instrucciones(db, "Prueba");
ok(inst.includes("exportar_archivo") && inst.includes("relevar"), "las instrucciones explican las nuevas");
const e1 = S.exportarDesdeBot(db, { titulo: "Vacías", conjunto: "fallos" }, { campoKey: "principal" });
ok(e1.url.startsWith("/archivos/"), "el bot exporta un conjunto");
const e2 = S.exportarDesdeBot(db, { titulo: "Toros", sql: "SELECT rp FROM animales WHERE categoria='TORO'", formato: "csv" }, { campoKey: "principal" });
ok(e2.filas === 6, "el bot exporta un SELECT");
const r1 = S.relevarDesdeBot(db, { tipo: "pesadas", filas: [{ rp: "011", peso: 440 }], simular: true });
ok(r1.bien === 1, "el bot releva pesadas");
error = null; try { S.relevarDesdeBot(db, { tipo: "otra" }); } catch (e) { error = e.message; }
ok(/no\. Puede ser/.test(error), "tipo inválido avisa");

console.log(`\n${n} pruebas, ${fallas} fallas`);
db.close();
fs.rmSync(dir, { recursive: true, force: true });
process.exit(fallas ? 1 : 0);
