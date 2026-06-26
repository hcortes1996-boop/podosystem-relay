/**
 * recordatorios.js — Pieza 6.0 WhatsApp Cloud
 *
 *   POST /api/push-tokens/register     (X-Api-Key) — APK registra Expo Push Token
 *   POST /api/recordatorios-config     (X-Api-Key) — PC sincroniza config
 *   GET  /api/recordatorios-snapshot   (X-Api-Key) — APK pide lista pendiente
 *   PUT  /api/recordatorios/:citaId/marcar (X-Api-Key) — APK marca como enviado
 */
'use strict';

const router = require('express').Router();
const auth   = require('../middleware/auth');
const crypto = require('crypto');
const { calcularRecordatorios } = require('../lib/recordatorios');

function genId(len = 12) {
  return crypto.randomBytes(len).toString('base64url').slice(0, len);
}

const PLATFORMS_VALID = ['android', 'ios', 'web'];

// ── APK registra su Expo Push Token ──────────────────────────────────────────
router.post('/push-tokens/register', auth, (req, res) => {
  const { expoPushToken, platform, deviceInfo } = req.body || {};
  if (!expoPushToken || typeof expoPushToken !== 'string') {
    return res.status(400).json({ ok: false, error: 'expoPushToken requerido' });
  }
  // Validacion formato basico (ExponentPushToken[xxx] o ExpoPushToken[xxx])
  if (!/^Exp(o|onent)PushToken\[[\w-]+\]$/.test(expoPushToken)) {
    return res.status(400).json({ ok: false, error: 'Formato Expo Push Token invalido' });
  }
  const plat = PLATFORMS_VALID.includes(platform) ? platform : 'android';
  const info = typeof deviceInfo === 'string' ? deviceInfo.slice(0, 500) : '';

  try {
    // Idempotencia: UNIQUE(clinicaId, expoPushToken) → INSERT OR REPLACE no aplica porque
    // queremos preservar registeredAt original. Usamos INSERT OR IGNORE + UPDATE lastUsed.
    req.db.prepare(
      'INSERT OR IGNORE INTO expo_push_tokens (id, clinicaId, expoPushToken, platform, deviceInfo) VALUES (?,?,?,?,?)'
    ).run(genId(), req.clinicaId, expoPushToken, plat, info);
    req.db.prepare(
      "UPDATE expo_push_tokens SET lastUsedAt = strftime('%Y-%m-%dT%H:%M:%fZ','now'), platform = ?, deviceInfo = ? WHERE clinicaId = ? AND expoPushToken = ?"
    ).run(plat, info, req.clinicaId, expoPushToken);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── PC sincroniza config de recordatorios ────────────────────────────────────
router.post('/recordatorios-config', auth, (req, res) => {
  const b = req.body || {};
  const diasAntelacion   = Math.max(0, Math.min(7, parseInt(b.diasAntelacion, 10) || 1));
  const recordarMismoDia = b.recordarMismoDia === false || b.recordarMismoDia === 0 ? 0 : 1;
  const reglaViernes     = b.reglaViernes     === false || b.reglaViernes     === 0 ? 0 : 1;
  const horaEnvio        = Math.max(0, Math.min(23, parseInt(b.horaEnvio, 10) || 20));
  const zonaHoraria      = typeof b.zonaHoraria === 'string' && b.zonaHoraria.length <= 64 ? b.zonaHoraria : 'Europe/Madrid';

  try {
    req.db.prepare(`
      INSERT INTO recordatorios_config (clinicaId, diasAntelacion, recordarMismoDia, reglaViernes, horaEnvio, zonaHoraria)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(clinicaId) DO UPDATE SET
        diasAntelacion   = excluded.diasAntelacion,
        recordarMismoDia = excluded.recordarMismoDia,
        reglaViernes     = excluded.reglaViernes,
        horaEnvio        = excluded.horaEnvio,
        zonaHoraria      = excluded.zonaHoraria,
        updatedAt        = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    `).run(req.clinicaId, diasAntelacion, recordarMismoDia, reglaViernes, horaEnvio, zonaHoraria);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── APK pide lista de recordatorios pendientes (modo remoto) ─────────────────
router.get('/recordatorios-snapshot', auth, (req, res) => {
  try {
    const cfg = req.db.prepare(
      'SELECT diasAntelacion, recordarMismoDia, reglaViernes FROM recordatorios_config WHERE clinicaId = ?'
    ).get(req.clinicaId) || { diasAntelacion: 1, recordarMismoDia: 1, reglaViernes: 1 };

    const snapshot = req.db.prepare(
      'SELECT citas FROM agenda_snapshot WHERE clinicaId = ?'
    ).get(req.clinicaId);
    if (!snapshot) return res.json({ ok: true, recordatorios: [] });

    let citas = [];
    try { citas = JSON.parse(snapshot.citas || '[]'); } catch (_) {}

    const pendientes = calcularRecordatorios(citas, {
      diasAntelacion:   cfg.diasAntelacion,
      recordarMismoDia: !!cfg.recordarMismoDia,
      reglaViernes:     !!cfg.reglaViernes,
    }, new Date());

    // Excluir las que ya estan en sent_marks (marcadas por la APK como enviadas)
    const marks = req.db.prepare(
      'SELECT citaId FROM recordatorios_sent_marks WHERE clinicaId = ?'
    ).all(req.clinicaId).map(r => r.citaId);
    const marksSet = new Set(marks);

    res.json({
      ok: true,
      recordatorios: pendientes.filter(c => !marksSet.has(c.id)).map(c => ({
        citaId:    c.id,
        nombre:    c.nombre,
        telefono:  c.telefono,
        fechaCita: c.fecha,
        horaCita:  c.hora,
        notas:     c.notas || '',
        confirmada: !!c.confirmada,
      })),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── APK marca como enviado / descarta ────────────────────────────────────────
// Tabla recordatorios_sent_marks creada en applyMigrations (db.js).
router.put('/recordatorios/:citaId/marcar', auth, (req, res) => {
  const { citaId } = req.params;
  if (!citaId) return res.status(400).json({ ok: false, error: 'citaId requerido' });
  try {
    req.db.prepare(
      "INSERT OR REPLACE INTO recordatorios_sent_marks (clinicaId, citaId, markedAt) VALUES (?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))"
    ).run(req.clinicaId, citaId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
