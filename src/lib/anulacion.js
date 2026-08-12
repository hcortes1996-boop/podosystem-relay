'use strict';
/**
 * anulacion.js — Token y plazo para que el paciente anule su cita desde la web.
 *
 * Sub-pieza 8.20. Diseño completo en el repo del PC:
 * `docs/cancelacion_paciente_diseno.md` §3.1 y §3.2.
 *
 * Dos decisiones que gobiernan todo lo demás:
 *
 * 1. EL TOKEN NO ES EL ID DE LA RESERVA. `res_xxxxxxxxxx` se genera con 10
 *    caracteres y no está pensado para ser secreto — viaja en respuestas, en logs
 *    y en el panel. Con un identificador adivinable, cualquiera podría anular citas
 *    ajenas probando combinaciones. El token va aparte, con 32 caracteres, y en la
 *    base se guarda SOLO su hash: si alguien se llevara el fichero del relay no
 *    podría anular nada.
 *
 * 2. EL PLAZO SE VALIDA EN EL SERVIDOR, no en la página. La página puede esconder
 *    el botón, pero quien manda es esto. Y el cálculo va en la zona horaria de la
 *    clínica (`recordatorios_config.zonaHoraria`, por defecto Europe/Madrid), no en
 *    UTC ni en la del móvil del paciente: un paciente de vacaciones en Canarias
 *    tendría dos horas de diferencia y el plazo saldría mal.
 *
 * Tests: scripts/test_anulacion.js
 */
const crypto = require('crypto');

/** Horas de antelación por debajo de las cuales la web ya no deja anular. */
const PLAZO_HORAS = 24;

/**
 * Token en claro para el enlace. 32 caracteres de base64url — 192 bits de entropía.
 * Probar tokens al azar es inviable, y además hay límite de peticiones por IP.
 */
function generarToken() {
  return crypto.randomBytes(24).toString('base64url').slice(0, 32);
}

/** Lo único que se guarda en la base. */
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

/**
 * Minutos que faltan para la cita, contados en la zona horaria de la clínica.
 *
 * `fecha` es 'YYYY-MM-DD' y `hora` 'HH:MM', ambas en hora local de la clínica. Para
 * saber a qué instante corresponden hay que resolver el desfase de esa zona EN ESA
 * FECHA — no vale un desfase fijo, porque cambia con el horario de verano. Si no se
 * tiene en cuenta, dos veces al año el plazo se calcularía con una hora de error.
 */
function minutosHastaLaCita(fecha, hora, zonaHoraria = 'Europe/Madrid', ahora = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fecha || '')) || !/^\d{1,2}:\d{2}$/.test(String(hora || ''))) {
    return null;
  }
  // Instante provisional interpretando la hora local como si fuera UTC.
  const comoUTC = new Date(`${fecha}T${String(hora).padStart(5, '0')}:00Z`);
  if (isNaN(comoUTC)) return null;

  // Desfase real de la zona en esa fecha: se compara cómo formatea ese instante la
  // zona de la clínica contra UTC. La diferencia es el offset vigente ese día.
  let desfaseMin = 0;
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: zonaHoraria || 'Europe/Madrid',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
    const p = Object.fromEntries(fmt.formatToParts(comoUTC).map(x => [x.type, x.value]));
    const enZona = Date.UTC(+p.year, +p.month - 1, +p.day,
                            +p.hour % 24, +p.minute);
    desfaseMin = (enZona - comoUTC.getTime()) / 60000;
  } catch (_) {
    desfaseMin = 0;   // zona desconocida: se trata como UTC, mejor que reventar
  }

  const instanteReal = comoUTC.getTime() - desfaseMin * 60000;
  return Math.round((instanteReal - ahora.getTime()) / 60000);
}

/**
 * ¿Se puede anular desde la web?
 *
 * Devuelve `{ permitido, motivo, minutos }`. Los motivos son los que la página tiene
 * que saber distinguir para decir algo útil en vez de un error genérico:
 *   'ok'          — dentro de plazo
 *   'fuera_plazo' — quedan menos de PLAZO_HORAS: hay que llamar a la clínica
 *   'pasada'      — la cita ya ocurrió
 *   'fecha_invalida'
 */
function puedeAnular(reserva, zonaHoraria = 'Europe/Madrid', ahora = new Date()) {
  const minutos = minutosHastaLaCita(reserva?.fecha, reserva?.hora, zonaHoraria, ahora);
  if (minutos === null) return { permitido: false, motivo: 'fecha_invalida', minutos: null };
  if (minutos <= 0) return { permitido: false, motivo: 'pasada', minutos };
  if (minutos < PLAZO_HORAS * 60) return { permitido: false, motivo: 'fuera_plazo', minutos };
  return { permitido: true, motivo: 'ok', minutos };
}

/**
 * Lo que se le enseña al paciente. NUNCA su teléfono ni su email completos: el
 * enlace puede acabar reenviado a un grupo de familia, y quien lo abra no tiene por
 * qué ver los datos de contacto de nadie. El nombre sí, para que sepa que es su cita.
 */
function vistaPublica(reserva, clinica, estadoPlazo) {
  return {
    fecha: reserva.fecha,
    hora: reserva.hora,
    duracion: reserva.duracion,
    nombre: reserva.nombre,
    motivo: reserva.motivo || null,
    estado: reserva.estado,
    anulada: reserva.estado === 'cancelada',
    canceladaPor: reserva.canceladaPor || null,
    clinica: {
      nombre: clinica?.nombre || 'la clínica',
      telefono: clinica?.telefono || null,
    },
    plazo: {
      permitido: estadoPlazo.permitido,
      motivo: estadoPlazo.motivo,
      horasAntelacion: PLAZO_HORAS,
    },
  };
}

module.exports = {
  PLAZO_HORAS,
  generarToken,
  hashToken,
  minutosHastaLaCita,
  puedeAnular,
  vistaPublica,
};
