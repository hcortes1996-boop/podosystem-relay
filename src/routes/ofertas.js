/**
 * ofertas.js — El enlace «La quiero» de la lista de espera (Fase 2, 25-10-2026)
 *
 *   POST /api/ofertas-hueco                           (X-Api-Key) — el PC ofrece un hueco a un paciente
 *   PUT  /api/ofertas-hueco/hueco/:huecoCitaId/retirar (X-Api-Key) — el PC va a hacer otra cosa con el hueco
 *   GET  /api/ofertas-hueco/respondidas?desde=        (X-Api-Key) — lo que han contestado los pacientes
 *   PUT  /api/ofertas-hueco/:id/aplicada              (X-Api-Key) — el PC ya movió la cita
 *   GET  /api/oferta/:token                           (público)   — la página pide los datos. NO acepta
 *   POST /api/oferta/:token/aceptar                   (público)   — el paciente se queda el hueco
 *   POST /api/oferta/:token/rechazar                  (público)   — el paciente no lo quiere
 *
 * La regla que lo sostiene todo: **cualquier cosa que el PC quiera hacer con un hueco ofrecido
 * pasa antes por aquí**. Si el paciente ya lo aceptó, el PC recibe un 409 con quién fue y aplica
 * la aceptación en vez de dárselo a otro. Así no importa si el PC tardó en enterarse.
 *
 * Y la de las dobles citas de agosto: aquí NUNCA se borra ocupación. Aceptar AÑADE el bloqueo
 * del hueco; quitarlo es cosa del PC, que es el único que sabe lo que hay en la agenda.
 *
 * Lógica pura y pruebas: src/lib/oferta_hueco.js, scripts/test_oferta_hueco*.js.
 */
'use strict';

const router = require('express').Router();
const auth   = require('../middleware/auth');
const { genId } = require('../db');
const { generarToken, hashToken } = require('../lib/anulacion');
const { validarNuevaOferta, puedeResponder, vistaPublica, estadoEfectivo } = require('../lib/oferta_hueco');
const { avisarSinEsperar } = require('../lib/aviso-anulacion');

const limitePublico = process.env.NODE_ENV === 'test'
  ? (_req, _res, next) => next()
  : require('express-rate-limit')({
      windowMs: 60 * 60 * 1000,
      max: 60,
      standardHeaders: true,
      legacyHeaders: false,
      message: { ok: false, error: 'Demasiadas peticiones. Inténtelo más tarde o llame a la clínica.' },
    });

const ahoraISO = () => new Date().toISOString();

/** Lo que el PC necesita saber de una oferta aceptada para mover la cita. */
function paraElPC(o) {
  return {
    id: o.id, estado: o.estado, huecoCitaId: o.huecoCitaId, candidatoCitaId: o.candidatoCitaId,
    fecha: o.fecha, hora: o.hora, duracion: o.duracion, podologoId: o.podologoId,
    nombrePila: o.nombrePila, citaActualFecha: o.citaActualFecha, citaActualHora: o.citaActualHora,
    respondidaEn: o.respondidaEn, aplicadaEn: o.aplicadaEn,
  };
}

/** Las ofertas abiertas cuyo plazo ya pasó se escriben como caducadas. Así los índices quedan limpios. */
function cerrarCaducadas(db, clinicaId) {
  db.prepare(`UPDATE ofertas_hueco SET estado = 'caducada'
               WHERE clinicaId = ? AND estado = 'abierta' AND venceEn <= ?`).run(clinicaId, ahoraISO());
}

/* ── El PC ofrece el hueco ──────────────────────────────────────── */
router.post('/ofertas-hueco', auth, (req, res) => {
  const v = validarNuevaOferta(req.body);
  if (!v.ok) return res.status(400).json({ ok: false, error: v.error });
  const d = v.datos;
  const token = generarToken();
  const id = 'of_' + genId(12);

  const r = req.db.transaction(() => {
    cerrarCaducadas(req.db, req.clinicaId);
    const aceptada = req.db.prepare(`SELECT * FROM ofertas_hueco
        WHERE clinicaId = ? AND huecoCitaId = ? AND estado = 'aceptada'`).get(req.clinicaId, d.huecoCitaId);
    if (aceptada) return { aceptada };
    // De uno en uno (decisión de Francisco, 25-10-2026): ofrecérselo a otro retira la anterior.
    req.db.prepare(`UPDATE ofertas_hueco SET estado = 'retirada'
                     WHERE clinicaId = ? AND huecoCitaId = ? AND estado = 'abierta'`).run(req.clinicaId, d.huecoCitaId);
    req.db.prepare(`INSERT INTO ofertas_hueco
        (id, clinicaId, huecoCitaId, fecha, hora, duracion, podologoId, candidatoCitaId, nombrePila,
         citaActualFecha, citaActualHora, tokenHash, venceEn, estado)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'abierta')`)
      .run(id, req.clinicaId, d.huecoCitaId, d.fecha, d.hora, d.duracion, d.podologoId, d.candidatoCitaId,
           d.nombrePila, d.citaActualFecha, d.citaActualHora, hashToken(token), d.venceEn);
    return { creada: true };
  })();

  if (r.aceptada) {
    return res.status(409).json({ ok: false, yaAceptada: true, oferta: paraElPC(r.aceptada),
      error: `${r.aceptada.nombrePila} ya aceptó este hueco por el enlace.` });
  }
  res.status(201).json({ ok: true, ofertaId: id, token, venceEn: d.venceEn });
});

