'use strict';
/**
 * oferta_hueco.js — El enlace «La quiero» de la lista de espera (Fase 2, 25-10-2026).
 *
 * Diseño completo en el repo del PC: `docs/lista_espera_fase2_diseno.md`.
 *
 * Cuando se anula una cita y la clínica la ofrece a la lista de espera, el PC crea aquí una
 * OFERTA para un paciente concreto y le manda el enlace por WhatsApp. El paciente lo abre y
 * acepta o rechaza. Quien decide si la aceptación vale es el relay, en una transacción: así el
 * hueco no se lo pueden quedar dos personas aunque el PC esté apagado.
 *
 * Tres reglas, las mismas que el enlace de anulación (`anulacion.js`):
 *   · En la base solo va el HASH del token.
 *   · El plazo lo decide el servidor (`venceEn`, un instante absoluto), no la página.
 *   · «No existe» y «caducado» responden igual para quien no tiene el token.
 *
 * Y una propia: **abrir el enlace no acepta nada**. La vista previa de WhatsApp hace GET de la
 * dirección; si el GET aceptara, el robot se quedaría el hueco por el paciente.
 *
 * Tests: scripts/test_oferta_hueco.js (lógica) y scripts/test_oferta_hueco_e2e.js (HTTP).
 */
const { minutosHastaLaCita } = require('./anulacion');

/** Lo que el paciente puede elegir al apuntarse desde la web. */
const FRANJAS = ['manana', 'tarde', 'dia'];

function normalizarFranja(v) {
  const s = String(v || '').trim().toLowerCase().replace('ñ', 'n');
  return FRANJAS.includes(s) ? s : null;
}

const ESTADOS = ['abierta', 'aceptada', 'rechazada', 'caducada', 'retirada'];

/** Solo el nombre de pila: el enlace puede acabar reenviado y no tiene por qué llevar apellidos. */
function nombreDePila(nombre) {
  const p = String(nombre || '').trim().split(/\s+/)[0] || '';
  return p.slice(0, 40);
}

const esFecha = (f) => /^\d{4}-\d{2}-\d{2}$/.test(String(f || ''));
const esHora  = (h) => /^\d{1,2}:\d{2}$/.test(String(h || ''));

/**
 * Valida lo que manda el PC al crear una oferta. Devuelve `{ ok, datos }` o `{ ok:false, error }`.
 * Los ids de las citas son del PC (números o textos): se guardan como texto.
 */
function validarNuevaOferta(b, ahora = new Date()) {
  if (!b || typeof b !== 'object') return { ok: false, error: 'Faltan datos' };
  const huecoCitaId     = String(b.huecoCitaId ?? '').trim();
  const candidatoCitaId = String(b.candidatoCitaId ?? '').trim();
  if (!huecoCitaId || !candidatoCitaId) return { ok: false, error: 'Faltan las citas' };
  if (huecoCitaId === candidatoCitaId) return { ok: false, error: 'El hueco y la cita del candidato son la misma' };
  if (!esFecha(b.fecha) || !esHora(b.hora)) return { ok: false, error: 'Fecha u hora del hueco no válidas' };
  if (!esFecha(b.citaActualFecha) || !esHora(b.citaActualHora)) return { ok: false, error: 'Fecha u hora de la cita actual no válidas' };
  const duracion = Number.isInteger(b.duracion) && b.duracion > 0 && b.duracion <= 480 ? b.duracion : 30;
  const vence = new Date(b.venceEn);
  if (isNaN(vence)) return { ok: false, error: 'Plazo no válido' };
  if (vence <= ahora) return { ok: false, error: 'El plazo ya ha vencido' };
  // Un plazo de más de una semana es un error del PC, no una decisión de la clínica.
  if (vence - ahora > 7 * 86400000) return { ok: false, error: 'Plazo demasiado largo' };
  const nombrePila = nombreDePila(b.nombre ?? b.nombrePila);
  if (!nombrePila) return { ok: false, error: 'Falta el nombre' };
  return {
    ok: true,
    datos: {
      huecoCitaId, candidatoCitaId,
      fecha: b.fecha, hora: b.hora, duracion,
      podologoId: b.podologoId ? String(b.podologoId) : null,
      nombrePila,
      citaActualFecha: b.citaActualFecha, citaActualHora: b.citaActualHora,
      venceEn: vence.toISOString(),
    },
  };
}

/** El estado de verdad: una oferta «abierta» con el plazo pasado está caducada aunque nadie lo haya escrito. */
function estadoEfectivo(oferta, ahora = new Date()) {
  if (!oferta) return null;
  if (oferta.estado === 'abierta' && new Date(oferta.venceEn) <= ahora) return 'caducada';
  return oferta.estado;
}

/**
 * ¿Puede el paciente responder ahora? `{ permitido, motivo }`, con motivo:
 *   'ok' · 'aceptada' · 'rechazada' · 'caducada' · 'retirada' · 'pasada'
 * 'pasada' = el hueco ya ha empezado: aceptarlo no tendría sentido aunque siga en plazo.
 */
function puedeResponder(oferta, zonaHoraria = 'Europe/Madrid', ahora = new Date()) {
  const estado = estadoEfectivo(oferta, ahora);
  if (estado !== 'abierta') return { permitido: false, motivo: estado || 'caducada' };
  const min = minutosHastaLaCita(oferta.fecha, oferta.hora, zonaHoraria, ahora);
  if (min === null || min <= 0) return { permitido: false, motivo: 'pasada' };
  return { permitido: true, motivo: 'ok' };
}

/** Lo que ve el paciente. Ni teléfono ni apellidos: solo lo necesario para decidir. */
function vistaPublica(oferta, clinica, respuesta) {
  return {
    nombre: oferta.nombrePila,
    hueco: { fecha: oferta.fecha, hora: oferta.hora, duracion: oferta.duracion },
    citaActual: { fecha: oferta.citaActualFecha, hora: oferta.citaActualHora },
    venceEn: oferta.venceEn,
    estado: respuesta.motivo === 'ok' ? 'abierta' : respuesta.motivo,
    puedeResponder: respuesta.permitido,
    clinica: { nombre: clinica?.nombre || 'la clínica', telefono: clinica?.telefono || null },
  };
}

module.exports = {
  FRANJAS, ESTADOS,
  normalizarFranja, nombreDePila, validarNuevaOferta,
  estadoEfectivo, puedeResponder, vistaPublica,
};
