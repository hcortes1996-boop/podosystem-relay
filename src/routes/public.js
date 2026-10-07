/**
 * public.js — Rutas públicas (sin autenticación)
 *
 *   GET  /api/ping              — health check para Railway/Render
 *   POST /api/solicitud-cita    — envío del formulario de la web
 */

const router    = require('express').Router();
const rateLimit = require('../middleware/rateLimit');

/* ── Health check ─────────────────────────────────────────────── */
router.get('/ping', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString(), service: 'podosystem-relay' });
});

/* ── Logo de la clínica (público) ─────────────────────────────── */
router.get('/clinicas/:id/logo', (req, res) => {
  const clinica = req.db.prepare('SELECT logo FROM clinicas WHERE id = ? AND activa = 1').get(req.params.id);
  if (!clinica?.logo) return res.status(404).json({ ok: false, error: 'Logo no disponible' });
  // Detectar formato por magic bytes: FF D8 = JPEG, 89 50 4E 47 = PNG
  const isJpeg = clinica.logo[0] === 0xFF && clinica.logo[1] === 0xD8;
  res.setHeader('Content-Type', isJpeg ? 'image/jpeg' : 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(clinica.logo);
});

/* ── Enviar solicitud de cita ─────────────────────────────────── */
// RETIRADO el 07-10-2026: ninguna web lo usa desde que existe /api/reservar-slot, y guardaba la
// IP del paciente. Se responde 410 con un mensaje que una web antigua pueda enseñar.
router.post('/solicitud-cita', rateLimit, (_req, res) => res.status(410).json({ ok: false,
  error: 'Este formulario ya no está disponible. Llame a la clínica para pedir cita.' }));

module.exports = router;
