'use strict';
/**
 * veto_web.js — Huellas de los pacientes vetados en la reserva online.
 *
 * Sub-pieza 8.20, bloque D, paso 13. **La pieza más delicada de todo el encargo**:
 * es lo único que puede dejar a un paciente sin poder pedir cita.
 *
 * ── Por qué NO se veta el teléfono a secas ────────────────────────────────────
 *
 * Medido sobre la base real el 15-08-2026: **364 teléfonos los comparten varias
 * fichas**, y afectan a **801 fichas — el 14,7 % de la base**. El peor caso son
 * SEIS fichas colgando de un fijo:
 *
 *   955665459 → tres generaciones de la misma familia
 *
 * Vetar ese número dejaría a seis personas sin reservar online por lo que hizo una.
 * Por eso la huella lleva **teléfono + nombre**: la madre que comparte el fijo con
 * su hijo vetado no se entera de nada.
 *
 * ── Por qué se manda un hash y no el nombre ───────────────────────────────────
 *
 * Las 5.458 fichas viven SOLO en el PC. El relay está en Railway y no tiene ninguna;
 * subir nombres de pacientes allí para poder vetarlos empeoraría la privacidad a lo
 * grande a cambio de muy poco. Se sube un hash: el relay puede comparar, pero no
 * puede leer a quién veta ni reconstruir la lista de pacientes de la clínica.
 *
 * ── Lo que esto NO es ─────────────────────────────────────────────────────────
 *
 * **Un freno, no una cerradura.** Quien escriba su nombre de otra forma pasará. Se
 * asume a propósito: el coste de que un reincidente cuele una reserva es que alguien
 * la ve en el panel; el de bloquear a quien no lo merece es que se queda sin cita y
 * probablemente ni llama. Los dos errores no valen lo mismo.
 *
 * Se generan VARIAS huellas por paciente para que una errata no lo salte:
 *   · el nombre normalizado con las palabras ORDENADAS — así «Juan Pérez Gil» y
 *     «Pérez Gil, Juan» dan la misma huella (medido: escribir los apellidos primero
 *     es un escenario real);
 *   · el mismo nombre en su forma FONÉTICA — cubre b/v, ll/y, h muda, c/z/s, g/j.
 *
 * ⚠️ ESTE FICHERO ESTÁ DUPLICADO en el repositorio del PC
 * (`Clinica_Francisco_Roman/veto_web.js` (el del PC)). Tiene que ser IDÉNTICO: el PC calcula
 * las huellas y el relay las compara, y si divergen el veto deja de funcionar sin
 * que nadie se entere. Los dos repos tienen un test con los MISMOS vectores fijos
 * (`VECTORES`, abajo): si alguien toca el algoritmo, los dos tests fallan a la vez.
 */

const crypto = require('crypto');

/** Los 9 últimos dígitos. Igual que `normalizarTelefono` de emparejar_paciente.js. */
function normalizarTelefono(valor) {
  const solo = String(valor || '').replace(/[^0-9]/g, '');
  const sin34 = solo.replace(/^0034/, '').replace(/^34/, '');
  return sin34.slice(-9);
}

/** Minúsculas, sin tildes, sin puntuación, espacios colapsados. */
function normalizarNombre(valor) {
  return String(valor || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Plegado fonético castellano. Mismas reglas que `fonetico` de emparejar_paciente.js
 * — si allí cambian, aquí también, o el veto dejará de reconocer lo que el
 * emparejador sí reconoce.
 */
function fonetico(valor) {
  return normalizarNombre(valor)
    .replace(/h/g, '')
    .replace(/v/g, 'b')
    .replace(/ll/g, 'y')
    .replace(/z/g, 's').replace(/c([eiy])/g, 's$1').replace(/c/g, 'k').replace(/qu/g, 'k')
    .replace(/g([eiy])/g, 'j$1')
    .replace(/(.)\1+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Palabras ordenadas: «Pérez Gil, Juan» y «Juan Pérez Gil» dan lo mismo. */
function ordenar(texto) {
  return String(texto || '').split(' ').filter(Boolean).sort().join(' ');
}

function sha(texto) {
  return crypto.createHash('sha256').update(texto, 'utf8').digest('hex').slice(0, 32);
}

/**
 * Las huellas de un par (teléfono, nombre). Devuelve [] si falta cualquiera de los
 * dos: sin los dos datos no se veta a nadie — un veto a ciegas es exactamente lo
 * que hay que evitar.
 */
function huellas(telefono, nombre) {
  const tel = normalizarTelefono(telefono);
  const nom = normalizarNombre(nombre);
  if (tel.length !== 9 || !nom) return [];

  const salida = new Set();
  salida.add(sha(`${tel}|${ordenar(nom)}`));
  const fon = ordenar(fonetico(nombre));
  if (fon) salida.add(sha(`${tel}|${fon}`));
  return [...salida];
}

/**
 * Todas las huellas de una ficha vetada: un paciente puede tener varios teléfonos
 * (el suyo, el móvil, y los aprendidos de reservas web), y por cualquiera de ellos
 * puede volver a reservar.
 */
function huellasDeFicha(ficha) {
  if (!ficha) return [];
  const nombre = [ficha.nombre, ficha.apellidos].filter(Boolean).join(' ');
  const tels = [ficha.telefono, ficha.movil, ficha.telefono2, ...(ficha.telefonosWeb || [])];
  const salida = new Set();
  for (const t of tels) for (const h of huellas(t, nombre)) salida.add(h);
  return [...salida];
}

/** ¿Está vetada esta reserva? `lista` es el array de huellas que tiene el relay. */
function estaVetada(lista, telefono, nombre) {
  if (!Array.isArray(lista) || !lista.length) return false;
  const mias = huellas(telefono, nombre);
  if (!mias.length) return false;
  const set = lista instanceof Set ? lista : new Set(lista);
  return mias.some(h => set.has(h));
}

/**
 * Vectores fijos. **El mismo bloque existe en el repositorio del relay.** Si los dos
 * lados dejan de dar esto, el veto se ha roto en silencio y los dos tests lo dicen.
 */
const VECTORES = [
  { telefono: '600111222',      nombre: 'Juan Pérez Gil' },
  { telefono: '+34 600 111 222', nombre: 'PEREZ GIL, JUAN' },   // igual que el anterior
  { telefono: '955665459',      nombre: 'Teresa Marchán Jiménez' },
  { telefono: '675565440',      nombre: 'José María Bayo Gómez' },
];

module.exports = {
  huellas, huellasDeFicha, estaVetada,
  normalizarTelefono, normalizarNombre, fonetico, ordenar,
  VECTORES,
};
