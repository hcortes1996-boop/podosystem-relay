#!/usr/bin/env node
'use strict';
/**
 * generar-web-clinica.js — Escribe en disco la web de una clínica, lista para subir.
 *
 * Existe porque «Redeploy web» necesita el `NETLIFY_TOKEN` de Railway, y cuando ese
 * token caduca no hay forma de actualizar la web de nadie. Esto genera exactamente
 * los mismos ficheros que se subirían, para poder soltarlos a mano en Netlify
 * (arrastrar la carpeta en Deploys → «Deploy manually») sin depender del token.
 *
 * Usa `construirVars` y `construirFicheros` de `src/netlify-deploy.js`, **las mismas
 * funciones que usa el despliegue de verdad**. Si esto reimplantara la sustitución
 * por su cuenta, lo que se revisa en local dejaría de ser lo que se publica — que es
 * exactamente el fallo que este proyecto ya ha pagado con las dos rutas de sync.
 *
 * Uso:
 *   node scripts/generar-web-clinica.js --id bhy3fWaqW0 --nombre "CLINICA DEL PIE MERINO" \
 *        --ciudad "DOS HERMANAS" --telefono 675565440 [--salida ./sitio-merino]
 *
 * Los datos de la clínica salen de la propia base del relay si se pasa --db.
 */
const fs = require('fs');
const path = require('path');
const { construirVars, construirFicheros } = require('../src/netlify-deploy');

function arg(nombre, pordefecto) {
  const i = process.argv.indexOf(`--${nombre}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : pordefecto;
}

const clinicaId = arg('id');
if (!clinicaId) {
  console.error('Falta --id. Ejemplo:\n  node scripts/generar-web-clinica.js --id bhy3fWaqW0 ' +
                '--nombre "CLINICA DEL PIE MERINO" --ciudad "DOS HERMANAS" --telefono 675565440');
  process.exit(1);
}

let datos = {
  clinicaId,
  nombre:    arg('nombre', ''),
  ciudad:    arg('ciudad', ''),
  direccion: arg('direccion', ''),
  telefono:  arg('telefono', ''),
};

// Si se pasa --db, los datos salen de la base en vez de la línea de órdenes: es lo
// que hace el redeploy de verdad, así que se parece más a lo que se publicaría.
const dbPath = arg('db');
if (dbPath) {
  const db = require('better-sqlite3')(dbPath, { readonly: true });
  const c = db.prepare('SELECT id, nombre FROM clinicas WHERE id = ?').get(clinicaId);
  if (!c) { console.error(`La clínica ${clinicaId} no está en ${dbPath}`); process.exit(1); }
  const alta = db.prepare(
    'SELECT ciudad, telefono FROM solicitudes_alta WHERE clinicaId = ? ORDER BY creadaEn DESC LIMIT 1'
  ).get(clinicaId);
  datos = {
    clinicaId,
    nombre:    c.nombre,
    ciudad:    alta?.ciudad   || datos.ciudad,
    direccion: datos.direccion,
    telefono:  alta?.telefono || datos.telefono,
  };
  db.close();
}

if (!datos.nombre) { console.error('Falta --nombre (o usa --db para sacarlo de la base)'); process.exit(1); }

const salida = path.resolve(arg('salida', path.join(process.cwd(), `sitio-${clinicaId}`)));
const vars = construirVars(datos);
const ficheros = construirFicheros(vars);

fs.mkdirSync(salida, { recursive: true });
let bytes = 0;
for (const [ruta, buf] of Object.entries(ficheros)) {
  const destino = path.join(salida, ruta);
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.writeFileSync(destino, buf);
  bytes += buf.length;
}

// Ningún marcador puede quedarse sin sustituir: uno suelto en el CSS deja la página
// rota, y solo se vería en producción.
const sueltos = [];
for (const [ruta, buf] of Object.entries(ficheros)) {
  if (!ruta.endsWith('.html')) continue;
  const m = String(buf).match(/\{\{[A-Z_0-9]+\}\}/g);
  if (m) sueltos.push(`${ruta}: ${[...new Set(m)].join(', ')}`);
}

console.log(`\n✅ Web de «${datos.nombre}» generada en:\n   ${salida}\n`);
console.log(`   ${Object.keys(ficheros).length} ficheros, ${(bytes / 1024).toFixed(0)} KB`);
for (const r of Object.keys(ficheros).sort()) console.log(`     · ${r}`);

if (sueltos.length) {
  console.error(`\n❌ MARCADORES SIN SUSTITUIR — no subir esto:\n   ${sueltos.join('\n   ')}`);
  process.exit(1);
}
console.log('\n   Ningún marcador sin sustituir.');
console.log('\n   Para publicarla sin el token de Netlify: entra en el sitio en Netlify →');
console.log('   Deploys → «Deploy manually» → arrastra ESTA carpeta (no un zip de ella).');
console.log('   El deploy anterior queda en el historial y se puede restaurar con un clic.\n');
