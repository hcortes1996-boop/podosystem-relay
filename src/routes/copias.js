'use strict';
/**
 * copias.js — La clave de Backblaze de cada clínica, para su copia en la nube.
 *
 *   POST /api/copias/credenciales   { licenseKey, hardwareId }
 *
 * Ver `lib/claves-copia.js`. Lo pide el PC antes de copiar, listar o restaurar. Si esto falla, el
 * PC de la 3.11.1 sigue con la clave del instalador: este paso no puede dejar a nadie sin copias.
 *
 * ── Quién la recibe ──────────────────────────────────────────────────────────
 *
 *   · Una licencia viva (ni caducada, ni bloqueada, ni de prueba: la prueba no tiene nube).
 *   · Desde SU equipo: el `hardwareId` es OBLIGATORIO si la licencia está atada a uno. En
 *     /recuperacion/api-key la comprobación se saltaba si la petición no lo traía; aquí no.
 *   · Con su clínica enlazada (`licencias.clinicaId`): la clave se limita a esa carpeta, así que
 *     sin clínica no hay carpeta que dar, y no se adivina.
 */
const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { claveDeClinica } = require('../lib/claves-copia');

const enTest = process.env.NODE_ENV === 'test';
const sinLimite = (_req, _res, next) => next();

const porIP = enTest ? sinLimite : rateLimit({
  windowMs: 60 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
  message: { ok: false, error: 'Demasiadas solicitudes. Inténtalo dentro de una hora.' },
});
const porLicencia = enTest ? sinLimite : rateLimit({
  windowMs: 60 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => `copias:${String(req.body?.licenseKey || 'sin-licencia')}`,
  message: { ok: false, error: 'Demasiadas solicitudes para esta licencia. Inténtalo dentro de una hora.' },
});

const NO_VIVAS = new Set(['expired', 'revoked', 'revocada', 'cancelada', 'cancelled', 'blocked', 'trial']);

router.post('/copias/credenciales', porIP, porLicencia, async (req, res) => {
  const { licenseKey, hardwareId } = req.body || {};
  if (!licenseKey || typeof licenseKey !== 'string') return res.status(400).json({ ok: false, error: 'licenseKey requerida' });

  const lic = req.db.prepare('SELECT * FROM licencias WHERE licenseKey = ?').get(licenseKey);
  if (!lic) return res.status(404).json({ ok: false, error: 'Licencia no encontrada' });
  if (NO_VIVAS.has(String(lic.estado || '').toLowerCase())) {
    return res.status(403).json({ ok: false, error: 'licencia_no_activa' });
  }
  if (lic.hardwareId && lic.hardwareId !== hardwareId) {
    return res.status(403).json({ ok: false, error: 'hardware_mismatch' });
  }
  if (!lic.clinicaId) {
    return res.status(404).json({ ok: false, error: 'Esta licencia no tiene ninguna clínica asociada.' });
  }

  try {
    const c = await claveDeClinica(req.db, lic.clinicaId);
    // Se registra QUE se ha entregado y a quién, nunca la clave.
    console.log(`[copias] clave ${c.nueva ? 'CREADA' : 'entregada'} · clinica ${lic.clinicaId}`);
    return res.json({ ok: true, keyId: c.keyId, appKey: c.appKey, bucket: c.bucket, region: c.region, prefijo: c.prefijo });
  } catch (e) {
    console.error('[copias] no se pudo dar la clave a', lic.clinicaId, '—', e.message);
    return res.status(503).json({ ok: false, error: 'No disponible' });
  }
});

module.exports = router;
