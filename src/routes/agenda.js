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
  const { config, citasOcupadas, podologos, citasOcupadasPorPodologo, ventana } = req.body;
  if (!config) return res.status(400).json({ ok: false, error: 'Falta config' });

  // Incidente 08-2026 — Fix 4 degradado: avisar, no rechazar.
  //
  // Un envío vacío borra toda la ocupación (DELETE + INSERT más abajo) y deja la
  // agenda entera reservable. Eso ocurrió por un filtro que se quedó sin elementos.
  // Pero un vacío también es legítimo (agosto, cancelación masiva), y rechazarlo
  // dejaría ocupación vieja pegada bloqueando huecos reales — sobre todo en PC que
  // nunca enviarán una bandera explícita. Se registra para poder detectarlo.
  const previas = req.db
    .prepare('SELECT COUNT(*) AS n FROM citas_ocupadas WHERE clinicaId = ?')
    .get(req.clinicaId).n;
  const entrantes = (citasOcupadas || []).length;
  if (previas > 0 && entrantes === 0) {
    console.warn(`[sync-agenda] ⚠️  ${req.clinicaId}: ocupación pasa de ${previas} a 0. ` +
                 `Si la agenda no está realmente vacía, es el Bug B del incidente 08-2026.`);
  }

  // Guardar config. `ventana` (opcional, PC ≥3.3.2) declara el rango que el PC
  // cubre de verdad; ventanaFin() acota la oferta a él para no ofertar días sin
  // datos de ocupación. Los PC que no la envían mantienen el comportamiento previo.
  const configAGuardar = ventana && typeof ventana === 'object'
    ? { ...config, ventana }
    : config;
  req.db.prepare(`
    INSERT INTO agenda_config (clinicaId, config, updatedAt)
    VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(clinicaId) DO UPDATE SET config=excluded.config, updatedAt=excluded.updatedAt
  `).run(req.clinicaId, JSON.stringify(configAGuardar));

  // Reemplazar citas_ocupadas (agregadas, sin podologoId — legacy)
  req.db.prepare('DELETE FROM citas_ocupadas WHERE clinicaId = ?').run(req.clinicaId);
  const insOcupadas = req.db.prepare('INSERT OR IGNORE INTO citas_ocupadas (clinicaId, fecha, hora, duracion) VALUES (?,?,?,?)');
  const insertAllOcupadas = req.db.transaction((citas) => {
    for (const c of (citas || [])) {
      if (c.fecha && c.hora) insOcupadas.run(req.clinicaId, c.fecha, c.hora, c.duracion || 30);
    }
    // BUGFIX: Re-bloquear reservas web pendientes SIN podologoId (legacy)
    const pendientesAgregadas = req.db.prepare(
      `SELECT fecha, hora, duracion FROM reservas WHERE clinicaId = ? AND estado = 'pendiente_pc' AND podologoId IS NULL`
    ).all(req.clinicaId);
    for (const r of pendientesAgregadas) {
      if (r.fecha && r.hora) insOcupadas.run(req.clinicaId, r.fecha, r.hora, r.duracion || 30);
    }
  });
  insertAllOcupadas(citasOcupadas || []);

  // Pieza 3.3 — Upsert podologos_publicos si viene en el payload
  if (Array.isArray(podologos)) {
    const insPod = req.db.prepare(`
      INSERT INTO podologos_publicos (clinicaId, id, nombre, apellido, color, orden, descripcionPublica, horarioPublico, visibleEnWeb, activo, updatedAt)
      VALUES (?,?,?,?,?,?,?,?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    `);
    const upsertPodologos = req.db.transaction((arr) => {
      req.db.prepare('DELETE FROM podologos_publicos WHERE clinicaId = ?').run(req.clinicaId);
      for (const p of arr) {
        if (!p.id || !p.nombre) continue;
        insPod.run(
          req.clinicaId,
          p.id,
          p.nombre,
          p.apellido || null,
          p.color || '#1E3A5F',
          Number.isInteger(p.orden) ? p.orden : 0,
          p.descripcionPublica || null,
          p.horarioPublico ? JSON.stringify(p.horarioPublico) : null,
          p.visibleEnWeb === false ? 0 : 1,
          p.activo === false ? 0 : 1
        );
      }
    });
    upsertPodologos(podologos);
  }

  // Pieza 3.3 — Reemplazar citas_podologo si viene en el payload
  if (Array.isArray(citasOcupadasPorPodologo)) {
    const insPodCita = req.db.prepare('INSERT OR IGNORE INTO citas_podologo (clinicaId, fecha, hora, duracion, podologoId) VALUES (?,?,?,?,?)');
    const insertAllPodCitas = req.db.transaction((citas) => {
      req.db.prepare('DELETE FROM citas_podologo WHERE clinicaId = ?').run(req.clinicaId);
      for (const c of citas) {
        if (c.fecha && c.hora && c.podologoId) {
          insPodCita.run(req.clinicaId, c.fecha, c.hora, c.duracion || 30, c.podologoId);
        }
      }
      // Re-bloquear reservas web pendientes CON podologoId (multi-podólogo)
      const pendientesPodologo = req.db.prepare(
        `SELECT fecha, hora, duracion, podologoId FROM reservas WHERE clinicaId = ? AND estado = 'pendiente_pc' AND podologoId IS NOT NULL`
      ).all(req.clinicaId);
      for (const r of pendientesPodologo) {
        if (r.fecha && r.hora) insPodCita.run(req.clinicaId, r.fecha, r.hora, r.duracion || 30, r.podologoId);
      }
    });
    insertAllPodCitas(citasOcupadasPorPodologo);
  }

  res.json({
    ok: true,
    citasSincronizadas: (citasOcupadas || []).length,
    podologosSincronizados: Array.isArray(podologos) ? podologos.length : 0,
    citasPodologoSincronizadas: Array.isArray(citasOcupadasPorPodologo) ? citasOcupadasPorPodologo.length : 0
  });
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

