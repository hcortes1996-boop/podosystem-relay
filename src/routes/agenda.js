/**
 * agenda.js — Sincronización de agenda y cálculo de huecos libres
 *
 *   PUT /api/sync-agenda          (X-Api-Key) — PodoSystem sincroniza horario + citas
 *   GET /api/dias-disponibles/:id (público)   — días con huecos en el rango publicado
 *   GET /api/slots/:id/:fecha     (público)   — huecos libres de un día concreto
 */

const router = require('express').Router();
const auth   = require('../middleware/auth');

/* ── PodoSystem sincroniza horario y citas ────────────────────── */
// Body: { config: {...}, citasOcupadas: [{fecha, hora, duracion}] }
//
// config = {
//   duracionSlot: 30,        // minutos por hueco
//   diasMin: 2,              // publicar desde hoy+N
//   diasMax: 14,             // publicar hasta hoy+M
//   horario: {               // 0=Dom ... 6=Sáb
//     "1": [{ inicio:"09:30", fin:"13:00" }, { inicio:"17:00", fin:"19:45" }],
//     "4": [{ inicio:"09:30", fin:"13:00" }],  // Jueves solo mañana
//     ...
//   }
// }
router.put('/sync-agenda', auth, (req, res) => {
  const { config, citasOcupadas } = req.body;
  if (!config) return res.status(400).json({ ok: false, error: 'Falta config' });

  // Guardar config
  req.db.prepare(`
    INSERT INTO agenda_config (clinicaId, config, updatedAt)
    VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(clinicaId) DO UPDATE SET config=excluded.config, updatedAt=excluded.updatedAt
  `).run(req.clinicaId, JSON.stringify(config));

  // Reemplazar citas ocupadas (solo las del rango publicado)
  req.db.prepare('DELETE FROM citas_ocupadas WHERE clinicaId = ?').run(req.clinicaId);
  const ins = req.db.prepare('INSERT OR IGNORE INTO citas_ocupadas (clinicaId, fecha, hora, duracion) VALUES (?,?,?,?)');
  const insertAll = req.db.transaction((citas) => {
    for (const c of (citas || [])) {
      if (c.fecha && c.hora) ins.run(req.clinicaId, c.fecha, c.hora, c.duracion || 30);
    }
  });
  insertAll(citasOcupadas || []);

  res.json({ ok: true, citasSincronizadas: (citasOcupadas || []).length });
});

/* ── Helpers de cálculo ───────────────────────────────────────── */

function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function minutesToTime(m) {
  return `${String(Math.floor(m / 60)).padStart(2,'0')}:${String(m % 60).padStart(2,'0')}`;
}

// Genera todos los slots de un día según el horario
function generarSlots(franjas, duracion) {
  const slots = [];
  for (const f of franjas) {
    let cur = timeToMinutes(f.inicio);
    const end = timeToMinutes(f.fin);
    while (cur + duracion <= end) {
      slots.push(minutesToTime(cur));
      cur += duracion;
    }
  }
  return slots;
}

// Devuelve los slots libres de una fecha dado las citas ocupadas
function slotLibres(slots, ocupadas, duracion) {
  return slots.filter(slot => {
    const slotMin = timeToMinutes(slot);
    return !ocupadas.some(oc => {
      const ocMin  = timeToMinutes(oc.hora);
      const ocFin  = ocMin + (oc.duracion || duracion);
      const slotFin = slotMin + duracion;
      // Solapamiento
      return slotMin < ocFin && slotFin > ocMin;
    });
  });
}

/* ── Helper: sumar N días hábiles según horario ───────────────── */
function sumarDiasHabiles(base, nDias, horario) {
  const d = new Date(base);
  let sumados = 0;
  while (sumados < nDias) {
    d.setDate(d.getDate() + 1);
    const dia = String(d.getDay());
    if (horario[dia] && horario[dia].length > 0) sumados++;
  }
  return d;
}

/* ── Días disponibles (público) ───────────────────────────────── */
router.get('/dias-disponibles/:clinicaId', (req, res) => {
  const clinica = req.db
    .prepare('SELECT id FROM clinicas WHERE id = ? AND activa = 1')
    .get(req.params.clinicaId);
  if (!clinica) return res.status(404).json({ ok: false, error: 'Clínica no encontrada' });

  const row = req.db
    .prepare('SELECT config FROM agenda_config WHERE clinicaId = ?')
    .get(req.params.clinicaId);

  if (!row) return res.json({ ok: true, dias: [] });

  const cfg = JSON.parse(row.config);
  const { duracionSlot = 30, diasMin = 1, diasMax = 14, horario = {} } = cfg;

  const diasDisponibles = [];
  const hoy = new Date();

  // Calcular ventana en días hábiles
  const fechaInicio = diasMin > 0 ? sumarDiasHabiles(hoy, diasMin, horario) : new Date(hoy);
  const fechaFin    = sumarDiasHabiles(hoy, diasMax, horario);

  const cursor = new Date(fechaInicio);
  cursor.setHours(12, 0, 0, 0);
  fechaFin.setHours(12, 0, 0, 0);

  while (cursor <= fechaFin) {
    const fechaStr = cursor.toISOString().slice(0, 10);
    const diaSemana = String(cursor.getDay());

    const franjas = horario[diaSemana] || [];
    if (franjas.length > 0) {
      // Comprobar si está bloqueada
      const bloqueada = req.db
        .prepare('SELECT 1 FROM bloqueos WHERE clinicaId = ? AND fecha = ?')
        .get(req.params.clinicaId, fechaStr);

      if (!bloqueada) {
        const todosSlots = generarSlots(franjas, duracionSlot);
        const ocupadas = req.db
          .prepare('SELECT hora, duracion FROM citas_ocupadas WHERE clinicaId = ? AND fecha = ?')
          .all(req.params.clinicaId, fechaStr);
        const libres = slotLibres(todosSlots, ocupadas, duracionSlot);
        if (libres.length > 0) {
          diasDisponibles.push({ fecha: fechaStr, huecos: libres.length });
        }
      }
    }

    cursor.setDate(cursor.getDate() + 1);
  }

  res.json({ ok: true, dias: diasDisponibles, duracionSlot, diasMin, diasMax });
});

