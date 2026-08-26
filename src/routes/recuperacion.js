/**
 * recuperacion.js — Entrega del código de recuperación de contraseña por correo.
 *
 *   POST /api/recuperacion/enviar-codigo   (licenseKey + hardwareId)
 *
 * ── Por qué existe ───────────────────────────────────────────────────────────
 *
 * Hasta la 3.5.0, cada clínica configuraba su propio SMTP para poder recuperar la
 * contraseña de administrador: servidor, puerto, usuario y una **contraseña de aplicación
 * de Gmail** (que exige verificación en dos pasos). Ningún podólogo va a pasar por ahí, así
 * que en la práctica nadie lo activaba y la única vía que quedaba era la pregunta de
 * seguridad, cuya respuesta suele ser una ciudad o un nombre.
 *
 * Y de paso cada instalación que sí lo configuraba guardaba su contraseña SMTP **en claro**
 * en el kvstore, dentro de `clinica.db`, que además viaja en las copias de seguridad.
 * (V8 del informe del 17-08-2026.)
 *
 * Moviendo el envío aquí, el cliente rellena UN campo —dónde quiere recibir el código— y
 * ese secreto deja de existir en su disco.
 *
 * ── Lo que este endpoint NO hace, a propósito ────────────────────────────────
 *
 * **No decide nada sobre el acceso.** El código lo genera el PC, lo guarda el PC en memoria
 * y lo verifica el PC. Aquí solo se entrega el mensaje. El relay es un cartero, no una
 * autoridad: aunque alguien se hiciera con esta base de datos, no obtendría acceso a los
 * datos clínicos de nadie.
 *
 * **No es un servidor de correo abierto.** La plantilla está fija aquí y lo único que se
 * acepta de fuera es un código de SEIS DÍGITOS y un destinatario. No hay forma de mandar
 * texto arbitrario a un tercero, ni asunto propio, ni HTML propio.
 */

'use strict';

const express   = require('express');
const rateLimit = require('express-rate-limit');
const { sendMail } = require('../email');

const router = express.Router();

const sinLimite = (_req, _res, next) => next();
const enTest = process.env.NODE_ENV === 'test';

// Dos frenos, como en los logins del PC: por IP y por licencia. El de licencia es el que
// importa — una misma licencia puede llamar desde IPs distintas, y sin él se podría llenar
// el buzón de alguien a base de "tu código es 123456".
const limitePorIP = enTest ? sinLimite : rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Demasiadas solicitudes. Inténtalo dentro de una hora.' },
});

const limitePorLicencia = enTest ? sinLimite : rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `lic:${String(req.body?.licenseKey || 'sin-licencia')}`,
  message: { ok: false, error: 'Demasiadas solicitudes para esta licencia. Inténtalo dentro de una hora.' },
});

const ES_CODIGO = /^\d{6}$/;
const ES_EMAIL  = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function plantilla({ codigo, clinica, admins }) {
  const lista = (Array.isArray(admins) ? admins : [])
    .slice(0, 10)
    .map(a => `<li>${escapar(String(a))}</li>`)
    .join('');

  return `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px">
      <h2 style="color:#1E3A5F;margin-bottom:4px">Código de recuperación</h2>
      <p style="color:#555;margin-top:0">Se ha solicitado recuperar el acceso a PodoSystem${
        clinica ? ` en <strong>${escapar(clinica)}</strong>` : ''
      }.</p>
      <p style="font-size:32px;font-weight:700;letter-spacing:6px;color:#1E3A5F;
                background:#f4f7fa;border-radius:12px;padding:16px;text-align:center;margin:24px 0">
        ${codigo}
      </p>
      <p style="color:#555">Válido durante 15 minutos.</p>
      ${lista ? `<p style="color:#555;margin-bottom:4px">Usuarios administradores registrados:</p>
                 <ul style="color:#555;margin-top:0">${lista}</ul>` : ''}
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">
      <p style="color:#888;font-size:13px">
        Si no has solicitado este código, ignora este mensaje: sin él nadie puede cambiar la
        contraseña. Nadie de PodoSystem te lo va a pedir.
      </p>
    </div>`;
}