/* ── Pieza 3.3 — Helpers multi-podólogo ───────────────────────── */

/**
 * Lee el horario del podólogo. Si NULL/vacío, fallback al horario global de
 * agenda_config. Devuelve null si el podólogo no existe o no es visible.
 */
function getHorarioPodologo(db, clinicaId, podologoId) {
  const pod = db.prepare(`
    SELECT horarioPublico FROM podologos_publicos
    WHERE clinicaId = ? AND id = ? AND visibleEnWeb = 1 AND activo = 1
  `).get(clinicaId, podologoId);
  if (!pod) return null;
  if (pod.horarioPublico) {
    try { return JSON.parse(pod.horarioPublico); } catch (_) {}
  }
  // Fallback al horario global de la clínica
  const cfgRow = db.prepare('SELECT config FROM agenda_config WHERE clinicaId = ?').get(clinicaId);
  if (!cfgRow) return {};
  try { return JSON.parse(cfgRow.config).horario || {}; } catch (_) { return {}; }
}

/**
 * Devuelve las ocupaciones combinadas de un podólogo en una fecha:
 * - citas_ocupadas[clinicaId, fecha] → bloquean a todos
 * - citas_podologo[clinicaId, podologoId, fecha] → solo a este
 */
function ocupadasPodologo(db, clinicaId, podologoId, fecha) {
  const agregadas = db.prepare(
    'SELECT hora, duracion FROM citas_ocupadas WHERE clinicaId = ? AND fecha = ?'
  ).all(clinicaId, fecha);
  const especificas = db.prepare(
    'SELECT hora, duracion FROM citas_podologo WHERE clinicaId = ? AND podologoId = ? AND fecha = ?'
  ).all(clinicaId, podologoId, fecha);
  return [...agregadas, ...especificas];
}

/**
 * ¿Está el slot (fecha+hora) libre para este podólogo concreto?
 * Considera: bloqueos, horario del podólogo (con fallback global), ocupaciones.
 */
