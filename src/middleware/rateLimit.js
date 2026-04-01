/**
 * rateLimit.js — Límite de peticiones para endpoints públicos
 * Evita spam del formulario de citas: máx. 10 solicitudes por IP por hora.
 */

const rateLimit = require('express-rate-limit');

module.exports = rateLimit({
  windowMs: 60 * 60 * 1000,   // 1 hora
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    ok: false,
    error: 'Demasiadas solicitudes desde esta dirección. Inténtelo en una hora o llame directamente a la clínica.'
  }
});
