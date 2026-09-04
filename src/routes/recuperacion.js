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
const crypto    = require('crypto');
const { sendMail } = require('../email');
const { genId } = require('../db');

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

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * REASIGNAR UNA LICENCIA A OTRO EQUIPO
 *
 *   POST /api/recuperacion/reasignar/solicitar   { licenseKey }
 *   POST /api/recuperacion/reasignar/confirmar   { licenseKey, codigo, hardwareId }
 *
 * ── Por qué existe ───────────────────────────────────────────────────────────
 *
 * A un cliente se le muere el ordenador. Compra otro, descarga PodoSystem, mete su licencia…
 * y recibe un **403 hardware_mismatch**, porque la licencia sigue atada a la huella del PC
 * muerto. Hasta el 04-09-2026 la única salida era que alguien con acceso al panel reescribiera
 * el hardwareId a mano.
 *
 * Y no es solo la licencia: /recuperacion/api-key —que devuelve el clinicaId sin el cual la
 * aplicación **no sabe ni qué carpeta del bucket contiene sus copias**— exige ese mismo
 * hardware. Las dos puertas eran la misma, así que abrir esta abre las dos.
 *
 * ── Por qué aquí el relay SÍ decide, al contrario que en enviar-codigo ────────
 *
 * La cabecera de este fichero dice que el relay es «un cartero, no una autoridad»: en la
 * recuperación de contraseña, el PC genera el código, lo guarda y lo verifica.
 *
 * **Aquí eso no puede funcionar, y conviene entender por qué:** en un ordenador nuevo no hay
 * PC que genere ni verifique nada. Si quien pide mandara su propio código y su propio correo
 * —como hace enviar-codigo— cualquiera con una licenseKey robada se aprobaría a sí mismo.
 * Sería seguridad de adorno.
 *
 * Así que aquí el relay genera el código, lo guarda hasheado y lo verifica, y lo manda **a la
 * dirección registrada en la licencia**, que el solicitante no elige.
 *
 * ⚠️ Lo que eso cambia, dicho de frente: el relay pasa a ser autoridad **para vincular
 * licencias**. NO para los datos clínicos, que siguen en una copia cifrada cuya contraseña el
 * relay no tiene ni puede deducir. La frase de la cabecera sigue siendo cierta donde importa.
 *
 * ── Las defensas ─────────────────────────────────────────────────────────────
 *
 *   · El código va SOLO al clienteEmail de la licencia. Quien roba una clave no controla ese
 *     buzón.
 *   · Seis dígitos con crypto.randomInt —no Math.random—, 15 minutos de vida y **5 intentos**.
 *     Agotados, el código muere: 5 de un millón no es adivinable.
 *   · Se guarda hasheado, para que una fuga de solo lectura no entregue códigos en vuelo.
 *   · Un solo uso, y cada solicitud invalida la anterior.
 *   · Queda registrado quién, cuándo, desde qué IP y de qué equipo a cuál.
 *   · Y al terminar **se avisa por correo de que la licencia se ha movido**, para que el dueño
 *     se entere aunque no haya sido él.
 */

/**
 * Las dos plantillas viven aquí, fijas, por la misma razón que la de recuperación: lo único
 * que entra de fuera es un código de seis dígitos. No hay forma de mandar texto propio a un
 * tercero, ni asunto, ni HTML.
 */
function plantillaReasignacion({ codigo, nombre }) {
  return `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:520px;margin:0 auto;color:#1f2937">
    <h2 style="color:#1E3A5F;margin:0 0 4px">PodoSystem en otro ordenador</h2>
    <p>Hola${nombre ? ' ' + escapar(nombre) : ''},</p>
    <p>Alguien ha pedido activar tu licencia de PodoSystem en un ordenador distinto.
       Si has sido tú, escribe este código en la aplicación:</p>
    <p style="font-size:2rem;font-weight:700;letter-spacing:.35rem;text-align:center;
              background:#f3f4f6;border-radius:12px;padding:16px 0;margin:18px 0;color:#1E3A5F">${escapar(String(codigo))}</p>
    <p style="color:#6b7280;font-size:.9rem">Caduca en 15 minutos y solo sirve una vez.</p>
    <p style="color:#b91c1c;font-size:.9rem"><strong>Si no has sido tú, no hagas nada</strong> y
       escribe a soporte@podosystem.es: sin este código, tu licencia no se mueve de sitio.</p>
  </div>`;
}

