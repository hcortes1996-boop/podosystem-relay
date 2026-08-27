/**
 * trials.js — Quién se descarga la prueba, y cuántos acaban comprando.
 *
 *   POST /api/trial/registrar     (público, con límite)
 *   GET  /api/trial/descarga      (público) — solo la URL de la última versión
 *   GET  /admin/api/trials        (ADMIN_TOKEN) — lista + conversión
 *
 * ── Por qué ──────────────────────────────────────────────────────────────────
 *
 * El botón de `demo.html` apuntaba directo al EXE. No se sabía quién probaba el producto, ni
 * cuánta gente, ni qué porcentaje acababa comprando. Ahora hay que dejar nombre, correo y
 * teléfono, y aceptar la política de privacidad, antes de que aparezca la descarga.
 *
 * ── La conversión ────────────────────────────────────────────────────────────
 *
 * Se calcula cruzando `trials.email` con `licencias.clienteEmail`. Es sencillo y funciona
 * sin tocar el flujo de compra, pero tiene un límite honesto: **si alguien prueba con un
 * correo y compra con otro, no se cuenta**. La cifra es un suelo, no un dato exacto — y así
 * hay que leerla, porque una conversión infravalorada lleva a decisiones distintas que una
 * inflada.
 *
 * ── Protección de datos ──────────────────────────────────────────────────────
 *
 * Teléfono y correo de un profesional identificable son datos personales. Sin
 * `acepta_privacidad` no se guarda nada: es un rechazo, no un detalle que se apunta. Se
 * guardan también IP y agente porque son la prueba de cuándo y desde dónde se consintió.
 */

'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { genId } = require('../db');
const { ultimaDescarga } = require('../lib/descarga');

const router = express.Router();

const enTest = process.env.NODE_ENV === 'test';
const sinLimite = (_req, _res, next) => next();

// Más holgado que el alta (5 cada 15 min): aquí la gente puede reintentar, cambiar de idea,
// volver desde otro dispositivo. Pero suficiente para que no sirva de buzón de spam.
const limite = enTest ? sinLimite : rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Demasiadas solicitudes. Inténtalo dentro de una hora.' },
});

const ES_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const limpiar = (v, max) => String(v ?? '').trim().slice(0, max);

router.post('/trial/registrar', limite, async (req, res) => {
  const nombre    = limpiar(req.body?.nombre, 120);
  const email     = limpiar(req.body?.email, 160).toLowerCase();
  const telefono  = limpiar(req.body?.telefono, 32);
  const clinica   = limpiar(req.body?.clinica, 160);
  const provincia = limpiar(req.body?.provincia, 80);
  const acepta    = req.body?.aceptaPrivacidad === true;

  if (!nombre)   return res.status(400).json({ ok: false, error: 'Falta el nombre' });
  if (!ES_EMAIL.test(email)) return res.status(400).json({ ok: false, error: 'El correo no es válido' });
  if (telefono.replace(/\D/g, '').length < 9) {
    return res.status(400).json({ ok: false, error: 'El teléfono no parece válido' });
  }
  // Sin consentimiento NO se guarda. No es un campo más: es la base para poder guardar.
  if (!acepta) {
    return res.status(400).json({ ok: false, error: 'Hay que aceptar la política de privacidad' });
  }

  const ahora = new Date().toISOString();
  const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
  const ua = limpiar(req.headers['user-agent'], 250);

  const { url, version, error } = await ultimaDescarga();
  if (!url) {
    console.error('[trials] no se pudo resolver la descarga:', error);
    return res.status(503).json({
      ok: false,
      error: 'No se pudo preparar la descarga en este momento. Inténtalo en unos minutos.',
    });
  }

  try {
    // Quien vuelve no genera una fila nueva: se le suma una descarga. Si no, un mismo
    // interesado que entra tres veces pareceria tres interesados.
    const previo = req.db.prepare('SELECT id, descargas FROM trials WHERE email = ?').get(email);
    if (previo) {
      req.db.prepare(`UPDATE trials SET descargas = descargas + 1, ultima_descarga = ?,
                      version_descargada = ?, nombre = ?, telefono = ?, clinica = ?, provincia = ?
                      WHERE id = ?`)
        .run(ahora, version, nombre, telefono, clinica || null, provincia || null, previo.id);
    } else {
      req.db.prepare(`INSERT INTO trials
          (id, nombre, email, telefono, clinica, provincia,
           acepta_privacidad, acepta_privacidad_en, version_descargada, ip, user_agent, ultima_descarga)
          VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`)
        .run(genId(12), nombre, email, telefono, clinica || null, provincia || null,
             ahora, version, ip || null, ua || null, ahora);
    }
  } catch (e) {
    // Que falle el registro no puede dejar sin descargar a un cliente potencial.
    console.error('[trials] no se pudo registrar:', e.message);
  }

  return res.json({ ok: true, descargaUrl: url, version });
});

/** Solo la URL, sin registrar nada. Para la vía de emergencia y para enlaces internos. */
router.get('/trial/descarga', async (_req, res) => {
  const { url, version, error } = await ultimaDescarga();
  if (!url) return res.status(503).json({ ok: false, error: error || 'no disponible' });
  res.json({ ok: true, descargaUrl: url, version });
});

module.exports = router;
