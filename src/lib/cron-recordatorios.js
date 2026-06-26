/**
 * lib/cron-recordatorios.js — Pieza 6.0 WhatsApp Cloud (cron)
 *
 * setInterval cada 15 min. En cada tick:
 *   1. Recorre clinicas que tienen recordatorios_config + al menos 1 expo_push_token.
 *   2. Verifica si la hora local del cliente (segun zonaHoraria) coincide con horaEnvio.
 *   3. Verifica que no hubo envio HOY para esa clinica (idempotencia).
 *   4. Verifica que agenda_snapshot es reciente (<26h).
 *   5. Calcula recordatorios (lib/recordatorios.calcularRecordatorios).
 *   6. Si hay >=1 cita: envia push notification a todos los tokens registrados.
 *   7. Registra en recordatorios_sent_log.
 */
'use strict';

const { calcularRecordatorios, enviarPushNotification } = require('./recordatorios');
const crypto = require('crypto');

const INTERVAL_MS    = 15 * 60 * 1000;       // 15 min
const SNAPSHOT_MAX_AGE_MS = 26 * 60 * 60 * 1000; // 26 horas

function genId(len = 12) {
  return crypto.randomBytes(len).toString('base64url').slice(0, len);
}

/**
 * Devuelve la hora (0-23) en una zona horaria especifica para el moment now.
 */
function horaEnZona(now, zonaHoraria) {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: zonaHoraria || 'Europe/Madrid',
      hour: 'numeric', hour12: false,
    });
    return parseInt(fmt.format(now), 10);
  } catch (_) {
    // Fallback al servidor en UTC
    return now.getUTCHours();
  }
}

function fechaLocalEnZona(now, zonaHoraria) {
  try {
    const fmt = new Intl.DateTimeFormat('sv-SE', {
      timeZone: zonaHoraria || 'Europe/Madrid',
      year: 'numeric', month: '2-digit', day: '2-digit',
    });
    return fmt.format(now); // 'YYYY-MM-DD'
  } catch (_) {
    return now.toISOString().slice(0, 10);
  }
}

/**
 * Ejecuta un tick del cron (una pasada por todas las clinicas que cumplen condicion).
 * Exportado para testeo (no llama a Expo cuando opts.silencioso).
 */
async function tickRecordatorios(db, opts = {}) {
  const ahora = opts.ahora || new Date();
  const log   = opts.silencioso ? () => {} : (msg) => console.log(msg);
  const skipPush = !!opts.skipPush; // tests no llaman Expo

  const configs = db.prepare(`
    SELECT c.clinicaId, c.diasAntelacion, c.recordarMismoDia, c.reglaViernes,
           c.horaEnvio, c.zonaHoraria
    FROM recordatorios_config c
    WHERE EXISTS (SELECT 1 FROM expo_push_tokens t WHERE t.clinicaId = c.clinicaId)
  `).all();

  const procesadas = [];
  for (const cfg of configs) {
    const hLocal     = horaEnZona(ahora, cfg.zonaHoraria);
    const fechaLocal = fechaLocalEnZona(ahora, cfg.zonaHoraria);
    if (hLocal !== cfg.horaEnvio) continue;

    // Idempotencia: ya enviado hoy?
    const yaEnviado = db.prepare(
      'SELECT id FROM recordatorios_sent_log WHERE clinicaId = ? AND fechaObjetivo = ?'
    ).get(cfg.clinicaId, fechaLocal);
    if (yaEnviado) { procesadas.push({ clinicaId: cfg.clinicaId, accion: 'skip-already-sent' }); continue; }

    // Verificar snapshot reciente
    const snapshot = db.prepare(
      'SELECT citas, updatedAt FROM agenda_snapshot WHERE clinicaId = ?'
    ).get(cfg.clinicaId);
    if (!snapshot) { procesadas.push({ clinicaId: cfg.clinicaId, accion: 'skip-no-snapshot' }); continue; }
    const ageMs = ahora.getTime() - new Date(snapshot.updatedAt).getTime();
    if (ageMs > SNAPSHOT_MAX_AGE_MS) { procesadas.push({ clinicaId: cfg.clinicaId, accion: 'skip-snapshot-stale' }); continue; }

    let citas = [];
    try { citas = JSON.parse(snapshot.citas || '[]'); } catch (_) {}

    const pendientes = calcularRecordatorios(citas, {
      diasAntelacion:   cfg.diasAntelacion,
      recordarMismoDia: !!cfg.recordarMismoDia,
      reglaViernes:     !!cfg.reglaViernes,
    }, ahora);

    if (!pendientes.length) {
      procesadas.push({ clinicaId: cfg.clinicaId, accion: 'skip-zero-pendientes' });
      // Registrar log igual para no reintentar hoy
      db.prepare(
        'INSERT INTO recordatorios_sent_log (id, clinicaId, fechaObjetivo, count, citasIds) VALUES (?,?,?,?,?)'
      ).run(genId(), cfg.clinicaId, fechaLocal, 0, JSON.stringify([]));
      continue;
    }

    const tokens = db.prepare(
      'SELECT expoPushToken FROM expo_push_tokens WHERE clinicaId = ?'
    ).all(cfg.clinicaId).map(r => r.expoPushToken);

    const payload = {
      title: 'PodoSystem',
      body: `📅 Tienes ${pendientes.length} cita${pendientes.length>1?'s':''} que recordar por WhatsApp`,
      data: { type: 'recordatorios', fecha: fechaLocal, count: pendientes.length },
    };

    let pushResult = { ok: true, skipped: true };
    if (!skipPush) {
      pushResult = await enviarPushNotification(tokens, payload);
      if (!pushResult.ok) log(`[cron-recordatorios] Push FAIL clinica=${cfg.clinicaId} err=${pushResult.error || pushResult.statusCode}`);
    }

    // Registrar en log (independientemente del resultado push — evita reintentos infinitos)
    db.prepare(
      'INSERT INTO recordatorios_sent_log (id, clinicaId, fechaObjetivo, count, citasIds) VALUES (?,?,?,?,?)'
    ).run(genId(), cfg.clinicaId, fechaLocal, pendientes.length, JSON.stringify(pendientes.map(c => c.id).filter(Boolean)));

    // Actualizar lastUsedAt en tokens
    db.prepare("UPDATE expo_push_tokens SET lastUsedAt = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE clinicaId = ?")
      .run(cfg.clinicaId);

    procesadas.push({ clinicaId: cfg.clinicaId, accion: 'enviado', count: pendientes.length, tokens: tokens.length, push: pushResult });
    log(`[cron-recordatorios] ✓ clinica=${cfg.clinicaId} count=${pendientes.length} tokens=${tokens.length}`);
  }

  return procesadas;
}

/**
 * Arranca el cron periodico. Exportado para llamada desde index.js.
 */
function iniciarCronRecordatorios(db) {
  setInterval(() => {
    tickRecordatorios(db).catch(e => console.error('[cron-recordatorios] tick error:', e.message));
  }, INTERVAL_MS);
  console.log(`[cron-recordatorios] arrancado, intervalo=${INTERVAL_MS/60000}min`);
}

module.exports = { iniciarCronRecordatorios, tickRecordatorios, horaEnZona, fechaLocalEnZona, INTERVAL_MS, SNAPSHOT_MAX_AGE_MS };