function isSlotLibreParaPodologo(db, clinicaId, podologoId, fecha, hora, duracionSlot) {
  // 1. Día bloqueado (vacaciones, festivos)
  const bloqueada = db.prepare('SELECT 1 FROM bloqueos WHERE clinicaId = ? AND fecha = ?').get(clinicaId, fecha);
  if (bloqueada) return false;

  // 2. Horario del podólogo (con fallback a agenda_config.horario)
  const horario = getHorarioPodologo(db, clinicaId, podologoId);
  if (!horario) return false;

  // 3. Slot dentro del horario del día
  const d = new Date(fecha + 'T12:00:00Z');
  const diaSemana = String(d.getUTCDay());
  const franjas = horario[diaSemana] || [];
  if (!franjas.length) return false;

  const todosSlots = generarSlots(franjas, duracionSlot);
  if (!todosSlots.includes(hora)) return false;

  // 4. No ocupado (citas_ocupadas agregada + citas_podologo de este podólogo)
  const ocupadas = ocupadasPodologo(db, clinicaId, podologoId, fecha);
  const libres = slotLibres([hora], ocupadas, duracionSlot);
  return libres.includes(hora);
}

/* ── Helper: sumar N días hábiles según horario ───────────────── */
/**
 * ¿Solapa una reserva de [hora, hora+duracion) con alguna ocupación?
 *
 * Incidente 08-2026: las comprobaciones de reservar-slot usaban `AND hora = ?`,
 * igualdad exacta. Una cita de 11:45 durante 60 min NO impedía reservar a las
 * 12:00, aunque slotLibres() sí lo tenía en cuenta al pintar la disponibilidad.
 * La última línea de defensa era más débil que la pantalla.
 */
function haySolape(ocupadas, hora, duracionSlot) {
  const ini = timeToMinutes(hora);
  const fin = ini + duracionSlot;
  return (ocupadas || []).some(oc => {
    const oIni = timeToMinutes(oc.hora);
    const oFin = oIni + (oc.duracion || duracionSlot);
    return ini < oFin && fin > oIni;
  });
}

/**
 * Último día que se puede ofertar.
 *
 * Incidente 08-2026 (Bug A): el relay calculaba la ventana en días HÁBILES
 * mientras el PC enviaba la ocupación de `diasMax` días NATURALES. La cola
 * sobrante se ofertaba sin ningún dato de ocupación, y el sync del PC la
 * regeneraba cada 30 minutos. Resultado: dobles citas reales.
 *
 * Ahora:
 *  - Si el PC declara su ventana (`ventana.hasta`), manda ella, acotada a lo
 *    que el relay ofertaría como máximo. Falla en cerrado.
 *  - Si no la declara (versiones ≤3.3.1), se usan días NATURALES, que es lo
 *    que esos PC cubren realmente. Cierra el hueco sin depender del cliente.
 *
 * `sumarDiasHabiles` se conserva: es el techo máximo de oferta.
 */
function ventanaFin(base, diasMax, horario, ventana) {
  const techo = new Date(base);
  techo.setDate(techo.getDate() + diasMax);      // días naturales = lo que envía el PC

  const declarada = ventana && typeof ventana.hasta === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(ventana.hasta)
    ? new Date(ventana.hasta + 'T12:00:00Z') : null;

  if (declarada && !isNaN(declarada) && declarada < techo) return declarada;
  return techo;
}

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
  const fechaFin    = ventanaFin(hoy, diasMax, horario, cfg.ventana);

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

/* ── Pieza 3.3 — Slots libres de un día y un podólogo (público) ── */
router.get('/slots/:clinicaId/:fecha/:podologoId', (req, res) => {
  const { clinicaId, fecha, podologoId } = req.params;

  const clinica = req.db
    .prepare('SELECT id FROM clinicas WHERE id = ? AND activa = 1')
    .get(clinicaId);
  if (!clinica) return res.status(404).json({ ok: false, error: 'Clínica no encontrada' });

  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    return res.status(400).json({ ok: false, error: 'Formato de fecha inválido' });
  }

  const bloqueada = req.db
    .prepare('SELECT 1 FROM bloqueos WHERE clinicaId = ? AND fecha = ?')
    .get(clinicaId, fecha);
  if (bloqueada) return res.json({ ok: true, slots: [], motivo: 'bloqueada' });

  const horario = getHorarioPodologo(req.db, clinicaId, podologoId);
  if (!horario) return res.status(404).json({ ok: false, error: 'Podólogo no encontrado o no visible' });

  const cfgRow = req.db.prepare('SELECT config FROM agenda_config WHERE clinicaId = ?').get(clinicaId);
  const duracionSlot = cfgRow ? (JSON.parse(cfgRow.config).duracionSlot || 30) : 30;

  const d = new Date(fecha + 'T12:00:00Z');
  const diaSemana = String(d.getUTCDay());
  const franjas = horario[diaSemana] || [];

  const todosSlots = generarSlots(franjas, duracionSlot);
  const ocupadas = ocupadasPodologo(req.db, clinicaId, podologoId, fecha);
  const libres = slotLibres(todosSlots, ocupadas, duracionSlot);

  res.json({ ok: true, fecha, slots: libres, duracionSlot });
});

