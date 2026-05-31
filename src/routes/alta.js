'use strict';
/**
 * alta.js — Solicitudes de alta en el sistema de Citas Online
 *
 *   POST /api/alta-relay  (público, rate-limited)
 *   Recibe el formulario de alta-relay.html, guarda en solicitudes_alta
 *   y notifica por email a info@podosystem.es.
 */

const router    = require('express').Router();
const rateLimit = require('express-rate-limit');
const { genId } = require('../db');
const { sendMail } = require('../email');

const altaLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Demasiadas solicitudes. Inténtalo en 15 minutos.' },
});

router.post('/alta-relay', altaLimiter, async (req, res) => {
  const {
    nombre_clinica, profesional, nif, ciudad, provincia,
    telefono, email, web_citas, mensaje, podosystem_version,
  } = req.body;

  if (!nombre_clinica?.trim() || !profesional?.trim() || !telefono?.trim() || !email?.trim()) {
    return res.status(400).json({ ok: false, error: 'Faltan campos obligatorios: nombre_clinica, profesional, telefono, email' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: 'Email no válido' });
  }

  const id = genId(12);
  req.db.prepare(`
    INSERT INTO solicitudes_alta
      (id, nombre_clinica, profesional, nif, ciudad, provincia, telefono, email, web_citas, mensaje, podosystem_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    nombre_clinica.trim(),
    profesional.trim(),
    nif?.trim()              || null,
    ciudad?.trim()           || null,
    provincia?.trim()        || null,
    telefono.trim(),
    email.trim().toLowerCase(),
    web_citas?.trim()        || null,
    mensaje?.trim()          || null,
    podosystem_version       || null,
  );

  const relayUrl = process.env.RELAY_URL || 'https://podosystem-relay-production.up.railway.app';
  const adminEmail = process.env.ADMIN_EMAIL || 'info@podosystem.es';

  const filas = [
    ['Clínica',       nombre_clinica],
    ['Profesional',   profesional],
    nif        && ['NIF',        nif],
    ciudad     && ['Ciudad',     ciudad + (provincia ? `, ${provincia}` : '')],
    ['Teléfono',      telefono],
    ['Email',         email],
    web_citas  && ['Web citas',  web_citas],
    mensaje    && ['Mensaje',    mensaje],
    podosystem_version && ['Versión app', podosystem_version],
  ].filter(Boolean);

  const tablaHtml = filas.map(([k, v]) => `
    <tr>
      <td style="padding:7px 14px;font-weight:700;background:#f5f7fa;white-space:nowrap;color:#1E3A5F">${esc(k)}</td>
      <td style="padding:7px 14px;border-bottom:1px solid #eef0f4;color:#1a2a3a">${esc(v)}</td>
    </tr>`).join('');

  const adminHtml = `
<div style="font-family:Inter,Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff">
  <div style="background:#0f2137;padding:28px 40px">
    <p style="margin:0;font-size:20px;font-weight:800;color:#fff">Podo<span style="color:#2ecc9a">System</span></p>
    <p style="margin:6px 0 0;font-size:13px;color:rgba(255,255,255,.5)">Nueva solicitud de activación de Citas Online</p>
  </div>
  <div style="padding:32px 40px">
    <h2 style="margin:0 0 20px;font-size:18px;color:#0f2137">Nueva solicitud: ${esc(nombre_clinica)}</h2>
    <table style="border-collapse:collapse;width:100%;border-radius:8px;overflow:hidden;border:1px solid #eef0f4">
      ${tablaHtml}
    </table>
    <div style="margin-top:28px">
      <a href="${esc(relayUrl)}/admin" style="display:inline-block;background:#1E3A5F;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px">
        Revisar en Admin Panel →
      </a>
    </div>
    <p style="margin-top:20px;font-size:12px;color:#aaa">ID solicitud: ${id}</p>
  </div>
</div>`;

  // Responde inmediatamente — el INSERT ya está committed antes de llegar aquí
  res.status(201).json({ ok: true, id });

  // Fire-and-forget: el email no bloquea la respuesta HTTP
  sendMail({ to: adminEmail, subject: `Nueva solicitud de alta: ${nombre_clinica}`, html: adminHtml })
    .catch(e => console.error('[alta-relay] Email error:', e.message));
});

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

module.exports = router;
