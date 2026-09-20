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
const { genId, genApiKey } = require('../db');
const { ultimaDescarga } = require('../lib/descarga');
const { firmar } = require('../firma');
const { sendMail } = require('../email');
const {
  VIDA_CODIGO_MS, MAX_INTENTOS, generarCodigo, hashCodigo, pistaEmail, comprobarCodigo,
} = require('../lib/codigo-verificacion');

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

/* ═══════════════════════════════════════════════════════════════════════════
 * ACTIVAR LA WEB DE CITAS DESDE UN TRIAL — bloque 2 del estudio, decisión ③
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Hasta hoy, un trial que quisiera Citas Web tenía que rellenar un formulario, escribir a
 * `info@` y esperar a que alguien le creara la clínica a mano. Nadie hace eso durante una
 * prueba: se va. Y sin `clinicaId` no puede llegar a `/cita/<id>`, que es lo que se desplegó
 * en el bloque 3 — por eso el estudio avisa de que «sin esto, las decisiones ② y ⑤ dan igual».
 *
 * ── Por qué la verificación va AQUÍ y no al empezar el trial ────────────────
 *
 * Si al abrir el programa por primera vez hubiera que ir al correo a por un código, se pierde
 * gente en el paso cero. Aquí no: quien pulsa «Activar mi web de citas» ya está interesado de
 * verdad, y teclear seis dígitos no echa a nadie. A cambio se consigue:
 *
 *   · un correo VERIFICADO justo de los interesados de verdad, que comercialmente vale mucho
 *     más que una lista de direcciones sin comprobar;
 *   · que no se creen clínicas de gente que no existe, que era el temor de la decisión ③;
 *   · y atar la huella del equipo a la fila de `trials` — hoy `trial_instalaciones.trialId` se
 *     adivina por IP, y el propio código avisa de que es «una ayuda para el panel, NO una
 *     identificación».
 *
 * ⚠️ **Lo que esto NO es:** una identificación fuerte. Cualquiera puede usar un correo
 * desechable. Filtra al que se inventa la dirección, no al que se empeña — y para lo que se
 * quiere (control en el panel y no crear clínicas fantasma) es suficiente.
 *
 * ⚠️ **No es un servidor de correo abierto.** Igual que en `recuperacion.js`: la plantilla está
 * fija aquí y de fuera solo se acepta un correo que YA esté registrado como trial y un código
 * de seis dígitos. No hay manera de mandar texto arbitrario a un tercero.
 */

/** El correo del código. Plantilla fija: lo único variable son el código y el nombre. */
function plantillaCodigoWeb({ codigo, nombre }) {
  const esc = (s) => String(s || '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  return `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:520px;margin:0 auto;color:#1f2937">
    <h2 style="color:#1E3A5F;margin:0 0 4px">Tu código para activar la web de citas</h2>
    <p>Hola${nombre ? ' ' + esc(nombre) : ''},</p>
    <p>Escribe este código en PodoSystem para activar tu web de citas:</p>
    <p style="font-size:2rem;font-weight:700;letter-spacing:.35rem;color:#1E3A5F;margin:18px 0">${esc(codigo)}</p>
    <p style="color:#6b7280;font-size:.9rem">Caduca en ${VIDA_CODIGO_MS / 60000} minutos y solo se puede usar una vez.
       Si no lo has pedido tú, ignora este mensaje: sin el código no se activa nada.</p>
  </div>`;
}

/**
 * Paso 1 — pedir el código.
 *
 * Solo se manda a un correo que YA figura en `trials`: no se puede usar para escribir a nadie
 * que no se haya descargado la prueba.
 */
router.post('/trial/web/solicitar', limite, async (req, res) => {
  const hardwareId = limpiar(req.body?.hardwareId, 64).toLowerCase();
  const email      = limpiar(req.body?.email, 160).toLowerCase();

  if (!ES_HUELLA.test(hardwareId)) return res.status(400).json({ ok: false, error: 'huella no válida' });
  if (!ES_EMAIL.test(email))       return res.status(400).json({ ok: false, error: 'El correo no es válido' });

  const trial = req.db.prepare('SELECT id, nombre, email, clinicaId FROM trials WHERE email = ?').get(email);
  if (!trial) {
    // Mensaje honesto: es el correo con el que se descargó la prueba, y sin él no hay nada que
    // verificar. No se filtra nada que no supiera ya quien lo escribe.
    return res.status(404).json({
      ok: false,
      error: 'Ese correo no consta como descarga de la prueba. Usa el mismo con el que te la descargaste.',
    });
  }

  // Si ya tiene clínica, no hace falta código: se devuelve lo que hay (ver la idempotencia
  // del paso 2). Pedir otro código para algo ya hecho solo confunde.
  if (trial.clinicaId) {
    const cl = req.db.prepare('SELECT id, apiKey FROM clinicas WHERE id = ?').get(trial.clinicaId);
    if (cl) return res.json({ ok: true, yaActivada: true, clinicaId: cl.id, apiKey: cl.apiKey });
  }

  const codigo = generarCodigo();
  const ahora  = new Date();
  const id     = genId(12);

  // Cada solicitud invalida la anterior: si alguien pide dos, solo vale la última.
  req.db.prepare('DELETE FROM trial_verificaciones WHERE trialId = ? AND usadoEn IS NULL').run(trial.id);
  req.db.prepare(`INSERT INTO trial_verificaciones
      (id, trialId, hardwareId, codigoHash, creadoEn, expiraEn, ip) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, trial.id, hardwareId, hashCodigo(id, codigo), ahora.toISOString(),
         new Date(ahora.getTime() + VIDA_CODIGO_MS).toISOString(),
         (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim() || null);

  try {
    await sendMail({
      to: trial.email,
      subject: 'Tu código para activar la web de citas de PodoSystem',
      html: plantillaCodigoWeb({ codigo, nombre: trial.nombre }),
    });
  } catch (e) {
    console.error('[trial/web] fallo al enviar:', e.message);
    return res.status(502).json({ ok: false, error: 'No se pudo enviar el correo: ' + e.message });
  }

  // Ni el código ni el correo completo entran en el registro.
  console.log('[trial/web] codigo enviado · trial ' + trial.id);
  return res.json({ ok: true, enviadoA: pistaEmail(trial.email), validoMinutos: VIDA_CODIGO_MS / 60000 });
});

