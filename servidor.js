// Colonia de Agentes — servidor local
// Lee las sesiones de Claude Code de esta computadora y las muestra como colonos.
// Solo lee archivos; no modifica nada. Solo escucha en esta computadora (127.0.0.1).
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");

const PUERTO = Number(process.env.COLONIA_PUERTO || 4747);
const CARPETA = process.env.COLONIA_SESIONES || path.join(os.homedir(), ".claude", "projects");
const MOSTRAR_HORAS = Number(process.env.COLONIA_HORAS || 72); // sesiones tocadas en las últimas N horas
const TAIL = 256 * 1024;

const NOMBRES = ["Quispe", "Rosa", "Tito", "Mayta", "Killa", "Inti", "Nina", "Sami", "Wayra", "Tupa", "Ayar", "Chaska", "Kusi", "Yaku", "Pacha", "Illa", "Rumi", "Sisa", "Amaru", "Kori", "Urpi", "Ccori", "Tika", "Wari"];
const ROPA = ["#5b7a99", "#8a5a44", "#6b8f4e", "#9a8a4a", "#7a5f8f", "#4f8a86", "#a0603c", "#5e6a7d", "#8e4f5f", "#6f7f3a"];

function hash(s) { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

function leerTrozo(file, desde, largo) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(largo);
    const n = fs.readSync(fd, buf, 0, largo, desde);
    return buf.slice(0, n).toString("utf8");
  } finally { fs.closeSync(fd); }
}

function lineas(texto, cortarPrimera) {
  const ls = texto.split("\n");
  if (cortarPrimera) ls.shift();
  const out = [];
  for (const l of ls) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch (_) {} }
  return out;
}

const ACTIVIDADES = {
  construir: { verbo: "Construyendo", mueble: "mesa" },
  investigar: { verbo: "Investigando", mueble: "estante" },
  operar: { verbo: "Operando la consola", mueble: "consola" },
  explorar: { verbo: "Explorando la red", mueble: "antena" },
  delegar: { verbo: "Dando órdenes", mueble: "radio" },
  planificar: { verbo: "Planificando", mueble: "pizarra" },
  pensar: { verbo: "Pensando", mueble: "silla" },
  esperar: { verbo: "Espera tus órdenes", mueble: "silla" },
  permiso: { verbo: "¿Te necesita? Revisa su terminal", mueble: "silla" },
  dormir: { verbo: "Durmiendo", mueble: "cama" }
};

function tipoHerramienta(nombre) {
  const n = String(nombre || "");
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(n)) return "construir";
  if (/^(Read|Glob|Grep|LS|NotebookRead)$/.test(n)) return "investigar";
  if (/^(WebSearch|WebFetch)$/.test(n) || /browser|chrome|playwright|navigate/i.test(n)) return "explorar";
  if (/^(Task|Agent|SendMessage)$/.test(n)) return "delegar";
  if (/^(TodoWrite|TaskCreate|TaskUpdate|ExitPlanMode|EnterPlanMode)$/.test(n)) return "planificar";
  return "operar";
}

function detalleHerramienta(b) {
  const i = b.input || {};
  const base = (p) => String(p).split(/[\\/]/).pop();
  if (i.file_path) return base(i.file_path);
  if (i.notebook_path) return base(i.notebook_path);
  if (i.description) return String(i.description).slice(0, 60);
  if (i.command) return String(i.command).split("\n")[0].slice(0, 60);
  if (i.pattern) return String(i.pattern).slice(0, 40);
  if (i.query) return String(i.query).slice(0, 60);
  if (i.url) { try { return new URL(i.url).hostname; } catch (_) { return String(i.url).slice(0, 40); } }
  if (i.prompt) return String(i.prompt).slice(0, 60);
  return "";
}

function textoUsuario(m) {
  const c = m && m.message && m.message.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) { const t = c.find((x) => x.type === "text"); return t ? t.text : null; }
  return null;
}
function esPromptReal(e) {
  if (e.type !== "user" || e.isMeta) return false;
  const c = e.message && e.message.content;
  if (Array.isArray(c) && c.some((x) => x.type === "tool_result")) return false;
  const t = textoUsuario(e);
  return !!t && !t.trim().startsWith("<");
}

