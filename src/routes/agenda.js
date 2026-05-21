/**
 * agenda.js — Sincronización de agenda y cálculo de huecos libres
 *
 *   PUT    /api/sync-agenda                 (X-Api-Key) — PodoSystem sincroniza horario + citas
 *   PUT    /api/agenda-snapshot             (X-Api-Key) — PodoSystem pushea snapshot completo
 *   GET    /api/agenda-snapshot             (X-Api-Key) — APK lee el snapshot de citas
 *   POST   /api/citas-remote               (X-Api-Key) — APK crea cita en modo remoto
 *   PUT    /api/citas-remote/:citaId        (X-Api-Key) — APK edita cita en modo remoto
 *   DELETE /api/citas-remote/:citaId        (X-Api-Key) — APK cancela cita en modo remoto
 *   GET    /api/citas-remote/pendientes     (X-Api-Key) — PC descarga ops pendientes
 *   POST   /api/citas-remote/sincronizadas  (X-Api-Key) — PC marca ops como sincronizadas
 *   GET    /api/dias-disponibles/:id        (público)   — días con huecos en el rango publicado
 *   GET    /api/slots/:id/:fecha            (público)   — huecos libres de un día concreto
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
    // BUGFIX: Re-bloquear reservas web pendientes para que el sync de PodoSystem
    // no libere slots que ya tienen una reserva online sin confirmar todavía.
    const pendientes = req.db.prepare(
      `SELECT fecha, hora, duracion FROM reservas WHERE clinicaId = ? AND estado = 'pendiente_pc'`
    ).all(req.clinicaId);
    for (const r of pendientes) {
      if (r.fecha && r.hora) ins.run(req.clinicaId, r.fecha, r.hora, r.duracion || 30);
    }
  });
  insertAll(citasOcupadas || []);

  res.json({ ok: true, citasSincronizadas: (citasOcupadas || []).length });
});

/* ── Snapshot completo de agenda (para APK en modo remoto) ─────── */

router.put('/agenda-snapshot', auth, (req, res) => {
  const { citas, horarioClinica } = req.body;
  if (!Array.isArray(citas)) return res.status(400).json({ ok: false, error: 'citas debe ser array' });
  req.db.prepare(`
    INSERT INTO agenda_snapshot (clinicaId, citas, horarioClinica, updatedAt)
    VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(clinicaId) DO UPDATE SET
      citas=excluded.citas,
      horarioClinica=excluded.horarioClinica,
      updatedAt=excluded.updatedAt
  `).run(req.clinicaId, JSON.stringify(citas), horarioClinica ? JSON.stringify(horarioClinica) : null);
  res.json({ ok: true, count: citas.length });
});

router.get('/agenda-snapshot', auth, (req, res) => {
  const row = req.db.prepare('SELECT citas, horarioClinica, updatedAt FROM agenda_snapshot WHERE clinicaId = ?').get(req.clinicaId);
  if (!row) return res.json({ ok: true, citas: [], updatedAt: null });
  res.json({
    ok: true,
    citas: JSON.parse(row.citas || '[]'),
    horarioClinica: row.horarioClinica ? JSON.parse(row.horarioClinica) : null,
    updatedAt: row.updatedAt
  });
});

/* ── CRUD remoto desde APK en modo remoto ────────────────────── */

const { genId } = require('../db');

// Actualiza el snapshot en memoria al aplicar una operación remota.
// IMPORTANTE: llamar DESPUÉS de _actualizarCitasOcupadas para delete/edit,
// ya que ésta lee el snapshot original para obtener el slot previo.
function _applyToSnapshot(db, clinicaId, op, data) {
  const row = db.prepare('SELECT citas FROM agenda_snapshot WHERE clinicaId = ?').get(clinicaId);
  let citas = row ? JSON.parse(row.citas || '[]') : [];
  if (op === 'add') {
    citas = citas.filter(c => c.id !== data.id);
    citas.push(data);
  } else if (op === 'edit') {
    citas = citas.map(c => c.id === data.id ? { ...c, ...data } : c);
  } else if (op === 'delete') {
    citas = citas.filter(c => c.id !== data.id);
  }
  // Solo actualiza citas y updatedAt — horarioClinica se preserva automáticamente
  // porque ON CONFLICT no la menciona y el INSERT no la incluye.
  db.prepare(`
    INSERT INTO agenda_snapshot (clinicaId, citas, updatedAt)
    VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(clinicaId) DO UPDATE SET citas=excluded.citas, updatedAt=excluded.updatedAt
  `).run(clinicaId, JSON.stringify(citas));
}