/* ── Pieza 3.3 — Lista pública de podólogos visibles ──────────── */
router.get('/podologos/:clinicaId', (req, res) => {
  try {
    const clinica = req.db
      .prepare('SELECT id FROM clinicas WHERE id = ? AND activa = 1')
      .get(req.params.clinicaId);
    // No 404 si la clínica no existe — devolvemos lista vacía para que la web
    // siga funcionando en modo agregado.
    if (!clinica) return res.json({ ok: true, podologos: [] });

    const podologos = req.db.prepare(`
      SELECT id, nombre, apellido, color, descripcionPublica
      FROM podologos_publicos
      WHERE clinicaId = ? AND visibleEnWeb = 1 AND activo = 1
      ORDER BY orden ASC, nombre ASC
    `).all(req.params.clinicaId);

    res.json({ ok: true, podologos });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ── Pieza 3.3 — Podólogos disponibles en un slot concreto (público) ── */
// Usado cuando paciente eligió "Cualquier disponible" y hace click en hora:
// - 0 disponibles → frontend muestra "ya no disponible"
// - 1 disponible → frontend autoselecciona y avanza
// - 2+ → frontend abre mini-modal de elección
router.get('/podologos-disponibles/:clinicaId/:fecha/:hora', (req, res) => {
  try {
    const { clinicaId, fecha, hora } = req.params;

    const clinica = req.db
      .prepare('SELECT id FROM clinicas WHERE id = ? AND activa = 1')
      .get(clinicaId);
    if (!clinica) return res.json({ ok: true, podologos: [] });

    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
      return res.status(400).json({ ok: false, error: 'Formato de fecha inválido' });
    }
    if (!/^\d{2}:\d{2}$/.test(hora)) {
      return res.status(400).json({ ok: false, error: 'Formato de hora inválido' });
    }

    const cfgRow = req.db.prepare('SELECT config FROM agenda_config WHERE clinicaId = ?').get(clinicaId);
    if (!cfgRow) return res.json({ ok: true, podologos: [] });
    let duracionSlot = 30;
    try { duracionSlot = JSON.parse(cfgRow.config).duracionSlot || 30; } catch (_) {}

    const podologos = req.db.prepare(`
      SELECT id, nombre, apellido, color, descripcionPublica
      FROM podologos_publicos
      WHERE clinicaId = ? AND visibleEnWeb = 1 AND activo = 1
      ORDER BY orden ASC, nombre ASC
    `).all(clinicaId);

    const disponibles = podologos.filter(p =>
      isSlotLibreParaPodologo(req.db, clinicaId, p.id, fecha, hora, duracionSlot)
    );

    res.json({ ok: true, podologos: disponibles });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ── Reservar slot directamente (público, atómico) ────────────── */
router.post('/reservar-slot', (req, res) => {
  const { clinicaId, fecha, hora, nombre, telefono, email, motivo, observaciones, podologoId } = req.body;

  if (!clinicaId || !fecha || !hora || !nombre?.trim() || !telefono?.trim()) {
    return res.status(400).json({ ok: false, error: 'Faltan campos obligatorios' });
  }

  const clinica = req.db
    .prepare('SELECT id FROM clinicas WHERE id = ? AND activa = 1')
    .get(clinicaId);
  if (!clinica) return res.status(400).json({ ok: false, error: 'Clínica no encontrada' });

  // Pieza 3.3 — si viene podologoId, validar que existe + visible + activo
  if (podologoId) {
    const pod = req.db.prepare(`
      SELECT id FROM podologos_publicos
      WHERE clinicaId = ? AND id = ? AND visibleEnWeb = 1 AND activo = 1
    `).get(clinicaId, podologoId);
    if (!pod) return res.status(400).json({ ok: false, error: 'Podólogo no disponible' });
  }

  // Bloqueo atómico: verificar y reservar en una sola transacción
  const { genId } = require('../db');
  const id = 'res_' + genId(10);

  try {
    const resultado = req.db.transaction(() => {
      // Duración del hueco que se pretende reservar — necesaria para comparar
      // solapamientos, así que se calcula ANTES de verificar.
      const cfgRow = req.db.prepare('SELECT config FROM agenda_config WHERE clinicaId = ?').get(clinicaId);
      const duracion = cfgRow ? (JSON.parse(cfgRow.config).duracionSlot || 30) : 30;

      // Verificar slot libre POR SOLAPAMIENTO, no por igualdad de hora.
      //
      // Incidente 08-2026: estas tres consultas usaban `AND hora = ?`, así que
      // una cita de 11:45 durante 60 min no impedía reservar a las 12:00. La
      // disponibilidad que se pinta (slotLibres) sí lo tenía en cuenta, de modo
      // que la última línea de defensa era más débil que la pantalla.
      //
      // - citas_ocupadas → bloquea siempre (slot agregado para todos)
      // - citas_podologo del mismo podologoId → bloquea si reserva específica
      // - reservas 'pendiente_pc' → doble check
      const ocupadasAgregadas = req.db
        .prepare('SELECT hora, duracion FROM citas_ocupadas WHERE clinicaId = ? AND fecha = ?')
        .all(clinicaId, fecha);
      let ocupado = haySolape(ocupadasAgregadas, hora, duracion);

      if (!ocupado && podologoId) {
        const ocupadasPod = req.db
          .prepare('SELECT hora, duracion FROM citas_podologo WHERE clinicaId = ? AND podologoId = ? AND fecha = ?')
          .all(clinicaId, podologoId, fecha);
        ocupado = haySolape(ocupadasPod, hora, duracion);
      }

      if (!ocupado) {
        // Reserva pendiente del mismo podologoId, o agregada (legacy) que bloquea a todos
        const pendientes = req.db
          .prepare(`SELECT hora, duracion FROM reservas
                    WHERE clinicaId = ? AND fecha = ? AND estado = 'pendiente_pc'
                    AND (podologoId IS NULL OR podologoId = ?)`)
          .all(clinicaId, fecha, podologoId || null);
        ocupado = haySolape(pendientes, hora, duracion);
      }
      if (ocupado) return null;

      // Bloquear el slot:
      // - Si podologoId → citas_podologo (otros podólogos siguen libres en ese slot)
      // - Si no → citas_ocupadas (legacy agregada, bloquea para todos)
      if (podologoId) {
        req.db.prepare('INSERT OR IGNORE INTO citas_podologo (clinicaId, fecha, hora, duracion, podologoId) VALUES (?,?,?,?,?)')
          .run(clinicaId, fecha, hora, duracion, podologoId);
      } else {
        req.db.prepare('INSERT OR IGNORE INTO citas_ocupadas (clinicaId, fecha, hora, duracion) VALUES (?,?,?,?)')
          .run(clinicaId, fecha, hora, duracion);
      }

      // Crear la reserva con podologoId (nullable)
      req.db.prepare(`
        INSERT INTO reservas (id, clinicaId, fecha, hora, duracion, nombre, telefono, email, motivo, observaciones, podologoId)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `).run(id, clinicaId, fecha, hora, duracion, nombre.trim(), telefono.trim(),
        email?.trim() || null, motivo || null, observaciones?.trim() || null, podologoId || null);

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
//
// Pieza 3.3 — Si hay podólogos publicados, modo agregado calcula slot libre
// como "al menos 1 podólogo lo tiene libre". Sin podólogos publicados,
// comportamiento legacy (solo citas_ocupadas).
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

  // Pieza 3.3 — cargar podólogos publicados (si los hay, modo agregado considera unión)
  const podologosPub = req.db.prepare(`
    SELECT id, horarioPublico FROM podologos_publicos
    WHERE clinicaId = ? AND visibleEnWeb = 1 AND activo = 1
  `).all(req.params.clinicaId);
  const tienePodologos = podologosPub.length > 0;

  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);

  // Ventana de reserva en días hábiles
  const fechaInicio = diasMin > 0 ? sumarDiasHabiles(hoy, diasMin, horario) : new Date(hoy);
  const fechaFin    = ventanaFin(hoy, diasMax, horario, cfg.ventana);
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
        if (tienePodologos) {
          // Pieza 3.3 — slot libre = al menos 1 podólogo visible lo tiene libre
          slots = todosSlots.map(hora => {
            const libre = podologosPub.some(p =>
              isSlotLibreParaPodologo(req.db, req.params.clinicaId, p.id, fechaStr, hora, duracionSlot)
            );
            return { hora, libre };
          });
        } else {
          // Legacy: solo mira citas_ocupadas
          const ocupadas = req.db
            .prepare('SELECT hora, duracion FROM citas_ocupadas WHERE clinicaId = ? AND fecha = ?')
            .all(req.params.clinicaId, fechaStr);
          const libresArray = slotLibres(todosSlots, ocupadas, duracionSlot);
          const libresSet = new Set(libresArray);
          slots = todosSlots.map(hora => ({ hora, libre: libresSet.has(hora) }));
        }
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

/* ── Pieza 3.3 — Vista semanal por podólogo (público) ─────────── */
// Mismo formato que /api/semana/:clinicaId pero filtrando por podologoId.
router.get('/semana/:clinicaId/:podologoId', (req, res) => {
  const { clinicaId, podologoId } = req.params;

  const clinica = req.db
    .prepare('SELECT id FROM clinicas WHERE id = ? AND activa = 1')
    .get(clinicaId);
  if (!clinica) return res.status(404).json({ ok: false, error: 'Clínica no encontrada' });

  const horario = getHorarioPodologo(req.db, clinicaId, podologoId);
  if (!horario) return res.status(404).json({ ok: false, error: 'Podólogo no encontrado o no visible' });

  const row = req.db
    .prepare('SELECT config FROM agenda_config WHERE clinicaId = ?')
    .get(clinicaId);
  if (!row) return res.json({ ok: true, dias: [], duracionSlot: 30, semanaInicio: null });

  const cfg = JSON.parse(row.config);
  const { duracionSlot = 30, diasMin = 1, diasMax = 14 } = cfg;

  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  const fechaInicio = diasMin > 0 ? sumarDiasHabiles(hoy, diasMin, horario) : new Date(hoy);
  const fechaFin    = ventanaFin(hoy, diasMax, horario, cfg.ventana);
  fechaInicio.setHours(12, 0, 0, 0);
  fechaFin.setHours(12, 0, 0, 0);

  let semanaInicio = new Date(fechaInicio);
  if (req.query.desde && /^\d{4}-\d{2}-\d{2}$/.test(req.query.desde)) {
    semanaInicio = new Date(req.query.desde + 'T12:00:00Z');
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
      .get(clinicaId, fechaStr);

    let slots = [];
    if (franjas.length > 0) {
      const todosSlots = generarSlots(franjas, duracionSlot);
      if (enVentana && !bloqueada) {
        const ocupadas = ocupadasPodologo(req.db, clinicaId, podologoId, fechaStr);
        const libresArray = slotLibres(todosSlots, ocupadas, duracionSlot);
        const libresSet = new Set(libresArray);
        slots = todosSlots.map(hora => ({ hora, libre: libresSet.has(hora) }));
      } else {
        slots = todosSlots.map(hora => ({ hora, libre: false, motivo: bloqueada ? 'bloqueado' : 'fuera_ventana' }));
      }
    }

    dias.push({
      fecha: fechaStr, nombre: NOMBRES[d.getDay()],
      dia: d.getDate(), mes: d.getMonth() + 1, diaSemana,
      trabajado: franjas.length > 0, enVentana, bloqueada, slots
    });
  }

  res.json({
    ok: true, dias, duracionSlot,
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

// Helpers expuestos para scripts/test_agenda_solapes.js
module.exports.__test__ = {
  haySolape, ventanaFin, sumarDiasHabiles, slotLibres, generarSlots, timeToMinutes,
};