/* ── El PC va a hacer otra cosa con el hueco (otro candidato, liberar, «se la queda» a mano) ── */
router.put('/ofertas-hueco/hueco/:huecoCitaId/retirar', auth, (req, res) => {
  const hueco = String(req.params.huecoCitaId);
  const r = req.db.transaction(() => {
    const aceptada = req.db.prepare(`SELECT * FROM ofertas_hueco
        WHERE clinicaId = ? AND huecoCitaId = ? AND estado = 'aceptada'`).get(req.clinicaId, hueco);
    if (aceptada) return { aceptada };
    const n = req.db.prepare(`UPDATE ofertas_hueco SET estado = 'retirada'
                               WHERE clinicaId = ? AND huecoCitaId = ? AND estado = 'abierta'`).run(req.clinicaId, hueco).changes;
    return { retiradas: n };
  })();
  if (r.aceptada) {
    return res.status(409).json({ ok: false, yaAceptada: true, oferta: paraElPC(r.aceptada),
      error: `${r.aceptada.nombrePila} ya aceptó este hueco por el enlace.` });
  }
  res.json({ ok: true, retiradas: r.retiradas });
});

/* ── Lo que han contestado ───────────────────────────────────────
   · `aceptadas`: TODAS las que el PC aún no ha aplicado, sin mirar `desde`. Una aceptación no
     se puede perder porque el PC estuviera apagado o se le estropeara la marca de agua.
   · `rechazadas`: solo las nuevas desde `desde` — sirven para pasar antes al siguiente. */
router.get('/ofertas-hueco/respondidas', auth, (req, res) => {
  const desde = req.query.desde || new Date(Date.now() - 7 * 86400000).toISOString();
  const hasta = ahoraISO();
  const aceptadas = req.db.prepare(`SELECT * FROM ofertas_hueco
      WHERE clinicaId = ? AND estado = 'aceptada' AND aplicadaEn IS NULL ORDER BY respondidaEn ASC`)
    .all(req.clinicaId).map(paraElPC);
  const rechazadas = req.db.prepare(`SELECT * FROM ofertas_hueco
      WHERE clinicaId = ? AND estado = 'rechazada' AND respondidaEn > ? ORDER BY respondidaEn ASC`)
    .all(req.clinicaId, desde).map(paraElPC);
  res.json({ ok: true, aceptadas, rechazadas, hasta });
});

/* ── El PC ya movió la cita ─────────────────────────────────────── */
router.put('/ofertas-hueco/:id/aplicada', auth, (req, res) => {
  const n = req.db.prepare(`UPDATE ofertas_hueco SET aplicadaEn = COALESCE(aplicadaEn, ?)
                             WHERE id = ? AND clinicaId = ? AND estado = 'aceptada'`)
    .run(ahoraISO(), req.params.id, req.clinicaId).changes;
  if (!n) return res.status(404).json({ ok: false, error: 'Oferta aceptada no encontrada' });
  res.json({ ok: true });
});

/* ══ Lo que abre el paciente ═════════════════════════════════════ */

function buscarPorToken(db, token) {
  if (!token || String(token).length < 16) return null;
  const oferta = db.prepare('SELECT * FROM ofertas_hueco WHERE tokenHash = ?').get(hashToken(token));
  if (!oferta) return null;
  const clinica = db.prepare('SELECT id, nombre, telefono FROM clinicas WHERE id = ? AND activa = 1').get(oferta.clinicaId);
  if (!clinica) return null;
  let zonaHoraria = 'Europe/Madrid';
  try {
    const cfg = db.prepare('SELECT zonaHoraria FROM recordatorios_config WHERE clinicaId = ?').get(oferta.clinicaId);
    if (cfg?.zonaHoraria) zonaHoraria = cfg.zonaHoraria;
  } catch (_) {}
  return { oferta, clinica, zonaHoraria };
}

const NO_ENCONTRADA = { ok: false, error: 'Este enlace no es válido o ya no está disponible.' };