// Mantiene citas_ocupadas sincronizada en tiempo real cuando la APK opera en modo remoto.
// Cierra la ventana de colisión entre citas remotas y reservas web de pacientes.
// Para delete/edit debe llamarse ANTES de _applyToSnapshot (necesita leer el snapshot original).
function _actualizarCitasOcupadas(db, clinicaId, op, citaData) {
  const reprotegerSlot = (fecha, hora) => {
    // Restaura el bloqueo si había una reserva web pendiente en ese mismo slot
    db.prepare(`
      INSERT OR IGNORE INTO citas_ocupadas (clinicaId, fecha, hora, duracion)
      SELECT clinicaId, fecha, hora, duracion FROM reservas
      WHERE clinicaId = ? AND fecha = ? AND hora = ? AND estado = 'pendiente_pc'
    `).run(clinicaId, fecha, hora);
  };

  if (op === 'add') {
    if (!citaData.fecha || !citaData.hora) return;
    db.prepare('INSERT OR IGNORE INTO citas_ocupadas (clinicaId, fecha, hora, duracion) VALUES (?,?,?,?)')
      .run(clinicaId, citaData.fecha, citaData.hora, citaData.duracion || 30);
    return;
  }

  // Para edit y delete, leer el slot original del snapshot antes de modificarlo
  const snapshotRow = db.prepare('SELECT citas FROM agenda_snapshot WHERE clinicaId = ?').get(clinicaId);
  const citasActuales = snapshotRow ? JSON.parse(snapshotRow.citas || '[]') : [];
  const original = citasActuales.find(c => c.id === citaData.id);

  if (op === 'delete') {
    if (!original?.fecha || !original?.hora) return;
    db.prepare('DELETE FROM citas_ocupadas WHERE clinicaId = ? AND fecha = ? AND hora = ?')
      .run(clinicaId, original.fecha, original.hora);
    reprotegerSlot(original.fecha, original.hora);
    return;
  }

  if (op === 'edit') {
    const fechaNueva = citaData.fecha || original?.fecha;
    const horaNueva  = citaData.hora  || original?.hora;
    const durNueva   = citaData.duracion || original?.duracion || 30;
    const mismoSlot  = fechaNueva === original?.fecha && horaNueva === original?.hora;

    if (!mismoSlot && original?.fecha && original?.hora) {
      // Liberar slot anterior
      db.prepare('DELETE FROM citas_ocupadas WHERE clinicaId = ? AND fecha = ? AND hora = ?')
        .run(clinicaId, original.fecha, original.hora);
      reprotegerSlot(original.fecha, original.hora);
    }
    if (fechaNueva && horaNueva) {
      db.prepare('INSERT OR IGNORE INTO citas_ocupadas (clinicaId, fecha, hora, duracion) VALUES (?,?,?,?)')
        .run(clinicaId, fechaNueva, horaNueva, durNueva);
    }
  }
}

router.post('/citas-remote', auth, (req, res) => {
  const cita = req.body;
  if (!cita.id || !cita.fecha || !cita.hora) return res.status(400).json({ ok: false, error: 'id, fecha, hora requeridos' });
  const opId = genId(12);
  req.db.prepare('INSERT INTO citas_remote_ops (id, clinicaId, op, citaId, citaData) VALUES (?,?,?,?,?)')
    .run(opId, req.clinicaId, 'add', cita.id, JSON.stringify(cita));
  _actualizarCitasOcupadas(req.db, req.clinicaId, 'add', cita);
  _applyToSnapshot(req.db, req.clinicaId, 'add', cita);
  res.json({ ok: true, opId });
});

router.put('/citas-remote/:citaId', auth, (req, res) => {
  const { citaId } = req.params;
  const cambios = req.body;
  const opId = genId(12);
  req.db.prepare('INSERT INTO citas_remote_ops (id, clinicaId, op, citaId, citaData) VALUES (?,?,?,?,?)')
    .run(opId, req.clinicaId, 'edit', citaId, JSON.stringify({ id: citaId, ...cambios }));
  _actualizarCitasOcupadas(req.db, req.clinicaId, 'edit', { id: citaId, ...cambios });
  _applyToSnapshot(req.db, req.clinicaId, 'edit', { id: citaId, ...cambios });
  res.json({ ok: true, opId });
});

router.delete('/citas-remote/:citaId', auth, (req, res) => {
  const { citaId } = req.params;
  const opId = genId(12);
  req.db.prepare('INSERT INTO citas_remote_ops (id, clinicaId, op, citaId, citaData) VALUES (?,?,?,?,?)')
    .run(opId, req.clinicaId, 'delete', citaId, '{}');
  _actualizarCitasOcupadas(req.db, req.clinicaId, 'delete', { id: citaId });
  _applyToSnapshot(req.db, req.clinicaId, 'delete', { id: citaId });
  res.json({ ok: true, opId });
});