/* ── Slots libres de un día concreto (público) ────────────────── */
router.get('/slots/:clinicaId/:fecha', (req, res) => {
  const clinica = req.db
    .prepare('SELECT id FROM clinicas WHERE id = ? AND activa = 1')
    .get(req.params.clinicaId);
  if (!clinica) return res.status(404).json({ ok: false, error: 'Clínica no encontrada' });

  const { fecha } = req.params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    return res.status(400).json({ ok: false, error: 'Formato de fecha inválido' });
  }

  const bloqueada = req.db
    .prepare('SELECT 1 FROM bloqueos WHERE clinicaId = ? AND fecha = ?')
    .get(req.params.clinicaId, fecha);
  if (bloqueada) return res.json({ ok: true, slots: [], motivo: 'bloqueada' });

  const row = req.db
    .prepare('SELECT config FROM agenda_config WHERE clinicaId = ?')
    .get(req.params.clinicaId);
  if (!row) return res.json({ ok: true, slots: [] });

  const cfg = JSON.parse(row.config);
  const { duracionSlot = 30, horario = {} } = cfg;

  const d = new Date(fecha + 'T12:00:00Z');
  const diaSemana = String(d.getUTCDay());
  const franjas = horario[diaSemana] || [];

  const todosSlots = generarSlots(franjas, duracionSlot);
  const ocupadas = req.db
    .prepare('SELECT hora, duracion FROM citas_ocupadas WHERE clinicaId = ? AND fecha = ?')
    .all(req.params.clinicaId, fecha);

  const libres = slotLibres(todosSlots, ocupadas, duracionSlot);

  res.json({ ok: true, fecha, slots: libres, duracionSlot });
});

/* ── Reservar slot directamente (público, atómico) ────────────── */
router.post('/reservar-slot', (req, res) => {
  const { clinicaId, fecha, hora, nombre, telefono, email, motivo, observaciones } = req.body;

  if (!clinicaId || !fecha || !hora || !nombre?.trim() || !telefono?.trim()) {
    return res.status(400).json({ ok: false, error: 'Faltan campos obligatorios' });
  }

  const clinica = req.db
    .prepare('SELECT id FROM clinicas WHERE id = ? AND activa = 1')
    .get(clinicaId);
  if (!clinica) return res.status(400).json({ ok: false, error: 'Clínica no encontrada' });

  // Bloqueo atómico: verificar y reservar en una sola transacción
  const { genId } = require('../db');
  const id = 'res_' + genId(10);

  try {
    const resultado = req.db.transaction(() => {
      // Comprobar que el slot sigue libre
      const ocupado = req.db
        .prepare('SELECT 1 FROM citas_ocupadas WHERE clinicaId = ? AND fecha = ? AND hora = ?')
        .get(clinicaId, fecha, hora);
      if (ocupado) return null;

      // Obtener duración del slot de la config
      const cfgRow = req.db.prepare('SELECT config FROM agenda_config WHERE clinicaId = ?').get(clinicaId);
      const duracion = cfgRow ? (JSON.parse(cfgRow.config).duracionSlot || 30) : 30;

      // Bloquear el slot inmediatamente
      req.db.prepare('INSERT OR IGNORE INTO citas_ocupadas (clinicaId, fecha, hora, duracion) VALUES (?,?,?,?)')
        .run(clinicaId, fecha, hora, duracion);

      // Crear la reserva
      req.db.prepare(`
        INSERT INTO reservas (id, clinicaId, fecha, hora, duracion, nombre, telefono, email, motivo, observaciones)
        VALUES (?,?,?,?,?,?,?,?,?,?)
      `).run(id, clinicaId, fecha, hora, duracion, nombre.trim(), telefono.trim(),
        email?.trim() || null, motivo || null, observaciones?.trim() || null);

      return { id, duracion };
    })();

    if (!resultado) {
      return res.status(409).json({ ok: false, error: 'Este horario ya ha sido reservado. Por favor, elija otro.' });
    }

    res.status(201).json({
      ok: true,
      reservaId: id,
      fecha, hora,
      mensaje: '¡Cita reservada! Le contactaremos si hay algún cambio.'
    });
  } catch (e) {
    console.error('[reservar-slot]', e);
    res.status(500).json({ ok: false, error: 'Error al procesar la reserva' });
  }
});

/* ── PodoSystem obtiene reservas web pendientes ───────────────── */
router.get('/reservas-nuevas', auth, (req, res) => {
  const reservas = req.db
    .prepare(`SELECT * FROM reservas WHERE clinicaId = ? AND estado = 'pendiente_pc' ORDER BY creadaEn ASC`)
    .all(req.clinicaId);
  res.json({ ok: true, reservas });
});

/* ── PodoSystem marca reserva como sincronizada ───────────────── */
router.put('/reservas/:id/sincronizar', auth, (req, res) => {
  const reserva = req.db
    .prepare('SELECT id FROM reservas WHERE id = ? AND clinicaId = ?')
    .get(req.params.id, req.clinicaId);
  if (!reserva) return res.status(404).json({ ok: false, error: 'Reserva no encontrada' });

  req.db.prepare(`UPDATE reservas SET estado = 'sincronizada' WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