/**
 * Paso 2 — confirmar el código y crear la clínica.
 *
 * Aquí es donde ocurre todo lo que el estudio pedía, y en este orden:
 *   1. se comprueba el código (caducado / gastado / intentos / incorrecto),
 *   2. se marca el correo verificado,
 *   3. se ATA la huella a la fila del trial — dejando de adivinarla por IP,
 *   4. y solo entonces se crea la clínica.
 *
 * ⚠️ **Idempotente a propósito.** El plan de pruebas lo pide con estas palabras: «que dos
 * verificaciones del mismo correo no creen dos clínicas». El cerrojo es `trials.clinicaId`.
 */
router.post('/trial/web/confirmar', limite, (req, res) => {
  const hardwareId = limpiar(req.body?.hardwareId, 64).toLowerCase();
  const email      = limpiar(req.body?.email, 160).toLowerCase();
  const codigo     = limpiar(req.body?.codigo, 6);
  const nombreWeb  = limpiar(req.body?.nombreClinica, 160);

  if (!ES_HUELLA.test(hardwareId)) return res.status(400).json({ ok: false, error: 'huella no válida' });
  if (!ES_EMAIL.test(email))       return res.status(400).json({ ok: false, error: 'El correo no es válido' });
  if (!/^[0-9]{6}$/.test(codigo))  return res.status(400).json({ ok: false, error: 'El código es de 6 dígitos' });

  const trial = req.db.prepare('SELECT id, nombre, email, clinica, clinicaId FROM trials WHERE email = ?').get(email);
  if (!trial) return res.status(404).json({ ok: false, error: 'Ese correo no consta como descarga de la prueba' });

  // El cerrojo de idempotencia, ANTES de tocar el código: si ya hay clínica, se devuelve.
  if (trial.clinicaId) {
    const cl = req.db.prepare('SELECT id, apiKey FROM clinicas WHERE id = ?').get(trial.clinicaId);
    if (cl) return res.json({ ok: true, yaActivada: true, clinicaId: cl.id, apiKey: cl.apiKey });
  }

  const fila = req.db.prepare(
    'SELECT * FROM trial_verificaciones WHERE trialId = ? ORDER BY creadoEn DESC LIMIT 1'
  ).get(trial.id);

  const veredicto = comprobarCodigo(fila, codigo);
  if (!veredicto.ok) {
    // Solo se gasta intento cuando el código existía y estaba vivo: un código caducado no
    // debe consumir los cinco de quien pida otro.
    if (veredicto.fallo) {
      req.db.prepare('UPDATE trial_verificaciones SET intentos = intentos + 1 WHERE id = ?').run(fila.id);
    }
    return res.status(veredicto.estado).json({
      ok: false,
      error: veredicto.motivo,
      ...(veredicto.intentosRestantes !== undefined ? { intentosRestantes: veredicto.intentosRestantes } : {}),
    });
  }

  const ahora = new Date().toISOString();
  const nombreClinica = nombreWeb || trial.clinica || trial.nombre;
  const clinicaId = genId(10);
  const apiKey    = genApiKey();

  // Todo junto o nada: si fallara a medias quedaría un trial verificado sin clínica, o una
  // clínica que nadie sabe de quién es.
  const alta = req.db.transaction(() => {
    req.db.prepare("INSERT INTO clinicas (id, nombre, apiKey, fuente) VALUES (?, ?, ?, 'trial')")
      .run(clinicaId, nombreClinica, apiKey);
    req.db.prepare('UPDATE trials SET email_verificado_en = ?, clinicaId = ? WHERE id = ?')
      .run(ahora, clinicaId, trial.id);
    req.db.prepare('UPDATE trial_verificaciones SET usadoEn = ? WHERE id = ?').run(ahora, fila.id);
    // La huella deja de adivinarse por IP: a partir de aquí se sabe de quién es el equipo.
    req.db.prepare('UPDATE trial_instalaciones SET trialId = ? WHERE hardwareId = ?')
      .run(trial.id, hardwareId);
  });

  try {
    alta();
  } catch (e) {
    console.error('[trial/web] no se pudo crear la clinica:', e.message);
    return res.status(500).json({ ok: false, error: 'No se pudo activar la web de citas' });
  }

  console.log('[trial/web] clinica creada ' + clinicaId + ' para el trial ' + trial.id);
  return res.json({
    ok: true,
    clinicaId,
    apiKey,
    nombre: nombreClinica,
    // La dirección que el PC enseñará con el QR (bloque 4).
    webUrl: (process.env.RELAY_URL || 'https://podosystem-relay-production.up.railway.app') + '/cita/' + clinicaId,
  });
});

module.exports = router;