function escapar(s) {
  return s.replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

router.post('/recuperacion/enviar-codigo', limitePorIP, limitePorLicencia, async (req, res) => {
  const { licenseKey, hardwareId, email, codigo, clinica, admins } = req.body || {};

  if (!licenseKey) return res.status(400).json({ ok: false, error: 'licenseKey requerida' });

  // El codigo NUNCA se registra en el log: es la credencial de un solo uso.
  if (!ES_CODIGO.test(String(codigo || ''))) {
    return res.status(400).json({ ok: false, error: 'El código debe ser de 6 dígitos' });
  }
  if (!ES_EMAIL.test(String(email || ''))) {
    return res.status(400).json({ ok: false, error: 'Dirección de correo no válida' });
  }

  const lic = req.db.prepare('SELECT * FROM licencias WHERE licenseKey = ?').get(licenseKey);
  if (!lic) return res.status(404).json({ ok: false, error: 'Licencia no encontrada' });
  if (lic.estado === 'blocked') return res.status(403).json({ ok: false, error: 'Licencia bloqueada' });

  // Mismo criterio que /licencias/verificar: si la licencia ya tiene hardware registrado,
  // tiene que coincidir. Evita que quien copie una licenseKey pida codigos desde otro PC.
  if (lic.hardwareId && hardwareId && lic.hardwareId !== hardwareId) {
    return res.status(403).json({ ok: false, error: 'hardware_mismatch' });
  }

  try {
    await sendMail({
      to: String(email),
      subject: 'Código de recuperación de PodoSystem',
      html: plantilla({ codigo: String(codigo), clinica, admins }),
    });
    console.log(`[recuperacion] codigo entregado · licencia ${String(licenseKey).slice(0, 8)}…`);
    return res.json({ ok: true });
  } catch (e) {
    console.error('[recuperacion] fallo al enviar:', e.message);
    return res.status(502).json({ ok: false, error: 'No se pudo enviar el correo: ' + e.message });
  }
});

/**
 * POST /api/recuperacion/api-key   (licenseKey + hardwareId)
 *
 * Devuelve al PC su propia `clinicaId` y `apiKey` de Citas Web.
 *
 * ── Por qué hace falta ───────────────────────────────────────────────────────
 *
 * Hasta ahora la `apiKey` se entregaba UNA sola vez, al dar de alta la clínica
 * (`admin.js:296`), y no había ningún sitio donde volver a consultarla: `GET /api/clinicas`
 * devuelve id, nombre, webUrl, netlifyId, fechas y código de activación — la clave no.
 * Recuperarla exigía entrar en la base de datos de Railway a mano.
 *
 * Eso convertía `relay_config.json` en un punto único de fallo sin repuesto: si una clínica
 * lo perdía —disco roto, reinstalación limpia, PC nuevo— Citas Web se quedaba muerta. Y de
 * la peor manera, en silencio: el PC deja de sincronizar pero la web sigue ofertando horas y
 * los pacientes siguen reservando. Es la mecánica de las dobles citas de agosto de 2026.
 *
 * Con esto, perder el fichero deja de ser grave: la aplicación vuelve a pedirla y sigue.
 *
 * ── Y es lo que permite cifrar la apiKey en el cliente ───────────────────────
 *
 * Cifrarla con el llavero del sistema ata el dato al equipo. Sin este endpoint, restaurar
 * una copia en otro PC dejaría una clave indescifrable e irrecuperable. Con él, ese caso se
 * resuelve solo. Por eso este endpoint va ANTES que el cifrado, no después.
 *
 * ── El listón ────────────────────────────────────────────────────────────────
 *
 * Esto devuelve una credencial por la red, así que se pide lo mismo que para validar una
 * licencia, incluida la comprobación de hardware: una `licenseKey` copiada no sirve desde
 * otro equipo. El límite es más estrecho que el del correo, y la clave nunca se registra.
 */
const limiteApiKeyPorIP = enTest ? sinLimite : rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Demasiadas solicitudes. Inténtalo dentro de una hora.' },
});

const limiteApiKeyPorLicencia = enTest ? sinLimite : rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `apikey:${String(req.body?.licenseKey || 'sin-licencia')}`,
  message: { ok: false, error: 'Demasiadas solicitudes para esta licencia. Inténtalo dentro de una hora.' },
});

router.post('/recuperacion/api-key', limiteApiKeyPorIP, limiteApiKeyPorLicencia, (req, res) => {
  const { licenseKey, hardwareId } = req.body || {};

  if (!licenseKey) return res.status(400).json({ ok: false, error: 'licenseKey requerida' });

  const lic = req.db.prepare('SELECT * FROM licencias WHERE licenseKey = ?').get(licenseKey);
  if (!lic) return res.status(404).json({ ok: false, error: 'Licencia no encontrada' });
  if (lic.estado === 'blocked') return res.status(403).json({ ok: false, error: 'Licencia bloqueada' });

  if (lic.hardwareId && hardwareId && lic.hardwareId !== hardwareId) {
    return res.status(403).json({ ok: false, error: 'hardware_mismatch' });
  }

  if (!lic.clinicaId) {
    // Licencia sin clínica asociada: no se puede saber qué clave devolver, y desde luego no
    // se va a adivinar. Pasa con altas hechas antes de que el flujo enlazara las dos cosas.
    return res.status(404).json({
      ok: false,
      error: 'Esta licencia no tiene ninguna clínica de Citas Web asociada.',
    });
  }

  const clinica = req.db
    .prepare('SELECT id, apiKey, activa FROM clinicas WHERE id = ?')
    .get(lic.clinicaId);

  if (!clinica) return res.status(404).json({ ok: false, error: 'La clínica asociada ya no existe' });
  if (!clinica.activa) return res.status(403).json({ ok: false, error: 'Clínica desactivada' });

  // Se registra QUE se ha entregado y a quién, nunca la clave.
  console.log(`[recuperacion] apiKey entregada · licencia ${String(licenseKey).slice(0, 8)}… · clinica ${clinica.id}`);

  return res.json({ ok: true, clinicaId: clinica.id, apiKey: clinica.apiKey });
});

module.exports = router;
