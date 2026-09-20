#!/usr/bin/env node
'use strict';
/**
 * test_citas_relay.js — El relay sirve la web de citas: GET /cita/:clinicaId
 *
 * ── Qué defiende ─────────────────────────────────────────────────────────────
 *
 * Decisión ② del 13-09-2026 (`docs/estudio_citas_web_en_el_trial.md`): el relay sirve la web de
 * los trials y Netlify queda para quien paga. El propio estudio dejó escrito qué hay que probar
 * de este bloque, y es lo que se comprueba aquí:
 *
 *   «que /cita/<id> de una clínica que no existe dé 404 y no un error feo; que el logo se
 *    sirva con caché; y que servir páginas no ralentice la sincronización de agendas».
 *
 * El logo ya iba cacheado desde antes (`public.js`, `max-age=3600`), así que lo que queda por
 * fijar es lo demás — más dos cosas que salieron al escribirlo:
 *
 *   · **`activa = 0` tiene que dar 404.** Es la misma puerta que cierra la web pública al
 *     cancelar una suscripción (punto 26). Si esta ruta se la saltara, una clínica dada de baja
 *     seguiría ofreciendo huecos por otra dirección.
 *   · **La plantilla cruda no puede servirse nunca.** Bajo `web-template` están `cita.html` y
 *     `gestionar.html` SIN sustituir; si el estático los sirviera, cualquiera que adivinara la
 *     ruta vería `{{CLINICA_NOMBRE}}` y compañía.
 *
 * ⚠️ Y una que no es del estudio pero es la que más barato sale aquí: **que no quede ni un
 * marcador sin sustituir**. Es el mismo fallo que `test_plantilla_web.js` defiende para el
 * camino de Netlify; este es el otro camino hacia la misma página, y sin esto podrían separarse.
 *
 *   node scripts/test_citas_relay.js
 */

const express  = require('express');
const fs       = require('fs');
const os       = require('os');
const path     = require('path');
const Database = require('better-sqlite3');

let pasados = 0, fallados = 0;
const ok = (cond, nombre, extra) => {
  if (cond) { pasados++; console.log('  ✅ ' + nombre); }
  else { fallados++; console.log('  ❌ ' + nombre + (extra ? '\n       → ' + extra : '')); }
};

/* ── Base temporal con lo justo ────────────────────────────────────────────── */
//
// Se crea la tabla a mano en vez de llamar a `initDB()`: esta prueba solo necesita `clinicas`,
// y así no depende de cómo esté montado el arranque ni deja ficheros de una base completa.
const FICHERO = path.join(os.tmpdir(), `podo-citas-relay-${process.pid}-${Date.now()}.db`);
const db = new Database(FICHERO);
db.exec(`
  CREATE TABLE clinicas (
    id TEXT PRIMARY KEY, nombre TEXT NOT NULL, apiKey TEXT,
    telefono TEXT, ciudad TEXT, direccion TEXT,
    activa INTEGER NOT NULL DEFAULT 1
  );
`);
db.prepare(`INSERT INTO clinicas (id, nombre, apiKey, telefono, ciudad, direccion, activa)
            VALUES (?,?,?,?,?,?,1)`)
  .run('trialABC123', 'CLINICA DE PRUEBA NORTE', 'k1', '675565440', 'DOS HERMANAS', 'Calle Falsa 1');
db.prepare(`INSERT INTO clinicas (id, nombre, apiKey, activa) VALUES (?,?,?,0)`)
  .run('canceladaXY', 'CLINICA CANCELADA', 'k2');

/* ── El servidor, con la ruta de verdad ────────────────────────────────────── */
const app = express();
app.use((req, _res, next) => { req.db = db; next(); });
app.use('/api/ping-falso', (_req, res) => res.json({ ok: true }));   // para el T de no-interferencia
app.use('/', require('../src/routes/citas-web'));
app.use((_req, res) => res.status(404).json({ ok: false, error: 'Ruta no encontrada' }));
const server = app.listen(0);

const pedir = async (ruta) => {
  const port = server.address().port;
  const res  = await fetch(`http://127.0.0.1:${port}${ruta}`);
  const text = await res.text();
  return { status: res.status, text, tipo: res.headers.get('content-type') || '', cache: res.headers.get('cache-control') || '' };
};