router.get('/citas-remote/pendientes', auth, (req, res) => {
  const ops = req.db.prepare(`
    SELECT id, op, citaId, citaData, createdAt
    FROM citas_remote_ops
    WHERE clinicaId = ? AND syncedAt IS NULL
    ORDER BY createdAt ASC
  `).all(req.clinicaId);
  res.json({ ok: true, ops: ops.map(o => ({ ...o, citaData: JSON.parse(o.citaData) })) });
});

router.post('/citas-remote/sincronizadas', auth, (req, res) => {
  const { opIds } = req.body;
  if (!Array.isArray(opIds) || !opIds.length) return res.status(400).json({ ok: false, error: 'opIds requerido' });
  const now = new Date().toISOString();
  const stmt = req.db.prepare('UPDATE citas_remote_ops SET syncedAt=? WHERE id=? AND clinicaId=?');
  req.db.transaction(() => { opIds.forEach(id => stmt.run(now, id, req.clinicaId)); })();
  res.json({ ok: true, count: opIds.length });
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
  if (!nDias || nDias <= 0) return new Date(base);
  // Seguridad: si el horario no tiene días laborables, usar días naturales
  const tieneHorario = Object.keys(horario || {}).some(k => horario[k]?.length > 0);
  if (!tieneHorario) {
    const d = new Date(base);
    d.setDate(d.getDate() + nDias);
    return d;
  }
  const d = new Date(base);
  let sumados = 0;
  let maxIter = nDias * 14; // límite de seguridad absoluto
  while (sumados < nDias && maxIter-- > 0) {
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
      // Comprobar que el slot sigue libre (doble check: citas_ocupadas + reservas pendientes)
      // Solo bloqueamos por reservas 'pendiente_pc': una reserva 'sincronizada' ya fue
      // procesada por PodoSystem y su slot se gestiona exclusivamente vía citas_ocupadas.
      // Si la cita local fue eliminada, el sync la quitó de citas_ocupadas → slot libre.
      const ocupado = req.db
        .prepare('SELECT 1 FROM citas_ocupadas WHERE clinicaId = ? AND fecha = ? AND hora = ?')
        .get(clinicaId, fecha, hora)
        || req.db
          .prepare(`SELECT 1 FROM reservas WHERE clinicaId = ? AND fecha = ? AND hora = ? AND estado = 'pendiente_pc'`)
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

/* ── Vista semanal con estado de slots (público) ──────────────── */
// GET /api/semana/:clinicaId?semana=YYYY-MM-DD
// Returns full week slot grid with libre/ocupado status
router.get('/semana/:clinicaId', (req, res) => {
  const clinica = req.db
    .prepare('SELECT id FROM clinicas WHERE id = ? AND activa = 1')
    .get(req.params.clinicaId);
  if (!clinica) return res.status(404).json({ ok: false, error: 'Clínica no encontrada' });

  const row = req.db
    .prepare('SELECT config FROM agenda_config WHERE clinicaId = ?')
    .get(req.params.clinicaId);
  if (!row) return res.json({ ok: true, dias: [], duracionSlot: 30, semanaInicio: null });

  const cfg = JSON.parse(row.config);
  const { duracionSlot = 30, diasMin = 1, diasMax = 14, horario = {} } = cfg;

  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);

  // Ventana de reserva en días hábiles
  const fechaInicio = diasMin > 0 ? sumarDiasHabiles(hoy, diasMin, horario) : new Date(hoy);
  const fechaFin    = sumarDiasHabiles(hoy, diasMax, horario);
  fechaInicio.setHours(12, 0, 0, 0);
  fechaFin.setHours(12, 0, 0, 0);

  // Ventana de inicio: ?desde=YYYY-MM-DD (rolling) o ?semana=YYYY-MM-DD (lunes fijo, compat.)
  // Por defecto: primer día disponible (ventanaInicio)
  let semanaInicio = new Date(fechaInicio);
  if (req.query.desde && /^\d{4}-\d{2}-\d{2}$/.test(req.query.desde)) {
    semanaInicio = new Date(req.query.desde + 'T12:00:00Z');
  } else if (req.query.semana && /^\d{4}-\d{2}-\d{2}$/.test(req.query.semana)) {
    semanaInicio = new Date(req.query.semana + 'T12:00:00Z');
    // compat: ajustar al lunes
    const dow = semanaInicio.getUTCDay();
    semanaInicio.setUTCDate(semanaInicio.getUTCDate() - (dow === 0 ? 6 : dow - 1));
  }
  semanaInicio.setHours(12, 0, 0, 0);

  const NOMBRES = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
  const dias = [];

  for (let i = 0; i < 7; i++) {
    const d = new Date(semanaInicio);
    d.setDate(semanaInicio.getDate() + i);
    d.setHours(12, 0, 0, 0);
    const fechaStr = d.toISOString().slice(0, 10);
    const diaSemana = String(d.getDay());
    const franjas = horario[diaSemana] || [];

    const enVentana = d >= fechaInicio && d <= fechaFin;
    const bloqueada = !!req.db
      .prepare('SELECT 1 FROM bloqueos WHERE clinicaId = ? AND fecha = ?')
      .get(req.params.clinicaId, fechaStr);

    let slots = [];
    if (franjas.length > 0) {
      const todosSlots = generarSlots(franjas, duracionSlot);
      if (enVentana && !bloqueada) {
        const ocupadas = req.db
          .prepare('SELECT hora, duracion FROM citas_ocupadas WHERE clinicaId = ? AND fecha = ?')
          .all(req.params.clinicaId, fechaStr);
        const libresArray = slotLibres(todosSlots, ocupadas, duracionSlot);
        const libresSet = new Set(libresArray);
        slots = todosSlots.map(hora => ({ hora, libre: libresSet.has(hora) }));
      } else {
        // Día laboral pero fuera de ventana o bloqueado → todo ocupado/no disponible
        slots = todosSlots.map(hora => ({ hora, libre: false, motivo: bloqueada ? 'bloqueado' : 'fuera_ventana' }));
      }
    }

    dias.push({
      fecha: fechaStr,
      nombre: NOMBRES[d.getDay()],
      dia: d.getDate(),
      mes: d.getMonth() + 1,
      diaSemana,
      trabajado: franjas.length > 0,
      enVentana,
      bloqueada,
      slots
    });
  }

  res.json({
    ok: true,
    dias,
    duracionSlot,
    semanaInicio: semanaInicio.toISOString().slice(0, 10),
    ventanaInicio: fechaInicio.toISOString().slice(0, 10),
    ventanaFin: fechaFin.toISOString().slice(0, 10)
  });
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

/* ── PodoSystem obtiene historial de reservas recientes (todas) ── */
router.get('/reservas-recientes', auth, (req, res) => {
  const dias = Math.min(parseInt(req.query.dias) || 30, 90);
  const desde = new Date(Date.now() - dias * 86400000).toISOString();
  const reservas = req.db
    .prepare(`SELECT * FROM reservas WHERE clinicaId = ? AND creadaEn >= ? ORDER BY creadaEn DESC`)
    .all(req.clinicaId, desde);
  res.json({ ok: true, reservas });
});

/* ── PodoSystem cancela una reserva (libera el slot) ─────────── */
router.put('/reservas/:id/cancelar', auth, (req, res) => {
  const reserva = req.db
    .prepare('SELECT id, fecha, hora FROM reservas WHERE id = ? AND clinicaId = ?')
    .get(req.params.id, req.clinicaId);
  if (!reserva) return res.status(404).json({ ok: false, error: 'Reserva no encontrada' });

  req.db.prepare(`UPDATE reservas SET estado = 'cancelada' WHERE id = ?`).run(req.params.id);
  // Liberar el slot de citas_ocupadas (si solo lo bloqueaba esta reserva)
  req.db.prepare('DELETE FROM citas_ocupadas WHERE clinicaId = ? AND fecha = ? AND hora = ?')
    .run(req.clinicaId, reserva.fecha, reserva.hora);
  res.json({ ok: true });
});

/* ── PodoSystem reactiva una reserva sincronizada (recuperación) ── */
router.put('/reservas/:id/pendiente', auth, (req, res) => {
  const reserva = req.db
    .prepare('SELECT id FROM reservas WHERE id = ? AND clinicaId = ?')
    .get(req.params.id, req.clinicaId);
  if (!reserva) return res.status(404).json({ ok: false, error: 'Reserva no encontrada' });

  req.db.prepare(`UPDATE reservas SET estado = 'pendiente_pc' WHERE id = ?`).run(req.params.id);
  // Re-bloquear el slot
  req.db.prepare('INSERT OR IGNORE INTO citas_ocupadas (clinicaId, fecha, hora, duracion) SELECT clinicaId, fecha, hora, duracion FROM reservas WHERE id = ?')
    .run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
