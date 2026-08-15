'use strict';
/**
 * aviso-anulacion.js — Avisa a la clínica de lo que el paciente ha hecho con su cita.
 *
 * Sub-pieza 8.20, paso 10. Reutiliza `expo_push_tokens` y `enviarPushNotification`,
 * que ya existían para los recordatorios: aquí solo se añade el disparo.
 *
 * Dos avisos DISTINTOS, y la diferencia importa más que el aviso en sí:
 *
 *   · ANULADA (>24 h)  — informativo. El hueco ya está libre; no hay nada que hacer.
 *   · INTENTO (<24 h)  — urgente. La cita SIGUE EN PIE y el paciente probablemente no
 *                        viene. Alguien tiene que llamarle. Si este se confunde con el
 *                        otro, se pierde justo la información que más valía.
 *
 * Tres reglas:
 *   1. NUNCA rompe la anulación. El paciente ya ha hecho su parte; que Expo esté caído
 *      no puede devolverle un error. Todo va envuelto y se dispara sin esperar.
 *   2. Solo avisa de lo que hace EL PACIENTE. Lo que cancela la clínica no se notifica:
 *      lo acaba de hacer ella.
 *   3. No incluye teléfono ni email del paciente. Una push viaja por Expo y se ve en la
 *      pantalla bloqueada del móvil.
 */

const { enviarPushNotification } = require('./recordatorios');

/** En tests no se sale a la red: se apunta lo que se habría enviado. */
const enviados = [];
const enTest = () => process.env.NODE_ENV === 'test';

/** «2026-08-20» + «17:30» → «20/08 a las 17:30». */
function cuando(fecha, hora) {
  const f = String(fecha || '');
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(f);
  const dia = dm ? `${dm[3]}/${dm[2]}` : f;
  return hora ? `${dia} a las ${hora}` : dia;
}

/** El nombre a secas. Sin teléfono: esto se lee en una pantalla bloqueada. */
function quien(reserva) {
  const n = String(reserva?.nombre || '').trim();
  return n || 'Un paciente';
}

function construirPayload({ reserva, tipo, motivo }) {
  const cita = cuando(reserva?.fecha, reserva?.hora);
  const razon = String(motivo || '').trim();
  const coletilla = razon ? ` — «${razon.slice(0, 80)}»` : '';

  if (tipo === 'intento') {
    return {
      title: '🔴 Intento de anular fuera de plazo',
      body: `${quien(reserva)} ha intentado anular su cita del ${cita}${coletilla}. `
          + 'La cita SIGUE en la agenda: llámele para confirmar si viene.',
      data: {
        type: 'intento_anulacion',
        reservaId: reserva?.id || null,
        fecha: reserva?.fecha || null,
        hora: reserva?.hora || null,
        urgente: true,
      },
    };
  }

  return {
    title: '❌ Cita anulada por el paciente',
    body: `${quien(reserva)} ha anulado su cita del ${cita}${coletilla}. El hueco queda libre.`,
    data: {
      type: 'anulacion_web',
      reservaId: reserva?.id || null,
      fecha: reserva?.fecha || null,
      hora: reserva?.hora || null,
      urgente: false,
    },
  };
}

/**
 * Avisa a los móviles de la clínica. No espera respuesta y no lanza nunca.
 *
 * @param {object} db          — conexión better-sqlite3
 * @param {object} evento      — { reserva, tipo: 'anulada'|'intento', motivo }
 * @returns {Promise<{ok:boolean, tokens:number, motivo?:string}>}
 */
async function avisarClinica(db, { reserva, tipo, motivo } = {}) {
  try {
    if (!db || !reserva?.clinicaId) return { ok: false, tokens: 0, motivo: 'sin-reserva' };

    let tokens = [];
    try {
      tokens = db.prepare('SELECT expoPushToken FROM expo_push_tokens WHERE clinicaId = ?')
        .all(reserva.clinicaId).map(r => r.expoPushToken).filter(Boolean);
    } catch (_) {
      // La tabla puede no existir en una base antigua. No es motivo para romper nada.
      return { ok: false, tokens: 0, motivo: 'sin-tabla' };
    }

    // Sin móviles registrados no hay nada que hacer, y no es un error: la clínica
    // verá la anulación igual en la agenda del PC, que es el aviso imprescindible.
    if (!tokens.length) return { ok: true, tokens: 0, motivo: 'sin-moviles' };

    const payload = construirPayload({ reserva, tipo, motivo });

    if (enTest()) {
      enviados.push({ clinicaId: reserva.clinicaId, tokens, payload });
      return { ok: true, tokens: tokens.length, motivo: 'test' };
    }

    const res = await enviarPushNotification(tokens, payload);
    if (!res.ok) {
      console.warn(`⚠️ [aviso-anulacion] push FAIL clinica=${reserva.clinicaId} `
                 + `err=${res.error || res.statusCode}`);
    }
    try {
      db.prepare("UPDATE expo_push_tokens SET lastUsedAt = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE clinicaId = ?")
        .run(reserva.clinicaId);
    } catch (_) {}

    return { ok: !!res.ok, tokens: tokens.length };
  } catch (e) {
    // Aquí no se relanza jamás: este aviso es un extra sobre una anulación que ya
    // se ha guardado. Fallar aquí no puede deshacerla ni ensuciar la respuesta.
    console.error('❌ [aviso-anulacion]', e.message);
    return { ok: false, tokens: 0, motivo: 'excepcion' };
  }
}

/**
 * Como `avisarClinica` pero sin esperarla. Es la forma en que la llama la ruta: el
 * paciente no debe esperar a Expo para que su anulación quede confirmada.
 */
function avisarSinEsperar(db, evento) {
  try {
    const p = avisarClinica(db, evento);
    if (p && typeof p.catch === 'function') p.catch(() => {});
    return p;
  } catch (_) {
    return Promise.resolve({ ok: false, tokens: 0, motivo: 'excepcion' });
  }
}

module.exports = { avisarClinica, avisarSinEsperar };
module.exports.__test__ = { enviados, construirPayload, cuando, quien };