(async () => {
  await new Promise(r => server.on('listening', r));

  console.log('\n🧪 El relay sirve la web de citas\n');

  console.log('── Una clínica activa ──');
  const p = await pedir('/cita/trialABC123');
  ok(p.status === 200, 'responde 200', `status ${p.status}`);
  ok(/text\/html/.test(p.tipo), 'y es HTML', p.tipo);
  ok(p.text.includes('CLINICA DE PRUEBA NORTE'), 'sale el nombre real de la clínica');

  const quedan = [...new Set(p.text.match(/\{\{[A-Z0-9_]+\}\}/g) || [])];
  ok(quedan.length === 0,
    'NINGÚN marcador se queda sin sustituir',
    'quedan: ' + quedan.join(', '));

  ok(p.text.includes('675565440'),
    'el teléfono de la clínica llega a la página',
    'sin él, el paciente no tiene a quién llamar si la reserva falla');

  console.log('\n── Los recursos, en ruta fija y absoluta ──');
  ok(!/(href|src)="css\//.test(p.text) && !/(href|src)="js\//.test(p.text),
    'no queda ninguna referencia RELATIVA a css/ o js/',
    'en /cita/:id una ruta relativa se resolvería contra la raíz y la página saldría sin estilos');
  ok(p.text.includes('/cita-assets/css/styles.css'), 'el CSS apunta a /cita-assets/');
  ok(p.text.includes('/cita-assets/js/main.js'),     'y el JS también');

  const css = await pedir('/cita-assets/css/styles.css');
  ok(css.status === 200, 'el CSS se sirve de verdad', `status ${css.status}`);
  ok(/max-age=\d+/.test(css.cache), 'y va cacheado — es lo que pesa y se repite en cada visita', css.cache);

  console.log('\n── Lo que NO se puede servir ──');
  for (const ruta of ['/cita-assets/cita.html', '/cita-assets/gestionar.html']) {
    const r = await pedir(ruta);
    ok(r.status === 404, `${ruta} NO se sirve`,
      'la plantilla cruda lleva los marcadores sin sustituir a la vista');
  }

  console.log('\n── Clínica inexistente y clínica cancelada ──');
  const no = await pedir('/cita/noexisteXXXX');
  ok(no.status === 404, 'una clínica que no existe da 404', `status ${no.status}`);
  ok(/text\/html/.test(no.tipo),
    'y el 404 es una página legible, no el JSON del 404 global',
    'lo pide el plan de pruebas del estudio: «404 y no un error feo»');

  const cancelada = await pedir('/cita/canceladaXY');
  ok(cancelada.status === 404,
    'una clínica con activa=0 también da 404',
    'es la puerta que cierra la web al cancelar la suscripción (punto 26)');

  console.log('\n── Es una web de prueba, y se dice ──');
  ok(/noindex/.test(p.text),
    'lleva noindex: es un enlace para verlo funcionar, no una web que deba salir en Google');
  ok(/tu propio dominio/i.test(p.text),
    'y avisa de que con la suscripción tendrá su propio dominio');

  console.log('\n── No estorba a la API ──');
  const api = await pedir('/api/ping-falso');
  ok(api.status === 200,
    'las rutas /api siguen respondiendo con la web montada en /',
    'servir páginas no puede interponerse en las agendas ni en las reservas');
  ok(p.cache.includes('no-cache'),
    'la página no se cachea: el horario cambia y una copia vieja enseñaría huecos que ya no existen',
    p.cache);

  console.log(`\n${pasados} pasados, ${fallados} fallados\n`);

  /* ⚠️ NO se llama a `process.exit`, y esta es la parte importante del fichero.
   *
   * La primera versión de esta prueba SÍ lo llamaba, con un `setTimeout` de 50 ms de margen —que
   * es el remedio que `docs/pendientes_proxima_compilacion.md` (punto 27) propone extender a las
   * otras 17 pruebas—. Resultado, medido el 20-09-2026: **19 comprobaciones en verde y el proceso
   * abortando igual**:
   *
   *     Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76
   *
   * O sea que el margen NO es el arreglo. El problema es llamar a `process.exit` mientras libuv
   * todavía está cerrando handles: matar el proceso a mitad de esa operación es lo que dispara la
   * assertion, y un temporizador más largo solo cambia la probabilidad.
   *
   * Lo correcto es **no forzar la salida**: se fija el código y el proceso termina solo cuando no
   * le quedan handles vivos. Si algo quedara abierto, el proceso se colgaría — y eso es preferible
   * y más honesto que abortar en verde, porque un cuelgue se ve y se diagnostica.
   */
  process.exitCode = fallados ? 1 : 0;
  try { db.close(); } catch (_) {}
  try { fs.unlinkSync(FICHERO); } catch (_) {}
  server.close();
})();