function plantillaAvisoMovida({ nombre, cuando }) {
  const f = new Date(cuando);
  const legible = isNaN(f) ? String(cuando) : f.toLocaleString('es-ES');
  return `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:520px;margin:0 auto;color:#1f2937">
    <h2 style="color:#1E3A5F;margin:0 0 4px">Tu licencia se ha activado en otro ordenador</h2>
    <p>Hola${nombre ? ' ' + escapar(nombre) : ''},</p>
    <p>Tu licencia de PodoSystem se ha vinculado a un ordenador nuevo el
       <strong>${escapar(legible)}</strong>. El anterior ha dejado de estar autorizado.</p>
    <p style="color:#b91c1c"><strong>Si no has sido tú</strong>, escribe cuanto antes a
       soporte@podosystem.es.</p>
    <p style="color:#6b7280;font-size:.9rem">Este aviso se manda siempre, aunque el cambio lo
       hayas hecho tú: es la forma de que un movimiento no pase desapercibido.</p>
  </div>`;
}

const ES_LICENCIA = /^[A-Z0-9-]{8,64}$/i;
const VIDA_CODIGO_MS = 15 * 60 * 1000;
const MAX_INTENTOS = 5;

function hashCodigo(id, codigo) {
  return crypto.createHash('sha256').update(id + ':' + codigo).digest('hex');
}

/** francisco@ejemplo.com → f···o@ejemplo.com. Confirma a dónde fue sin revelarlo. */
function pistaEmail(email) {
  const partes = String(email).split('@');
  if (partes.length !== 2) return '···';
  const u = partes[0];
  const visible = u.length <= 2 ? u[0] : u[0] + '···' + u[u.length - 1];
  return visible + '@' + partes[1];
}

const limiteReasignIP = enTest ? sinLimite : rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true, legacyHeaders: false,
  message: { ok: false, error: 'Demasiados intentos. Prueba dentro de una hora.' },
});

const limiteReasignLic = enTest ? sinLimite : rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => 'reasig:' + String(req.body && req.body.licenseKey || 'sin-licencia'),
  message: { ok: false, error: 'Demasiados intentos con esta licencia. Prueba dentro de una hora.' },
});

function buscarLicencia(req, licenseKey) {
  if (!licenseKey || !ES_LICENCIA.test(String(licenseKey))) {
    return { error: { status: 400, cuerpo: { ok: false, error: 'licenseKey no válida' } } };
  }
  const lic = req.db.prepare('SELECT * FROM licencias WHERE licenseKey = ?').get(String(licenseKey));
  if (!lic) return { error: { status: 404, cuerpo: { ok: false, error: 'Licencia no encontrada' } } };
  if (lic.estado === 'blocked') {
    return { error: { status: 403, cuerpo: { ok: false, error: 'Licencia bloqueada' } } };
  }
  return { lic };
}

router.post('/recuperacion/reasignar/solicitar', limiteReasignIP, limiteReasignLic, async (req, res) => {
  const encontrada = buscarLicencia(req, req.body && req.body.licenseKey);
  if (encontrada.error) return res.status(encontrada.error.status).json(encontrada.error.cuerpo);
  const lic = encontrada.lic;

  // ⚠️ EL CALLEJÓN SIN SALIDA DE ESTE ENDPOINT, dicho de frente.
  //
  // Todo el mecanismo se apoya en que el código va a un buzón que el solicitante NO elige. Esa
  // es justo su fuerza —quien roba una licenseKey no controla ese buzón— y justo su límite: si
  // el dueño legítimo **ha perdido el acceso a ese correo**, o nunca hubo correo, no hay nada
  // que este endpoint pueda hacer sin convertirse en seguridad de adorno.
  //
  // No se arregla con código. Se arregla diciéndolo claro y dando la salida manual, que existe:
  // alguien con acceso al panel reescribe el hardwareId (`PUT /admin/api/licencias/:id`) tras
  // comprobar la identidad por otra vía —la factura de compra, el teléfono de contacto—.
  //
  // Lo que NO se puede hacer es dejar que el solicitante proponga otro correo: eso es
  // exactamente el sabotaje A de la prueba, y pasa en verde si nadie lo mira.
  if (!lic.clienteEmail) {
    return res.status(409).json({
      ok: false,
      motivo: 'sin-correo',
      error: 'Esta licencia no tiene ningún correo registrado, así que no hay dónde enviar el código.',
      queHacer: 'Escribe a soporte@podosystem.es desde cualquier dirección, indicando tu clave de licencia. Se comprobará tu identidad por otra vía y se reasignará a mano.',
    });
  }

  // 6 dígitos con generador criptográfico. Math.random es predecible, y esto es una
  // credencial aunque solo dure quince minutos.
  const codigo = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const ahora = new Date();

  // Cada solicitud invalida la anterior: si alguien pide dos, solo vale la última.
  req.db.prepare('DELETE FROM reasignaciones WHERE licenciaId = ? AND usadoEn IS NULL').run(lic.id);

  const id = genId(12);
  req.db.prepare('INSERT INTO reasignaciones (id, licenciaId, codigoHash, creadoEn, expiraEn, hardwareAntes, ip) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, lic.id, hashCodigo(id, codigo), ahora.toISOString(),
         new Date(ahora.getTime() + VIDA_CODIGO_MS).toISOString(),
         lic.hardwareId || null, req.ip || null);

  try {
    await sendMail({
      to: lic.clienteEmail,
      subject: 'Código para usar PodoSystem en otro ordenador',
      html: plantillaReasignacion({ codigo, nombre: lic.clienteNombre }),
    });
  } catch (e) {
    console.error('[reasignar] fallo al enviar:', e.message);
    return res.status(502).json({ ok: false, error: 'No se pudo enviar el correo: ' + e.message });
  }

  // Ni el código ni el correo completo entran en el registro.
  console.log('[reasignar] codigo enviado · licencia ' + String(lic.licenseKey).slice(0, 8) + '…');
  return res.json({
    ok: true,
    enviadoA: pistaEmail(lic.clienteEmail),
    validoMinutos: VIDA_CODIGO_MS / 60000,
    // La pista del correo sola no basta: el que ya no puede abrir ese buzón se queda mirando
    // una pantalla que dice «revisa tu correo» para siempre. Hay que decirle que hay salida.
    siNoPuedesAbrirEseCorreo: 'Escribe a soporte@podosystem.es desde cualquier dirección, indicando tu clave de licencia.',
  });
});