const cache = new Map(); // file -> {mtime, size, data}

// Función del agente: la línea "Rol: ..." del CLAUDE.md de su carpeta
const cacheRol = new Map(); // cwd -> {t, rol}
function rolDe(cwd) {
  const prev = cacheRol.get(cwd);
  if (prev && Date.now() - prev.t < 10000) return prev.rol;
  let rol = "";
  for (const nombre of ["CLAUDE.md", path.join(".claude", "CLAUDE.md")]) {
    try {
      const txt = fs.readFileSync(path.join(cwd, nombre), "utf8").slice(0, 8000);
      const m = txt.match(/^[\s#>*-]*(?:rol|role|funci[oó]n)\s*:\s*(.+)$/im);
      if (m) { rol = m[1].replace(/[*_`]/g, "").trim().slice(0, 80); break; }
    } catch (_) {}
  }
  cacheRol.set(cwd, { t: Date.now(), rol });
  return rol;
}

// Salas ocultas, guardadas junto a la colonia
const ARCHIVO_OCULTAS = path.join(__dirname, "salas-ocultas.txt");
function leerOcultas() {
  try { return new Set(fs.readFileSync(ARCHIVO_OCULTAS, "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)); } catch (_) { return new Set(); }
}
function guardarOcultas(set) { fs.writeFileSync(ARCHIVO_OCULTAS, [...set].join("\n") + "\n", "utf8"); }

function analizar(file, stat) {
  const prev = cache.get(file);
  if (prev && prev.mtime === stat.mtimeMs && prev.size === stat.size) return prev.data;

  const desde = Math.max(0, stat.size - TAIL);
  const ents = lineas(leerTrozo(file, desde, stat.size - desde), desde > 0);
  let titulo = prev && prev.data && prev.data.titulo, cwd = prev && prev.data && prev.data.cwd, sessionId = null;
  for (const e of ents) {
    if (e.type === "custom-title" && e.customTitle) titulo = e.customTitle;
    else if (e.type === "ai-title" && e.aiTitle && !(titulo && prev && prev.data && prev.data.tituloFijo)) titulo = e.aiTitle;
    else if (e.type === "summary" && e.summary && !titulo) titulo = e.summary;
    if (e.cwd) cwd = e.cwd;
    if (e.sessionId) sessionId = e.sessionId;
  }
  if (!titulo || !cwd) {
    const head = lineas(leerTrozo(file, 0, Math.min(stat.size, TAIL)), false);
    for (const e of head) {
      if (!cwd && e.cwd) cwd = e.cwd;
      if (!titulo && e.type === "summary" && e.summary) titulo = e.summary;
      if (!titulo && esPromptReal(e)) titulo = textoUsuario(e).trim().split("\n")[0].slice(0, 70);
    }
  }

  // último evento con sentido
  let ultimo = null;
  for (let k = ents.length - 1; k >= 0; k--) {
    const e = ents[k];
    if (e.type === "assistant" || (e.type === "user" && !e.isMeta)) { ultimo = e; break; }
  }
  const acciones = [];
  for (const e of ents) {
    if (e.type !== "assistant") continue;
    const c = (e.message && e.message.content) || [];
    for (const b of c) if (b.type === "tool_use") acciones.push({ t: Date.parse(e.timestamp) || 0, tipo: tipoHerramienta(b.name), herramienta: b.name, detalle: detalleHerramienta(b) });
  }
  let ultimoTexto = "";
  for (let k = ents.length - 1; k >= 0; k--) {
    const e = ents[k];
    if (e.type === "assistant") {
      const t = ((e.message && e.message.content) || []).find((x) => x.type === "text" && x.text && x.text.trim());
      if (t) { ultimoTexto = t.text.trim().replace(/\s+/g, " ").slice(0, 220); break; }
    }
  }
  const data = { titulo, cwd, sessionId, ultimo, acciones: acciones.slice(-12), ultimoTexto };
  cache.set(file, { mtime: stat.mtimeMs, size: stat.size, data });
  return data;
}

function estadoDe(d, edadSeg) {
  if (edadSeg > 20 * 60) return { act: "dormir" };
  const u = d.ultimo;
  if (!u) return { act: "esperar" };
  const c = (u.message && u.message.content) || [];
  if (u.type === "assistant") {
    const tools = Array.isArray(c) ? c.filter((x) => x.type === "tool_use") : [];
    if (tools.length) {
      const b = tools[tools.length - 1];
      // comandos largos (renderizar un video, instalar) pueden tardar: se les da más margen
      const margen = /^(Task|Agent)$/.test(b.name) ? Infinity : /^(Bash|PowerShell|BashOutput)$/.test(b.name) ? 240 : 45;
      if (edadSeg > margen) return { act: "permiso", herramienta: b.name, detalle: detalleHerramienta(b) };
      return { act: tipoHerramienta(b.name), herramienta: b.name, detalle: detalleHerramienta(b) };
    }
    const stop = u.message && u.message.stop_reason;
    if (stop === "end_turn" || stop === "stop_sequence" || edadSeg > 30) return { act: "esperar" };
    return { act: "pensar" };
  }
  // user
  if (edadSeg > 5 * 60) return { act: "esperar" };
  return { act: "pensar" };
}

function listarSesiones() {
  const ahora = Date.now();
  const limite = ahora - MOSTRAR_HORAS * 3600 * 1000;
  const out = [];
  const ocultas = leerOcultas();
  let dirs = [];
  try { dirs = fs.readdirSync(CARPETA, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch (_) { return { error: "No encontré la carpeta de sesiones: " + CARPETA, colonos: [] }; }
  for (const d of dirs) {
    const dirProyecto = path.join(CARPETA, d.name);
    const candidatos = [];
    let items = [];
    try { items = fs.readdirSync(dirProyecto, { withFileTypes: true }); } catch (_) { continue; }
    for (const it of items) {
      const p = path.join(dirProyecto, it.name);
      if (it.isFile() && it.name.endsWith(".jsonl")) candidatos.push({ file: p, padre: null });
      else if (it.isDirectory()) {
        const sub = path.join(p, "subagents");
        try {
          for (const s of fs.readdirSync(sub)) if (s.endsWith(".jsonl")) candidatos.push({ file: path.join(sub, s), padre: it.name });
        } catch (_) {}
      }
    }
    for (const c of candidatos) {
      let st; try { st = fs.statSync(c.file); } catch (_) { continue; }
      if (st.mtimeMs < limite || st.size === 0) continue;
      const edad = (ahora - st.mtimeMs) / 1000;
      if (c.padre && edad > 5 * 60) continue; // ayudantes solo mientras trabajan
      let d2; try { d2 = analizar(c.file, st); } catch (_) { continue; }
      if (!d2.cwd || ocultas.has(d2.cwd)) continue;
      const id = path.basename(c.file, ".jsonl");
      const h = hash(id);
      const est = estadoDe(d2, edad);
      out.push({
        id,
        padre: c.padre,
        nombre: c.padre ? "Ayudante " + NOMBRES[h % NOMBRES.length] : NOMBRES[h % NOMBRES.length],
        ropa: ROPA[(h >>> 5) % ROPA.length],
        pelo: (h >>> 9) % 4,
        titulo: d2.titulo || "Sesión sin título",
        cwd: d2.cwd,
        sala: String(d2.cwd).split(/[\\/]/).filter(Boolean).pop() || d2.cwd,
        rol: rolDe(d2.cwd),
        actividad: est.act,
        verbo: ACTIVIDADES[est.act].verbo,
        mueble: ACTIVIDADES[est.act].mueble,
        herramienta: est.herramienta || null,
        detalle: est.detalle || "",
        edadSeg: Math.round(edad),
        ultimoTexto: d2.ultimoTexto,
        acciones: d2.acciones
      });
    }
  }
  // nombres únicos y estables: se reparten en orden de id
  const usados = new Set();
  for (const c of out.filter((x) => !x.padre).sort((a, b) => a.id.localeCompare(b.id))) {
    let k = hash(c.id) % NOMBRES.length, n = 0;
    while (usados.has(NOMBRES[k]) && n < NOMBRES.length) { k = (k + 1) % NOMBRES.length; n++; }
    c.nombre = NOMBRES[k] + (n >= NOMBRES.length ? " " + c.id.slice(0, 3) : "");
    usados.add(NOMBRES[k]);
  }
  for (const c of out.filter((x) => x.padre)) {
    const jefe = out.find((x) => x.id === c.padre);
    c.nombre = "Ayudante de " + (jefe ? jefe.nombre : "otro");
    if (jefe && c.titulo === "Sesión sin título") c.titulo = jefe.titulo;
  }
  // órdenes en curso o recientes
  for (const c of out) {
    const o = ordenes.get(c.id);
    if (!o) continue;
    c.orden = { texto: o.texto, enCurso: o.enCurso, inicio: o.inicio, fin: o.fin, salida: o.salida.trim().slice(-2500), error: o.error.trim().slice(-600) };
    if (o.enCurso && ["esperar", "dormir", "permiso"].includes(c.actividad)) {
      c.actividad = "pensar"; c.verbo = ACTIVIDADES.pensar.verbo + " en tu orden"; c.mueble = "silla"; c.detalle = "";
    }
  }
  const nuevos = [];
  for (const [k, o] of ordenes) if (k.startsWith("nuevo:") && (o.enCurso || Date.now() - o.fin < 120000)) nuevos.push({ cwd: o.cwd, texto: o.texto, enCurso: o.enCurso, error: o.error.trim().slice(-400) });
  const carpetas = [...new Set(out.filter((c) => !c.padre).map((c) => c.cwd))].sort();
  out.sort((a, b) => a.edadSeg - b.edadSeg);
  return { carpeta: CARPETA, generado: ahora, ocultas: ocultas.size, carpetas, nuevos, colonos: out };
}

// ---------- órdenes: despertar a un agente con un pedido ----------
// Se ejecuta "claude -p" en la carpeta del colono, retomando su misma conversación.
const TOKEN = crypto.randomBytes(16).toString("hex"); // solo la página de la colonia lo conoce
const ordenes = new Map(); // id de sesión (o "nuevo:...") -> {texto, cwd, inicio, fin, salida, error, enCurso}

function binarioClaude() {
  if (process.env.COLONIA_CLAUDE) return process.env.COLONIA_CLAUDE;
  const local = path.join(os.homedir(), ".local", "bin", process.platform === "win32" ? "claude.exe" : "claude");
  return fs.existsSync(local) ? local : "claude";
}

function lanzarOrden(clave, cwd, texto, sesion) {
  const args = ["-p", texto];
  if (sesion) args.push("--resume", sesion);
  const o = { texto, cwd, inicio: Date.now(), fin: null, salida: "", error: "", enCurso: true, sesion: sesion || null };
  ordenes.set(clave, o);
  let hijo;
  try { hijo = spawn(binarioClaude(), args, { cwd, windowsHide: true, env: process.env, stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { o.enCurso = false; o.fin = Date.now(); o.error = "No pude abrir Claude Code: " + e.message; return; }
  const juntar = (campo) => (b) => { o[campo] = (o[campo] + b.toString("utf8")).slice(-6000); };
  hijo.stdout.on("data", juntar("salida"));
  hijo.stderr.on("data", juntar("error"));
  hijo.on("error", (e) => { o.enCurso = false; o.fin = Date.now(); o.error = e.code === "ENOENT" ? "No encontré Claude Code en esta computadora." : String(e.message); });
  hijo.on("close", (codigo) => { o.enCurso = false; o.fin = Date.now(); if (codigo && !o.error) o.error = "Claude terminó con un error (código " + codigo + ")."; });
  console.log("Orden enviada en " + cwd + (sesion ? " (sesión " + sesion.slice(0, 8) + ")" : " (colono nuevo)") + ": " + texto.slice(0, 80));
}

function origenValido(req) {
  const o = req.headers.origin;
  if (!o) return true; // pedidos sin Origin vienen de la misma página
  return o === "http://localhost:" + PUERTO || o === "http://127.0.0.1:" + PUERTO;
}

const PUBLICO = path.join(__dirname, "publico");
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/api/estado") {
    let body;
    try { body = JSON.stringify(listarSesiones()); } catch (e) { body = JSON.stringify({ error: String(e && e.message), colonos: [] }); }
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    return res.end(body);
  }
  if (req.method === "POST" && (url.pathname === "/api/ocultar" || url.pathname === "/api/mostrar-todo")) {
    let cuerpo = "";
    req.on("data", (c) => { cuerpo += c; if (cuerpo.length > 10000) req.destroy(); });
    req.on("end", () => {
      try {
        if (url.pathname === "/api/mostrar-todo") guardarOcultas(new Set());
        else {
          const { sala } = JSON.parse(cuerpo || "{}");
          if (typeof sala === "string" && sala.length < 1000) { const s = leerOcultas(); s.add(sala); guardarOcultas(s); }
        }
        res.writeHead(200, { "content-type": "application/json" }); res.end("{\"ok\":true}");
      } catch (e) { res.writeHead(400); res.end("{\"ok\":false}"); }
    });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/orden") {
    let cuerpo = "";
    req.on("data", (c) => { cuerpo += c; if (cuerpo.length > 20000) req.destroy(); });
    req.on("end", () => {
      const responder = (code, obj) => { res.writeHead(code, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); };
      try {
        if (!origenValido(req)) return responder(403, { error: "Origen no permitido." });
        const { token, sesion, cwd, texto } = JSON.parse(cuerpo || "{}");
        if (token !== TOKEN) return responder(403, { error: "La página está desactualizada. Recárgala (F5) y vuelve a intentar." });
        if (typeof texto !== "string" || !texto.trim() || texto.length > 8000) return responder(400, { error: "Escribe la orden." });
        const estado = listarSesiones();
        if (sesion) {
          const c = estado.colonos.find((x) => x.id === sesion && !x.padre);
          if (!c) return responder(404, { error: "No encontré a ese colono." });
          const prev = ordenes.get(sesion);
          if (prev && prev.enCurso) return responder(409, { error: "Todavía está trabajando en tu orden anterior." });
          if (!fs.existsSync(c.cwd)) return responder(404, { error: "Su carpeta ya no existe: " + c.cwd });
          lanzarOrden(sesion, c.cwd, texto.trim(), sesion);
        } else {
          if (typeof cwd !== "string" || !estado.carpetas.includes(cwd)) return responder(400, { error: "Elige una de las salas de la colonia." });
          if (!fs.existsSync(cwd)) return responder(404, { error: "Esa carpeta ya no existe: " + cwd });
          lanzarOrden("nuevo:" + Date.now(), cwd, texto.trim(), null);
        }
        responder(200, { ok: true });
      } catch (e) { responder(400, { error: "No entendí el pedido." }); }
    });
    return;
  }
  const archivo = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const ruta = path.join(PUBLICO, path.normalize(archivo).replace(/^(\.\.[\\/])+/, ""));
  if (!ruta.startsWith(PUBLICO)) { res.writeHead(403); return res.end(); }
  fs.readFile(ruta, (err, data) => {
    if (err) { res.writeHead(404); return res.end("No encontrado"); }
    const tipos = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" };
    res.writeHead(200, { "content-type": tipos[path.extname(ruta)] || "application/octet-stream", "cache-control": "no-store" });
    if (path.extname(ruta) === ".html") data = Buffer.from(data.toString("utf8").replace("__COLONIA_TOKEN__", TOKEN));
    res.end(data);
  });
});

function abrirNavegador() {
  if (process.env.COLONIA_NO_ABRIR) return;
  const url = "http://localhost:" + PUERTO;
  const { exec } = require("child_process");
  const cmd = process.platform === "win32" ? 'start "" "' + url + '"' : process.platform === "darwin" ? 'open "' + url + '"' : 'xdg-open "' + url + '"';
  exec(cmd, () => {});
}

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") { console.log("La colonia ya estaba abierta. Te la muestro en el navegador."); abrirNavegador(); setTimeout(() => process.exit(0), 1500); }
  else { console.error(e); process.exit(1); }
});
server.listen(PUERTO, "127.0.0.1", () => {
  console.log("Colonia de Agentes lista en http://localhost:" + PUERTO);
  abrirNavegador();
  console.log("Leyendo sesiones de: " + CARPETA);
  console.log("Deja esta ventana abierta mientras uses la colonia. Para cerrarla: Ctrl + C.");
});
