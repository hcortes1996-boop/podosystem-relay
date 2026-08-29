#!/usr/bin/env node
'use strict';
/**
 * El motivo se pregunta ANTES que el profesional — y las tres salidas están cubiertas.
 *
 * ── Por qué existe ───────────────────────────────────────────────────────────
 *
 * Hasta ahora la web preguntaba primero con qué podólogo, y después a qué venía. Con
 * catálogos distintos por profesional eso deja al paciente elegir a alguien que no hace lo
 * que necesita, y enterarse al final —o peor, no enterarse: la rejilla le enseñaba huecos
 * de una persona que no le va a atender.
 *
 * El orden nuevo es **motivo → podólogo → calendario**, y tiene tres desenlaces. El que se
 * olvida siempre es el primero:
 *
 *   · nadie ofrece ese servicio → el teléfono de la clínica, que es lo único que le sirve
 *   · lo ofrece uno            → directo a su agenda, sin preguntar lo que solo tiene una
 *                                respuesta posible
 *   · lo ofrecen varios        → elige, pero solo entre los que pueden
 *
 * `cita.html` no tiene compilador ni linter —es una página suelta que se despliega tal
 * cual—, así que esto es lo único que mira si el flujo sigue siendo el que se diseñó.
 *
 *   node scripts/test_flujo_motivo_primero.js
 */
const fs = require('fs');
const path = require('path');

let pasados = 0, fallados = 0;
const ok = (cond, nombre, extra) => {
  if (cond) { pasados++; console.log('  ✅ ' + nombre); }
  else { fallados++; console.log('  ❌ ' + nombre + (extra ? '\n       → ' + extra : '')); }
};

const CITA = fs.readFileSync(path.join(__dirname, '..', 'web-template', 'cita.html'), 'utf8');

console.log('\n── Quién puede atender qué ──');
{
  // Se evalúa la función DE VERDAD, sacada del HTML. Reescribirla aquí probaría mi copia,
  // no la página que se despliega.
  const m = CITA.match(/function puedenAtender\(motivoId\) \{[\s\S]*?\n    \}/);
  ok(!!m, 'se encuentra puedenAtender() en cita.html');
  if (!m) { resumen(); return; }

  let podologos = [];
  // eslint-disable-next-line no-new-func
  const puedenAtender = new Function('getPodologos', `
    ${m[0].replace('function puedenAtender(motivoId) {', 'function puedenAtender(motivoId) {\n      const podologos = getPodologos();')}
    return puedenAtender;
  `)(() => podologos);

  const german = { id: 'german', atiende: null };                       // hereda: lo hace todo
  const ana    = { id: 'ana', atiende: ['quiropodia'] };                // solo quiropodias
  podologos = [german, ana];

  ok(puedenAtender('').length === 2,
    'sin motivo elegido salen los dos — es como funcionaba antes de que existieran los motivos');
  ok(puedenAtender('quiropodia').length === 2,
    'una quiropodia la hacen los dos');
  const bio = puedenAtender('biomecanica');
  ok(bio.length === 1 && bio[0].id === 'german',
    'la biomecánica solo Germán: Ana tiene lista propia y no está dentro',
    JSON.stringify(bio.map(p => p.id)));

  podologos = [ana];
  ok(puedenAtender('biomecanica').length === 0,
    'y si nadie lo ofrece, la lista queda vacía — ese es el caso que hay que saber contar');

  // El que hereda no puede quedarse fuera nunca: `atiende: null` significa «lo que ofrezca
  // la clínica», y la clínica ofrece todo lo que hay en el desplegable.
  podologos = [german];
  ok(puedenAtender('lo-que-sea').length === 1,
    'el que hereda atiende cualquier cosa del catálogo, incluida una que se añada mañana');
}

console.log('\n── Las tres salidas están escritas ──');
{
  ok(/motivo-sin-nadie/.test(CITA) && /CLINICA_TELEFONO_RAW/.test(CITA.split('motivo-sin-nadie')[1].slice(0, 600)),
    'cuando no lo atiende nadie, se le da el teléfono de la clínica');
  ok(/if \(lista\.length === 1\)[\s\S]{0,320}seleccionarPodologo\(lista\[0\]\)/.test(CITA),
    'cuando lo atiende uno solo, se salta la pregunta y se entra en su agenda');
  ok(/renderPodologoGrid\(lista\)/.test(CITA),
    'y cuando son varios, la parrilla se pinta con LOS QUE PUEDEN, no con todos');
}

console.log('\n── El motivo no se pregunta dos veces ──');
{
  ok(/motivoPreguntadoAntes\s*=\s*true/.test(CITA) &&
     /if \(motivoPreguntadoAntes\)\s*\{\s*wrap\.style\.display\s*=\s*'none'/.test(CITA),
    'contestado en el paso 0, el selector de encima del calendario se apaga');
  ok(/motivoId:\s*motivoSeleccionado/.test(CITA),
    'y la reserva sigue mandando el id del motivo — la duración la decide el servidor');
}

console.log('\n── Nada se lee antes de existir ──');
{
  // `let` no se puede leer antes de su línea. Hoy no revienta porque init() va al final del
  // fichero; eso es el orden del fichero, no una garantía. Si alguien mueve init() arriba,
  // la página se queda en blanco sin decir nada — y esto lo caza antes.
  for (const v of ['motivoSeleccionado', 'catalogoMotivos', 'motivoPreguntadoAntes', 'podologos']) {
    const decl = CITA.indexOf(`let ${v}`);
    const init = CITA.indexOf('(async function init()');
    ok(decl !== -1 && decl < init, `${v} se declara antes de que init() lo use`,
      `declaración en ${decl}, init en ${init}`);
  }
}

console.log('\n── Una clínica que no usa esto no lo nota ──');
{
  ok(/catalogoMotivos\s*=\s*\(data && Array\.isArray\(data\.motivos\)\)/.test(CITA),
    'si el relay no manda catálogo, la variable queda vacía en vez de romper');
  ok(/if \(!wrap \|\| !sel \|\| !catalogoMotivos\.length\) return false/.test(CITA),
    'y sin catálogo el paso 0 no se toca: la página funciona como el primer día');
}

function resumen() {
  console.log(`\n${fallados === 0 ? `✅ ${pasados} COMPROBACIONES EN VERDE` : `❌ ${fallados} FALLIDAS de ${pasados + fallados}`}\n`);
  process.exit(fallados === 0 ? 0 : 1);
}
resumen();