router.post('/recuperacion/reasignar/confirmar', limiteReasignIP, limiteReasignLic, async (req, res) => {
  const cuerpo = req.body || {};
  const encontrada = buscarLicencia(req, cuerpo.licenseKey);
  if (encontrada.error) return res.status(encontrada.error.status).json(encontrada.error.cuerpo);
  const lic = encontrada.lic;

  if (!/^\d{6}$/.test(String(cuerpo.codigo || ''))) {
    return res.status(400).json({ ok: false, error: 'El código debe ser de 6 dígitos' });
  }
  if (!cuerpo.hardwareId || String(cuerpo.hardwareId).length < 8) {
    return res.status(400).json({ ok: false, error: 'hardwareId requerido' });
  }

  const fila = req.db.prepare('SELECT * FROM reasignaciones WHERE licenciaId = ? AND usadoEn IS NULL ORDER BY creadoEn DESC LIMIT 1').get(lic.id);

  if (!fila) {
    return res.status(410).json({ ok: false, error: 'No hay ningún código pendiente. Pide uno nuevo.' });
  }
  if (new Date(fila.expiraEn) < new Date()) {
    return res.status(410).json({ ok: false, error: 'El código ha caducado. Pide uno nuevo.' });
  }
  if (fila.intentos >= MAX_INTENTOS) {
    return res.status(429).json({ ok: false, error: 'Demasiados intentos con este código. Pide uno nuevo.' });
  }

  if (hashCodigo(fila.id, String(cuerpo.codigo)) !== fila.codigoHash) {
    req.db.prepare('UPDATE reasignaciones SET intentos = intentos + 1 WHERE id = ?').run(fila.id);
    return res.status(401).json({
      ok: false,
      error: 'Código incorrecto',
      intentosRestantes: Math.max(0, MAX_INTENTOS - (fila.intentos + 1)),
    });
  }

  const ahora = new Date().toISOString();
  const anterior = lic.hardwareId || null;

  req.db.prepare("UPDATE licencias SET hardwareId = ?, instanceId = ?, estado = 'active', ultimaValidacion = ? WHERE id = ?")
    .run(String(cuerpo.hardwareId), String(cuerpo.instanceId || ''), ahora, lic.id);

  req.db.prepare('UPDATE reasignaciones SET usadoEn = ?, hardwareNuevo = ? WHERE id = ?')
    .run(ahora, String(cuerpo.hardwareId), fila.id);

  // El aviso va DESPUÉS de reasignar, y que falle no deshace nada: el cliente ya tiene su
  // licencia funcionando, que es a lo que venía. Pero el fallo se registra.
  try {
    await sendMail({
      to: lic.clienteEmail,
      subject: 'Tu licencia de PodoSystem se ha activado en otro ordenador',
      html: plantillaAvisoMovida({ nombre: lic.clienteNombre, cuando: ahora }),
    });
  } catch (e) {
    console.error('[reasignar] licencia reasignada pero el aviso no salio:', e.message);
  }

  console.log('[reasignar] licencia ' + String(lic.licenseKey).slice(0, 8) + '… movida de ' +
              (anterior ? anterior.slice(0, 8) + '…' : '(sin equipo)') + ' a ' +
              String(cuerpo.hardwareId).slice(0, 8) + '…');

  return res.json({ ok: true, estado: 'active', plan: lic.plan || 'clinica' });
});

module.exports = router;
