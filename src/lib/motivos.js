'use strict';
/**
 * motivos.js — a qué viene el paciente, y cuánto dura eso.
 *
 * ── Qué se pide ──────────────────────────────────────────────────────────────
 *
 * Petición de Germán, que ya trabaja así en Doctoralia: que el paciente elija a qué viene al
 * pedir cita, y que eso determine la duración. Hoy todas las citas web duran lo mismo —
 * `agendaConfig.duracionSlot`, un único número.
 *
 *     Consulta / Quiropodia ...... 20 min
 *     Estudio .................... 40 min
 *
 * Diseño completo en `docs/motivos_consulta_diseno.md`.
 *
 * ── La regla que no se relaja ────────────────────────────────────────────────
 *
 * > **La duración la decide el servidor, siempre.**
 *
 * El cliente manda **qué motivo**, nunca **cuántos minutos**. Si viniera del navegador, una
 * petición trucada reservaría 5 minutos y se colaría entre dos citas. Un motivo desconocido
 * cae a la duración por defecto de la clínica, **nunca a lo que diga el cliente**.
 *
 * ── Lo que cambia de fondo ───────────────────────────────────────────────────
 *
 * Hasta ahora «libre» era una propiedad del hueco. Ahora **depende del servicio**:
 *
 *     las 11:00 están LIBRES para una quiropodia de 20 min
 *                  y OCUPADAS para un estudio de 40
 *
 * Eso toca justo la aritmética que produjo 5 dobles citas reales en agosto de 2026, así que
 * cada pieza de aquí tiene su prueba y la reserva sigue siendo atómica.
 */

/**
 * Los de fábrica, para que una clínica recién dada de alta pueda reservar sin configurar
 * nada. Salen de lo que Germán ofrece hoy, que es el caso real que motiva esto.
 *
 * ⚠️ «Otro / No lo sé» importa más de lo que parece: **el paciente muchas veces no sabe a qué
 * viene**. Obligarle a clasificarse es fricción en el único formulario que trae citas. Tiene
 * que ser una opción digna, no un castigo — por eso va con la duración por defecto de la
 * clínica y no con la más corta.
 */
const MOTIVOS_FABRICA = [
  { id: 'consulta',  nombre: 'Consulta / Quiropodia', minutos: 20, activo: true },
  { id: 'estudio',   nombre: 'Estudio',               minutos: 40, activo: true },
  { id: 'revision',  nombre: 'Revisión',              minutos: 20, activo: true },
  { id: 'otro',      nombre: 'Otro / No lo sé',       minutos: null, activo: true },
];

const MIN_MINUTOS = 5;
const MAX_MINUTOS = 240;

const texto = (v, max) => String(v ?? '').trim().slice(0, max);

/**
 * Deja la lista en algo de lo que se pueda uno fiar: sin nombres vacíos, sin duraciones
 * absurdas, sin identificadores repetidos.
 *
 * Se aplica **al recibirla del PC**, no al usarla: si un catálogo mal formado llegara a la
 * base, cada consulta de disponibilidad tendría que defenderse de él.
 */
function normalizarMotivos(lista) {
  if (!Array.isArray(lista)) return null;
  const vistos = new Set();
  const salida = [];
  for (const m of lista) {
    if (!m || typeof m !== 'object') continue;
    const nombre = texto(m.nombre, 60);
    if (!nombre) continue;

    // Sin id utilizable se deriva del nombre: un catálogo escrito a mano no tiene por qué
    // traerlos, y rechazarlo por eso sería quisquilloso.
    let id = texto(m.id, 40).toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (!id) {
      id = nombre.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
                 .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    }
    if (!id || vistos.has(id)) continue;
    vistos.add(id);

    // `null` es legítimo y significa «la duración por defecto de la clínica».
    let minutos = null;
    if (m.minutos !== null && m.minutos !== undefined && m.minutos !== '') {
      const n = Math.round(Number(m.minutos));
      if (!Number.isFinite(n) || n < MIN_MINUTOS || n > MAX_MINUTOS) continue;
      minutos = n;
    }

    salida.push({ id, nombre, minutos, activo: m.activo !== false });
  }
  return salida.length ? salida : null;
}

/** El catálogo de una clínica: el suyo si lo tiene, y si no los de fábrica. */
function catalogoDe(cfg) {
  const propios = normalizarMotivos(cfg && cfg.motivos);
  return propios || MOTIVOS_FABRICA;
}

/** Lo que se le enseña al paciente: los activos, sin los minutos. */
function motivosPublicos(cfg) {
  // Los minutos NO se publican a propósito. No le dicen nada útil al paciente —él elige a qué
  // viene, no cuánto quiere estar— y publicarlos invita a probar si mandando otro número se
  // consigue otro hueco.
  return catalogoDe(cfg).filter(m => m.activo).map(m => ({ id: m.id, nombre: m.nombre }));
}

/**
 * Cuánto dura una cita de este motivo. **Es la única fuente de la duración.**
 *
 * @param {object} cfg       la `agenda_config` de la clínica
 * @param {string} motivoId  lo que mandó el cliente — puede ser cualquier cosa
 * @returns {number} minutos
 */
function duracionDeMotivo(cfg, motivoId) {
  const porDefecto = Number(cfg && cfg.duracionSlot) || 30;
  if (!motivoId) return porDefecto;

  const m = catalogoDe(cfg).find(x => x.id === String(motivoId).trim().toLowerCase());

  // Motivo desconocido, inactivo o sin minutos propios → la duración de la clínica. Nunca
  // lo que diga el cliente, y nunca un fallo: reservar tiene que seguir funcionando aunque
  // alguien mande basura en ese campo.
  if (!m || !m.activo || !m.minutos) return porDefecto;
  return m.minutos;
}

/** El nombre para enseñar y guardar, que es lo que verá la clínica en su agenda. */
function nombreDeMotivo(cfg, motivoId) {
  if (!motivoId) return null;
  const m = catalogoDe(cfg).find(x => x.id === String(motivoId).trim().toLowerCase());
  return m ? m.nombre : null;
}

module.exports = {
  MOTIVOS_FABRICA, normalizarMotivos, catalogoDe, motivosPublicos,
  duracionDeMotivo, nombreDeMotivo, MIN_MINUTOS, MAX_MINUTOS,
};
