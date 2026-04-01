/**
 * public.js — Rutas públicas (sin autenticación)
 *
 *   GET  /api/ping              — health check para Railway/Render
 *   POST /api/solicitud-cita    — envío del formulario de la web
 */

const router    = require('express').Router();
const rateLimit = require('../middleware/rateLimit');
const { genId } = require('../db');

/* ── Health check ─────────────────────────────────────────────── */
router.get('/ping', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString(), service: 'podosystem-relay' });
});

/* ── Enviar solicitud de cita ─────────────────────────────────── */
router.post('/solicitud-cita', rateLimit, (req, res) => {
  const { clinicaId, nombre, telefono, email, motivo, fechaDeseada, horaDeseada, observaciones } = req.body;

  // Validación de campos obligatorios
  if (!clinicaId) return res.status(400).json({ ok: false, error: 'Campo requerido: clinicaId' });
  if (!nombre?.trim()) return res.status(400).json({ ok: false, error: 'Campo requerido: nombre' });
  if (!telefono?.trim()) return res.status(400).json({ ok: false, error: 'Campo requerido: telefono' });
  if (!motivo) return res.status(400).json({ ok: false, error: 'Campo requerido: motivo' });

  // Verificar que la clínica existe y está activa
  const clinica = req.db
    .prepare('SELECT id FROM clinicas WHERE id = ? AND activa = 1')
    .get(clinicaId);

  if (!clinica) {
    return res.status(400).json({ ok: false, error: 'Clínica no encontrada o inactiva' });
  }

  // Comprobar si la fecha deseada está bloqueada (solo teléfono esos días)
  if (fechaDeseada) {
    const bloqueada = req.db
      .prepare('SELECT 1 FROM bloqueos WHERE clinicaId = ? AND fecha = ?')
      .get(clinicaId, fechaDeseada);
    if (bloqueada) {
      return res.status(409).json({
        ok: false,
        error: 'La fecha seleccionada no está disponible para citas online. Por favor, llame directamente a la clínica.',
        fechaBloqueada: true
      });
    }
  }

  const id = 'sol_' + genId(10);
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '';

  req.db.prepare(`
    INSERT INTO solicitudes (id, clinicaId, nombre, telefono, email, motivo, fechaDeseada, horaDeseada, observaciones, ip)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    clinicaId,
    nombre.trim(),
    telefono.trim(),
    email?.trim() || null,
    motivo,
    fechaDeseada || null,
    horaDeseada || null,
    observaciones?.trim() || null,
    ip
  );

  res.status(201).json({
    ok: true,
    id,
    mensaje: 'Solicitud recibida. Le contactaremos en breve para confirmar su cita.'
  });
});

module.exports = router;