/* Abrir el enlace NO acepta nada: la vista previa de WhatsApp también hace GET. */
router.get('/oferta/:token', limitePublico, (req, res) => {
  const e = buscarPorToken(req.db, req.params.token);
  if (!e) return res.status(404).json(NO_ENCONTRADA);
  res.json({ ok: true, oferta: vistaPublica(e.oferta, e.clinica, puedeResponder(e.oferta, e.zonaHoraria)) });
});

router.post('/oferta/:token/aceptar', limitePublico, (req, res) => {
  const e = buscarPorToken(req.db, req.params.token);
  if (!e) return res.status(404).json(NO_ENCONTRADA);

  let r;
  try {
    r = req.db.transaction(() => {
      // Se vuelve a leer DENTRO de la transacción: lo leído fuera puede haber cambiado.
      const o = req.db.prepare('SELECT * FROM ofertas_hueco WHERE id = ?').get(e.oferta.id);
      if (o.estado === 'aceptada') return { o, yaEstaba: true };
      const p = puedeResponder(o, e.zonaHoraria);
      if (!p.permitido) return { o, motivo: p.motivo };
      const n = req.db.prepare(`UPDATE ofertas_hueco SET estado = 'aceptada', respondidaEn = ?
                                 WHERE id = ? AND estado = 'abierta'`).run(ahoraISO(), o.id).changes;
      if (n !== 1) return { o, motivo: 'retirada' };
      // El hueco queda ocupado en la web desde YA, aunque el PC esté apagado. Solo se AÑADE
      // ocupación. En la agregada siempre (bloquea a todos en esa franja: ofertar de menos
      // hasta que el PC aplique es el lado seguro) y, si tiene podólogo, también en la suya.
      req.db.prepare('INSERT OR IGNORE INTO citas_ocupadas (clinicaId, fecha, hora, duracion) VALUES (?,?,?,?)')
        .run(o.clinicaId, o.fecha, o.hora, o.duracion);
      if (o.podologoId) {
        req.db.prepare('INSERT OR IGNORE INTO citas_podologo (clinicaId, fecha, hora, duracion, podologoId) VALUES (?,?,?,?,?)')
          .run(o.clinicaId, o.fecha, o.hora, o.duracion, o.podologoId);
      }
      return { o: req.db.prepare('SELECT * FROM ofertas_hueco WHERE id = ?').get(o.id), aceptada: true };
    })();
  } catch (err) {
    // El índice único de «aceptada» saltó: otra oferta del mismo hueco ganó a la vez.
    if (/UNIQUE/i.test(err.message)) r = { o: e.oferta, motivo: 'retirada' };
    else { console.error('[oferta:aceptar]', err.message); return res.status(500).json({ ok: false, error: 'No se pudo completar. Llame a la clínica.' }); }
  }

  const vista = vistaPublica(r.o, e.clinica, { permitido: false, motivo: r.aceptada || r.yaEstaba ? 'aceptada' : r.motivo });
  if (r.aceptada) {
    console.log(`✅ [oferta] aceptada — ${r.o.clinicaId} ${r.o.fecha} ${r.o.hora}`);
    avisarSinEsperar(req.db, { reserva: { clinicaId: r.o.clinicaId, nombre: r.o.nombrePila, fecha: r.o.fecha, hora: r.o.hora }, tipo: 'oferta_aceptada' });
  }
  if (r.aceptada || r.yaEstaba) return res.json({ ok: true, yaEstaba: !!r.yaEstaba, oferta: vista });
  return res.status(409).json({ ok: false, motivo: r.motivo, oferta: vista,
    error: 'Lo sentimos, esta hora ya no está disponible. Su cita sigue igual.' });
});

router.post('/oferta/:token/rechazar', limitePublico, (req, res) => {
  const e = buscarPorToken(req.db, req.params.token);
  if (!e) return res.status(404).json(NO_ENCONTRADA);
  const n = req.db.prepare(`UPDATE ofertas_hueco SET estado = 'rechazada', respondidaEn = ?
                             WHERE id = ? AND estado = 'abierta' AND venceEn > ?`)
    .run(ahoraISO(), e.oferta.id, ahoraISO()).changes;
  const o = req.db.prepare('SELECT * FROM ofertas_hueco WHERE id = ?').get(e.oferta.id);
  if (n === 1) avisarSinEsperar(req.db, { reserva: { clinicaId: o.clinicaId, nombre: o.nombrePila, fecha: o.fecha, hora: o.hora }, tipo: 'oferta_rechazada' });
  res.json({ ok: true, oferta: vistaPublica(o, e.clinica, { permitido: false, motivo: estadoEfectivo(o) }) });
});

module.exports = router;
