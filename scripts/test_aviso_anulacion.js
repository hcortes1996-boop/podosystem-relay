#!/usr/bin/env node
'use strict';
/**
 * Tests del aviso al podólogo (sub-pieza 8.20, paso 10).
 *
 * Lo que hay que defender aquí, por orden de gravedad:
 *   1. Que el aviso NUNCA rompa la anulación. El paciente ya ha hecho su parte; si
 *      Expo está caído, o no hay móviles, o la tabla no existe, su cita tiene que
 *      quedar anulada igual y la respuesta ser un 200 limpio.
 *   2. Que el intento fuera de plazo y la anulación en plazo NO se confundan. Son
 *      dos avisos con urgencias distintas: uno dice «ya está resuelto» y el otro
 *      «la cita sigue en pie, llama». Si se mezclan se pierde lo que más valía.
 *   3. Que no se avise dos veces por lo mismo — reabrir un enlace ya usado no puede
 *      volver a sonar en el móvil de la clínica.
 *   4. Que el aviso no lleve teléfono ni email. Se lee en una pantalla bloqueada.
 *
 * Uso:  node scripts/test_aviso_anulacion.js
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

const TMP = path.join(os.tmpdir(), `relay_aviso_${process.pid}.db`);
const PORT = 3097;
process.env.DB_PATH = TMP;
process.env.PORT = String(PORT);
process.env.NODE_ENV = 'test';   // no sale a la red: apunta lo que habría enviado

let pasados = 0, fallados = 0;
const ok = (cond, nombre, extra) => {
  if (cond) { pasados++; console.log('  ✅ ' + nombre); }
  else { fallados++; console.log('  ❌ ' + nombre + (extra ? '\n       ' + extra : '')); }
};

require('../src/index.js');
const { avisarClinica, __test__ } = require('../src/lib/aviso-anulacion');
const { enviados, construirPayload, cuando } = __test__;

const CLINICA = 'testAviso1';
const KEY = 'k_aviso';
const HORARIO = { '0': [], '6': [],
  '1': [{ inicio: '09:00', fin: '14:00' }], '2': [{ inicio: '09:00', fin: '14:00' }],
  '3': [{ inicio: '09:00', fin: '14:00' }], '4': [{ inicio: '09:00', fin: '14:00' }],
  '5': [{ inicio: '09:00', fin: '14:00' }] };
const CONFIG = { duracionSlot: 30, diasMin: 1, diasMax: 20, horario: HORARIO };

const diaHabil = (desdeDias) => {
  const d = new Date(); d.setDate(d.getDate() + desdeDias);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
};
const LEJOS = diaHabil(10);

const api = (ruta, opts = {}) => fetch(`http://127.0.0.1:${PORT}/api${ruta}`, {
  ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
});
const conKey = (ruta, opts = {}) => api(ruta, { ...opts, headers: { 'X-Api-Key': KEY, ...(opts.headers || {}) } });

const esperar = (ms) => new Promise(r => setTimeout(r, ms));

setTimeout(async () => {
  const db = require('better-sqlite3')(TMP);
  db.prepare('INSERT OR REPLACE INTO clinicas (id, nombre, apiKey, activa, telefono) VALUES (?,?,?,1,?)')
    .run(CLINICA, 'Clinica Aviso', KEY, '954000222');

  await conKey('/sync-agenda', { method: 'PUT', body: JSON.stringify({
    config: CONFIG, citasOcupadas: [], permitirVacio: true,
  }) });

  /** Reserva nueva y su token en claro (el PC lo recibe por /reservas-nuevas). */
  const reservar = async (fecha, hora, nombre) => {
    const r = await api('/reservar-slot', { method: 'POST', body: JSON.stringify({
      clinicaId: CLINICA, fecha, hora, duracion: 30,
      nombre, telefono: '600111222', email: 'x@y.es', motivo: 'revision',
    }) });
    const j = await r.json();
    if (!j.reservaId) throw new Error(`no se pudo reservar ${fecha} ${hora}: ${JSON.stringify(j)}`);
    const fila = db.prepare('SELECT * FROM reservas WHERE id = ?').get(j.reservaId);
    return { reserva: fila, token: fila?.tokenPlano };
  };

  const registrarMovil = (tok) => db.prepare(
    'INSERT OR IGNORE INTO expo_push_tokens (id, clinicaId, expoPushToken, platform) VALUES (?,?,?,?)'
  ).run('pt_' + tok, CLINICA, tok, 'android');

  // ─────────────────────────────────────────────────────────────
  console.log('\n── Sin móviles registrados la anulación funciona igual ──');
  {
    enviados.length = 0;
    const { reserva, token } = await reservar(LEJOS, '09:00', 'Ana Sin Movil');
    const res = await api(`/cita/${token}/anular`, { method: 'POST', body: JSON.stringify({ motivo: 'imprevisto' }) });
    const j = await res.json();
    await esperar(60);
    ok(res.status === 200 && j.ok === true, 'la anulación devuelve 200 aunque no haya a quién avisar');
    const fila = db.prepare('SELECT estado, canceladaPor FROM reservas WHERE id = ?').get(reserva.id);
    ok(fila.estado === 'cancelada' && fila.canceladaPor === 'paciente', 'la cita queda anulada de verdad');
    ok(enviados.length === 0, 'no se intenta enviar nada si no hay móviles');
  }

  // ─────────────────────────────────────────────────────────────
  console.log('\n── Anulación en plazo: aviso informativo ──');
  registrarMovil('ExponentPushToken[aviso-uno]');
  {
    enviados.length = 0;
    const { reserva, token } = await reservar(LEJOS, '09:30', 'Rafael Segovia Ferrera');
    const res = await api(`/cita/${token}/anular`, { method: 'POST', body: JSON.stringify({ motivo: 'me sale trabajo' }) });
    await esperar(60);
    ok(res.status === 200, 'anular en plazo sigue devolviendo 200');
    ok(enviados.length === 1, 'se envía exactamente un aviso', `enviados=${enviados.length}`);

    const p = enviados[0]?.payload || {};
    ok(p.data?.type === 'anulacion_web', 'el tipo es anulacion_web');
    ok(p.data?.urgente === false, 'NO va marcado urgente — el hueco ya está libre');
    ok(/anulad/i.test(p.title), 'el título dice que ha sido anulada', p.title);
    ok(p.body.includes('Rafael Segovia Ferrera'), 'el aviso dice de quién es la cita');
    ok(p.body.includes('me sale trabajo'), 'el motivo que escribió el paciente llega a la clínica');
    ok(p.data?.reservaId === reserva.id, 'lleva el reservaId para que la APK abra la cita');
    ok(enviados[0].tokens.length === 1, 'va al móvil registrado de la clínica');

    // La regla de privacidad: esto se lee en una pantalla bloqueada.
    const texto = `${p.title} ${p.body}`;
    ok(!texto.includes('600111222'), 'el aviso NO lleva el teléfono del paciente');
    ok(!texto.includes('x@y.es'), 'el aviso NO lleva el email del paciente');
  }

  // ─────────────────────────────────────────────────────────────
  console.log('\n── Reabrir un enlace ya usado no vuelve a sonar ──');
  {
    const { token } = await reservar(LEJOS, '10:00', 'Dos Veces');
    await api(`/cita/${token}/anular`, { method: 'POST', body: JSON.stringify({ motivo: 'a' }) });
    await esperar(60);
    enviados.length = 0;
    const res = await api(`/cita/${token}/anular`, { method: 'POST', body: JSON.stringify({ motivo: 'a' }) });
    const j = await res.json();
    await esperar(60);
    ok(res.status === 200 && j.yaEstaba === true, 'la segunda vez responde que ya estaba anulada');
    ok(enviados.length === 0, 'y NO se avisa otra vez a la clínica');
  }

  // ─────────────────────────────────────────────────────────────
  console.log('\n── Intento fuera de plazo: aviso urgente y distinto ──');
  {
    enviados.length = 0;
    const { reserva, token } = await reservar(LEJOS, '10:30', 'Macarena Civera Romero');
    // Se le acerca la fecha a mano para caer dentro de las 24 h sin esperar.
    const enUnaHora = new Date(Date.now() + 60 * 60 * 1000);
    db.prepare('UPDATE reservas SET fecha = ?, hora = ? WHERE id = ?')
      .run(enUnaHora.toISOString().slice(0, 10),
           enUnaHora.toTimeString().slice(0, 5), reserva.id);

    const res = await api(`/cita/${token}/anular`, { method: 'POST', body: JSON.stringify({ motivo: 'estoy malo' }) });
    const j = await res.json();
    await esperar(60);

    ok(res.status === 409, 'fuera de plazo NO se anula (409)');
    ok(j.avisoRegistrado === true, 'y se le dice al paciente que la clínica queda avisada');
    const fila = db.prepare('SELECT estado, intentoAnularEn, intentoAnularNota FROM reservas WHERE id = ?').get(reserva.id);
    ok(fila.estado !== 'cancelada', 'la cita SIGUE en pie');
    ok(!!fila.intentoAnularEn, 'el intento queda registrado');

    ok(enviados.length === 1, 'se envía un aviso del intento', `enviados=${enviados.length}`);
    const p = enviados[0]?.payload || {};
    ok(p.data?.type === 'intento_anulacion', 'el tipo es intento_anulacion, no anulacion_web');
    ok(p.data?.urgente === true, 'va marcado URGENTE — requiere una llamada');
    ok(/SIGUE/i.test(p.body), 'el cuerpo avisa de que la cita sigue en la agenda', p.body);
    ok(p.body.includes('Macarena Civera Romero'), 'dice a quién hay que llamar');
    ok(p.title !== construirPayload({ reserva: fila, tipo: 'anulada' }).title,
       'el título NO es el mismo que el de una anulación normal');
  }

  // ─────────────────────────────────────────────────────────────
  console.log('\n── El aviso no puede tumbar nada, pase lo que pase ──');
  {
    const fake = { clinicaId: CLINICA, id: 'res_x', fecha: '2026-09-01', hora: '11:00', nombre: 'X' };

    const sinDb = await avisarClinica(null, { reserva: fake, tipo: 'anulada' });
    ok(sinDb.ok === false && sinDb.motivo === 'sin-reserva', 'sin base de datos devuelve, no lanza');

    const sinReserva = await avisarClinica(db, { tipo: 'anulada' });
    ok(sinReserva.ok === false, 'sin reserva devuelve, no lanza');

    // Una base sin la tabla de tokens — el caso de una clínica antigua.
    const OTRA = path.join(os.tmpdir(), `relay_aviso_vacia_${process.pid}.db`);
    const vacia = require('better-sqlite3')(OTRA);
    const sinTabla = await avisarClinica(vacia, { reserva: fake, tipo: 'anulada' });
    ok(sinTabla.ok === false && sinTabla.motivo === 'sin-tabla',
       'una base sin expo_push_tokens devuelve «sin-tabla», no revienta');
    vacia.close();
    try { fs.unlinkSync(OTRA); } catch (_) {}

    // Un db que explota al consultar: lo peor que puede pasar.
    const roto = { prepare() { throw new Error('base bloqueada'); } };
    const conRoto = await avisarClinica(roto, { reserva: fake, tipo: 'anulada' });
    ok(conRoto.ok === false, 'una base que lanza al consultar se traga el error');
  }

  // ─────────────────────────────────────────────────────────────
  console.log('\n── Formato de la fecha ──');
  {
    ok(cuando('2026-08-20', '17:30') === '20/08 a las 17:30', 'la fecha se lee como la diría una persona');
    ok(cuando('2026-08-20', '') === '20/08', 'sin hora no deja un «a las» colgando');
    ok(cuando('', '') === '', 'sin fecha no inventa nada');
    const p = construirPayload({ reserva: { nombre: '   ' }, tipo: 'anulada' });
    ok(p.body.startsWith('Un paciente'), 'una reserva sin nombre no deja el aviso empezando en blanco');
  }

  console.log(`\n${pasados} pasados, ${fallados} fallados`);
  try { fs.unlinkSync(TMP); } catch (_) {}
  process.exit(fallados ? 1 : 0);
}, 900);
