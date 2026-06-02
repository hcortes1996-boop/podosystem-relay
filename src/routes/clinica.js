/**
 * clinica.js — Rutas protegidas para PodoSystem (requiere X-Api-Key)
 *
 *   GET /api/solicitudes                       — listar solicitudes pendientes
 *   PUT /api/solicitudes/:id/gestionar         — confirmar o rechazar
 *   GET /api/solicitudes/historial             — todas (incluye confirmadas/rechazadas)
 */

const router     = require('express').Router();
const auth       = require('../middleware/auth');
const { deployClientSite } = require('../netlify-deploy');

/* ── Activar citas web con código de un solo uso (público, sin auth) ──── */
router.post('/activar-citas', (req, res) => {
  const { activationCode } = req.body;
  if (!activationCode?.trim()) {
    return res.status(400).json({ ok: false, error: 'activationCode requerido' });
  }
  const code = activationCode.trim().toUpperCase();
  const clinica = req.db.prepare(
    'SELECT id, nombre, apiKey, webUrl, activation_code_used FROM clinicas WHERE activation_code = ? AND activa = 1'
  ).get(code);

  if (!clinica) {
    return res.status(404).json({ ok: false, error: 'Código de activación no válido. Comprueba que lo has introducido correctamente o solicita uno nuevo a soporte@podosystem.es' });
  }
  if (clinica.activation_code_used) {
    return res.status(409).json({ ok: false, error: 'Este código ya fue utilizado. Solicita un nuevo código a soporte@podosystem.es' });
  }

  req.db.prepare('UPDATE clinicas SET activation_code_used = 1 WHERE id = ?').run(clinica.id);

  const relayUrl = process.env.RELAY_URL || 'https://podosystem-relay-production.up.railway.app';
  res.json({ ok: true, clinicaId: clinica.id, apiKey: clinica.apiKey, relayUrl, webUrl: clinica.webUrl || null, nombre: clinica.nombre });
});

/* ── Listar solicitudes pendientes ────────────────────────────── */
router.get('/solicitudes', auth, (req, res) => {
  const { estado = 'pendiente', desde } = req.query;

  let sql  = 'SELECT id, nombre, telefono, email, motivo, fechaDeseada, horaDeseada, observaciones, estado, creadaEn FROM solicitudes WHERE clinicaId = ?';
  const params = [req.clinicaId];

  if (estado !== 'todas') {
    sql += ' AND estado = ?';
    params.push(estado);
  }

  if (desde) {
    sql += ' AND creadaEn >= ?';
    params.push(desde);
  }

  sql += ' ORDER BY creadaEn ASC';

  const solicitudes = req.db.prepare(sql).all(...params);
  res.json({ ok: true, solicitudes, total: solicitudes.length });
});

/* ── Gestionar solicitud (confirmar / rechazar) ───────────────── */
router.put('/solicitudes/:id/gestionar', auth, (req, res) => {
  const { id } = req.params;
  const { accion, citaId } = req.body;

  if (!['confirmar', 'rechazar'].includes(accion)) {
    return res.status(400).json({ ok: false, error: 'accion debe ser "confirmar" o "rechazar"' });
  }

  // Verificar que la solicitud pertenece a esta clínica
  const sol = req.db
    .prepare('SELECT id, estado FROM solicitudes WHERE id = ? AND clinicaId = ?')
    .get(id, req.clinicaId);

  if (!sol) {
    return res.status(404).json({ ok: false, error: 'Solicitud no encontrada' });
  }

  if (sol.estado !== 'pendiente') {
    return res.status(409).json({ ok: false, error: `La solicitud ya fue ${sol.estado}` });
  }

  const nuevoEstado = accion === 'confirmar' ? 'confirmada' : 'rechazada';

  req.db.prepare(`
    UPDATE solicitudes
    SET estado = ?, citaId = ?, gestionadaEn = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ?
  `).run(nuevoEstado, citaId || null, id);

  res.json({ ok: true, estado: nuevoEstado });
});

/* ── Datos de la clínica (webUrl, nombre) ─────────────────────── */
router.get('/mi-clinica', auth, (req, res) => {
  const clinica = req.db
    .prepare('SELECT id, nombre, webUrl FROM clinicas WHERE id = ?')
    .get(req.clinicaId);
  if (!clinica) return res.status(404).json({ ok: false, error: 'Clínica no encontrada' });
  res.json({ ok: true, clinicaId: clinica.id, nombre: clinica.nombre, webUrl: clinica.webUrl || null });
});

/* ── Activar web pública (deploy Netlify desde PodoSystem del cliente) ─── */
// Idempotente: si ya hay webUrl devuelve 409. El body trae los datos
// actuales de la clínica desde el PC; si llegan, sobrescriben los de BD
// (el PC es la verdad más reciente). Si no llegan, se usan los de BD.
router.post('/mi-clinica/activar-web', auth, async (req, res) => {
  const clinica = req.db.prepare(
    'SELECT nombre, webUrl, telefono, ciudad, direccion FROM clinicas WHERE id = ?'
  ).get(req.clinicaId);
  if (!clinica) return res.status(404).json({ ok: false, error: 'Clínica no encontrada' });
  if (clinica.webUrl) {
    return res.status(409).json({ ok: false, message: 'Ya tienes web activada', webUrl: clinica.webUrl });
  }
  if (!process.env.NETLIFY_TOKEN) {
    return res.status(503).json({ ok: false, error: 'Servicio temporalmente no disponible. Contacta soporte si persiste.' });
  }

  const body = req.body || {};
  const nombreFinal    = (body.nombre    || clinica.nombre    || '').trim();
  const ciudadFinal    = (body.ciudad    || clinica.ciudad    || '').trim();
  const direccionFinal = (body.direccion || clinica.direccion || '').trim();
  const telefonoFinal  = (body.telefono  || clinica.telefono  || '').trim();

  // Sincroniza BD con los datos del PC (el cliente puede haberlos modificado
  // localmente desde que se aprobó la solicitud).
  try {
    req.db.prepare(`
      UPDATE clinicas SET nombre = ?, telefono = ?, ciudad = ?, direccion = ?
      WHERE id = ?
    `).run(nombreFinal, telefonoFinal, ciudadFinal, direccionFinal, req.clinicaId);
  } catch (e) {
    console.error('[activar-web] UPDATE datos error:', e.message);
  }

  try {
    const result = await deployClientSite({
      clinicaId: req.clinicaId,
      nombre:    nombreFinal,
      ciudad:    ciudadFinal,
      direccion: direccionFinal,
      telefono:  telefonoFinal,
    });
    req.db.prepare('UPDATE clinicas SET webUrl=?, netlifyId=? WHERE id=?')
      .run(result.webUrl, result.netlifyId, req.clinicaId);
    console.log(`[activar-web] OK clinica=${req.clinicaId} → ${result.webUrl}`);
    res.json({ ok: true, webUrl: result.webUrl });
  } catch (e) {
    console.error('[activar-web] Deploy error:', e.message);
    res.status(500).json({ ok: false, error: 'Error temporal al crear tu web. Inténtalo de nuevo en unos minutos o contacta soporte si persiste.' });
  }
});

/* ── Subir logo de la clínica ─────────────────────────────────── */
router.put('/logo', auth, (req, res) => {
  const { logoBase64 } = req.body;
  if (!logoBase64) return res.status(400).json({ ok: false, error: 'logoBase64 requerido' });
  try {
    const buf = Buffer.from(logoBase64, 'base64');
    req.db.prepare('UPDATE clinicas SET logo = ? WHERE id = ?').run(buf, req.clinicaId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
