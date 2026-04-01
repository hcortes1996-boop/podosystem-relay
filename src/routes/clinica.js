/**
 * clinica.js — Rutas protegidas para PodoSystem (requiere X-Api-Key)
 *
 *   GET /api/solicitudes                       — listar solicitudes pendientes
 *   PUT /api/solicitudes/:id/gestionar         — confirmar o rechazar
 *   GET /api/solicitudes/historial             — todas (incluye confirmadas/rechazadas)
 */

const router     = require('express').Router();
const auth       = require('../middleware/auth');

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

module.exports = router;
