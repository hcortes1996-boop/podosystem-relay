/**
 * bloqueos.js — Gestión de días bloqueados para citas web
 *
 *   PUT /api/bloqueo-web          (X-Api-Key) — PodoSystem establece días bloqueados
 *   GET /api/disponibilidad/:id   (público)   — web consulta fechas bloqueadas
 */

const router = require('express').Router();
const auth   = require('../middleware/auth');

/* ── PodoSystem establece bloqueo ─────────────────────────────── */
// Body: { fechas: ['2026-04-01', '2026-04-02'] }
// Para quitar el bloqueo: { fechas: [] }
router.put('/bloqueo-web', auth, (req, res) => {
  const { fechas } = req.body;
  if (!Array.isArray(fechas)) {
    return res.status(400).json({ ok: false, error: '"fechas" debe ser un array de strings YYYY-MM-DD' });
  }

  // Validar formato de fechas
  const isoDate = /^\d{4}-\d{2}-\d{2}$/;
  for (const f of fechas) {
    if (!isoDate.test(f)) {
      return res.status(400).json({ ok: false, error: `Fecha con formato incorrecto: ${f}` });
    }
  }

  // Reemplazar bloqueos actuales de esta clínica
  const del = req.db.prepare('DELETE FROM bloqueos WHERE clinicaId = ?');
  const ins = req.db.prepare('INSERT OR IGNORE INTO bloqueos (clinicaId, fecha) VALUES (?, ?)');

  const update = req.db.transaction(() => {
    del.run(req.clinicaId);
    for (const fecha of fechas) {
      ins.run(req.clinicaId, fecha);
    }
  });
  update();

  res.json({ ok: true, fechasBloqueadas: fechas });
});

/* ── Web consulta fechas bloqueadas (público) ─────────────────── */
router.get('/disponibilidad/:clinicaId', (req, res) => {
  const clinica = req.db
    .prepare('SELECT id FROM clinicas WHERE id = ? AND activa = 1')
    .get(req.params.clinicaId);

  if (!clinica) {
    return res.status(404).json({ ok: false, error: 'Clínica no encontrada' });
  }

  const filas = req.db
    .prepare('SELECT fecha FROM bloqueos WHERE clinicaId = ? ORDER BY fecha ASC')
    .all(req.params.clinicaId);

  res.json({
    ok: true,
    clinicaId: req.params.clinicaId,
    fechasBloqueadas: filas.map(f => f.fecha)
  });
});

module.exports = router;
