// Colonia de Agentes — arranque con actualización automática.
// Antes de abrir la colonia revisa si hay una versión nueva en GitHub y la descarga.
// Si no hay internet, abre la versión que ya tienes.
"use strict";
const fs = require("fs");
const path = require("path");

const REPO = "lawrencegr31/colonia-agentes";
const RAMA = "main";
const AQUI = __dirname;
const VERSION_LOCAL = path.join(AQUI, ".version");

async function obtener(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { "user-agent": "colonia-agentes", accept: "application/vnd.github+json" } });
    if (!r.ok) throw new Error("HTTP " + r.status + " en " + url);
    return r;
  } finally { clearTimeout(t); }
}

async function actualizar() {
  const commit = await (await obtener("https://api.github.com/repos/" + REPO + "/commits/" + RAMA)).json();
  const sha = commit.sha;
  let local = "";
  try { local = fs.readFileSync(VERSION_LOCAL, "utf8").trim(); } catch (_) {}
  if (sha === local) { console.log("La colonia ya está en su última versión."); return; }

  const base = "https://raw.githubusercontent.com/" + REPO + "/" + sha + "/";
  const lista = await (await obtener(base + "archivos.json")).json();
  const descargados = [];
  for (const rel of lista.archivos) {
    if (typeof rel !== "string" || rel.includes("..") || path.isAbsolute(rel)) continue;
    const contenido = Buffer.from(await (await obtener(base + rel.split("/").map(encodeURIComponent).join("/"))).arrayBuffer());
    descargados.push([rel, contenido]);
  }
  // escribir todo solo cuando ya se descargó todo
  for (const [rel, contenido] of descargados) {
    const destino = path.join(AQUI, ...rel.split("/"));
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    const tmp = destino + ".nuevo";
    fs.writeFileSync(tmp, contenido);
    fs.renameSync(tmp, destino);
  }
  fs.writeFileSync(VERSION_LOCAL, sha + "\n");
  const nota = (commit.commit && commit.commit.message || "").split("\n")[0];
  console.log("Colonia actualizada" + (nota ? ": " + nota : "") + ".");
}

(async () => {
  try { await actualizar(); }
  catch (e) { console.log("No pude buscar actualizaciones (" + (e && e.message || e) + "). Abro la versión que ya tienes."); }
  require("./servidor.js");
})();
