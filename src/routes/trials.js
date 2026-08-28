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
const { firmar } = require('../firma');

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

// ── T2: la cuenta del trial la lleva el servidor ────────────────────────────
//
// Hasta ahora vivía en `%APPDATA%\podosystem\trial.dat`. Borrarlo daba otros 60 días: no
// hacía falta descifrar nada ni entender el formato. Con 60 días —el doble que antes— cada
// reinicio rinde el doble.
//
// El riesgo no es el pirata, que iba a encontrar la forma igualmente. Es la clínica que
// empieza de buena fe, descubre el truco y sigue trabajando gratis **con todos sus
// pacientes dentro**: los datos no se van al reiniciar el trial, solo la cuenta.
//
// ── Cómo no se puede abusar de esto ─────────────────────────────────────────
//
// El PC se queda con la fecha de fin MÁS TEMPRANA entre la suya y la de aquí. Por tanto:
//
//   · borrar `trial.dat` no sirve — este servidor recuerda la fecha original;
//   · falsificar este servidor tampoco — el fichero local sigue teniendo la suya.
//
// Hay que vencer las dos a la vez. Y por eso este endpoint **nunca puede alargar** un
// trial: en el peor caso es ruido que el PC ignora.
//
// ── Y por qué no exige autenticación ────────────────────────────────────────
//
// Quien pregunta todavía no es cliente: no tiene licencia ni clave que enseñar. Lo único
// que se acepta es una huella con formato válido, con límite por IP. Lo que se puede hacer
// abusando de él es crear filas basura — molesto, no peligroso: no revela nada de nadie y
// no concede tiempo a ningún equipo real.
const TRIAL_DIAS = 60;
const ES_HUELLA  = /^[0-9a-f]{32}$/;

// Más holgado que el registro de descarga: un PC pregunta al arrancar, y un usuario puede
// abrir y cerrar el programa varias veces seguidas sin ser sospechoso de nada.
const limiteEstado = enTest ? sinLimite : rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Demasiadas consultas.' },
});

const diasRestantes = (fin) =>
  Math.max(0, Math.ceil((new Date(fin).getTime() - Date.now()) / 86400000));

router.post('/trial/estado', limiteEstado, (req, res) => {
  const hardwareId = limpiar(req.body?.hardwareId, 64).toLowerCase();
  if (!ES_HUELLA.test(hardwareId)) {
    return res.status(400).json({ ok: false, error: 'huella no válida' });
  }
  const version = limpiar(req.body?.version, 24) || null;
  const ahora   = new Date().toISOString();
  const ip      = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();

  try {
    const fila = req.db
      .prepare('SELECT hardwareId, inicio, fin, dias FROM trial_instalaciones WHERE hardwareId = ?')
      .get(hardwareId);

    if (fila) {
      // Ya conocida. La fecha de fin NO se toca nunca: es justo lo que hace que borrar el
      // fichero del PC deje de servir para nada.
      req.db.prepare(`UPDATE trial_instalaciones
                         SET vistas = vistas + 1, ultimaVista = ?, version = COALESCE(?, version)
                       WHERE hardwareId = ?`)
        .run(ahora, version, hardwareId);

      // T3 — firmado, para que no baste con inventarse un servidor. La regla del minimo
      // ya impedia que una respuesta falsa REGALE dias; la firma cierra tambien que una
      // respuesta falsa pueda hacerse pasar por nosotros para cualquier otra cosa.
      const sello = firmar({ tipo: 'trial', hardwareId, inicio: fila.inicio, fin: fila.fin, dias: fila.dias });
      return res.json({
        ok: true, nuevo: false,
        inicio: fila.inicio, fin: fila.fin, dias: fila.dias,
        diasRestantes: diasRestantes(fila.fin),
        firmado: sello ? sello.firmado : null,
        firma:   sello ? sello.firma   : null,
      });
    }

    // Primera vez que se ve esta huella. Se fija la fecha de fin y ya no se mueve.
    const fin = new Date(Date.now() + TRIAL_DIAS * 86400000).toISOString();

    // Enlace orientativo con quien se descargó el programa: si desde esta misma IP hubo un
    // registro de descarga en el último mes, es casi seguro la misma persona. Es una
    // ayuda para el panel, NO una identificación: no se usa para decidir nada.
    let trialId = null;
    try {
      const hace30 = new Date(Date.now() - 30 * 86400000).toISOString();
      const cand = req.db.prepare(
        'SELECT id FROM trials WHERE ip = ? AND creadaEn >= ? ORDER BY creadaEn DESC LIMIT 1',
      ).get(ip, hace30);
      if (cand) trialId = cand.id;
    } catch (_) { /* el enlace es opcional */ }

    req.db.prepare(`INSERT INTO trial_instalaciones
        (hardwareId, inicio, fin, dias, trialId, version, ultimaVista, ip)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(hardwareId, ahora, fin, TRIAL_DIAS, trialId, version, ahora, ip || null);

    const selloNuevo = firmar({ tipo: 'trial', hardwareId, inicio: ahora, fin, dias: TRIAL_DIAS });
    return res.json({
      ok: true, nuevo: true,
      inicio: ahora, fin, dias: TRIAL_DIAS, diasRestantes: TRIAL_DIAS,
      firmado: selloNuevo ? selloNuevo.firmado : null,
      firma:   selloNuevo ? selloNuevo.firma   : null,
    });
  } catch (e) {
    // Un fallo aquí no puede dejar a nadie sin poder trabajar: el PC se queda con su
    // cuenta local, que nunca es más generosa que la nuestra.
    console.error('[trials] /trial/estado:', e.message);
    return res.status(503).json({ ok: false, error: 'no disponible' });
  }
});

/** Solo la URL, sin registrar nada. Para la vía de emergencia y para enlaces internos. */
router.get('/trial/descarga', async (_req, res) => {
  const { url, version, error } = await ultimaDescarga();
  if (!url) return res.status(503).json({ ok: false, error: error || 'no disponible' });
  res.json({ ok: true, descargaUrl: url, version });
});

module.exports = router;
