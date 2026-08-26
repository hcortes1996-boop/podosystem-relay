#!/usr/bin/env node
'use strict';
/**
 * Test end-to-end de /api/reservar-slot — incidente de dobles citas 08-2026.
 *
 * Levanta el relay contra una BD temporal, siembra una clínica con una cita de
 * 11:45 durante 60 min, e intenta reservar las 12:00 por HTTP real.
 *
 * Reproduce el caso de Pablo Corral vs INES VIDAN del 04-08-2026. Con el código
 * anterior (`AND hora = ?`) la reserva se aceptaba: no había ninguna fila con
 * hora='12:00'.
 *
 * Uso:  node scripts/test_reservar_slot_e2e.js
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

const TMP = path.join(os.tmpdir(), `relay_e2e_${process.pid}.db`);
const PORT = 3097;
process.env.DB_PATH = TMP;
process.env.PORT = String(PORT);

let pasados = 0, fallados = 0;
const ok = (cond, nombre, extra) => {
  if (cond) { pasados++; console.log('  ✅ ' + nombre); }
  else { fallados++; console.log('  ❌ ' + nombre + (extra ? '\n       ' + extra : '')); }
};

require('../src/index.js');

const CLINICA = 'testE2E01';
const HORARIO = {
  '0': [], '6': [],
  '1': [{ inicio: '09:30', fin: '13:00' }], '2': [{ inicio: '09:30', fin: '13:00' }],
  '3': [{ inicio: '09:30', fin: '13:00' }], '4': [{ inicio: '09:30', fin: '13:00' }],
  '5': [{ inicio: '09:30', fin: '13:00' }],
};

// Una fecha futura que caiga en día laborable
const f = new Date(); f.setDate(f.getDate() + 3);
while (f.getDay() === 0 || f.getDay() === 6) f.setDate(f.getDate() + 1);
const FECHA = f.toISOString().slice(0, 10);

const reservar = async (hora) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/reservar-slot`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clinicaId: CLINICA, fecha: FECHA, hora,
      nombre: 'Paciente Test', telefono: '600000000',
    }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

const reservar_ = async (fechaX, hora) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/reservar-slot`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clinicaId: CLINICA, fecha: fechaX, hora,
                           nombre: 'Paciente Test', telefono: '600000001' }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

setTimeout(async () => {
  const db = require('../src/db').getDb ? require('../src/db').getDb() : require('better-sqlite3')(TMP);

  db.prepare('INSERT OR REPLACE INTO clinicas (id, nombre, apiKey, activa) VALUES (?,?,?,1)')
    .run(CLINICA, 'Clinica E2E', 'k_test');
  db.prepare('INSERT OR REPLACE INTO agenda_config (clinicaId, config, updatedAt) VALUES (?,?,?)')
    .run(CLINICA, JSON.stringify({ duracionSlot: 30, diasMin: 1, diasMax: 14, horario: HORARIO }),
         new Date().toISOString());
  // La cita real: 11:45 durante 60 min → ocupa hasta las 12:45
  db.prepare('INSERT INTO citas_ocupadas (clinicaId, fecha, hora, duracion) VALUES (?,?,?,?)')
    .run(CLINICA, FECHA, '11:45', 60);

  console.log(`\nfecha de prueba: ${FECHA}  |  cita sembrada: 11:45 (60 min)\n`);

  const r1200 = await reservar('12:00');
  ok(r1200.status === 409, 'reservar 12:00 se RECHAZA (solapa con 11:45+60min)',
     `obtenido HTTP ${r1200.status} ${JSON.stringify(r1200.body).slice(0, 120)}`);

  const r1230 = await reservar('12:30');
  ok(r1230.status === 409, 'reservar 12:30 se RECHAZA (sigue dentro de la cita)',
     `obtenido HTTP ${r1230.status}`);

  const r1000 = await reservar('10:00');
  ok(r1000.status === 200 || r1000.body.ok, 'reservar 10:00 se ACEPTA (hueco libre real)',
     `obtenido HTTP ${r1000.status} ${JSON.stringify(r1000.body).slice(0, 120)}`);

  // Tras aceptar 10:00 queda pendiente_pc → 10:00 debe bloquearse por la 3ª consulta
  const r1000bis = await reservar('10:00');
  ok(r1000bis.status === 409, 'reservar 10:00 otra vez se RECHAZA (reserva pendiente_pc)',
     `obtenido HTTP ${r1000bis.status}`);

  // Y 10:15 no existe como slot, pero 10:30 sí y no debe estar bloqueado
  const r1030 = await reservar('10:30');
  ok(r1030.status === 200 || r1030.body.ok, 'reservar 10:30 se ACEPTA (no solapa con la de 10:00)',
     `obtenido HTTP ${r1030.status}`);

  // Fuera de la ventana publicada: diasMax=14 días naturales, así que un día a
  // 60 días debe rechazarse aunque el hueco esté libre. Última línea de defensa
  // contra una petición directa que no pase por la web.
  const lejos = new Date(); lejos.setDate(lejos.getDate() + 60);
  while (lejos.getDay() === 0 || lejos.getDay() === 6) lejos.setDate(lejos.getDate() + 1);
  const rLejos = await reservar_(lejos.toISOString().slice(0, 10), '10:00');
  ok(rLejos.status === 409, 'reservar a 60 días se RECHAZA (fuera de la ventana publicada)',
     `obtenido HTTP ${rLejos.status} ${JSON.stringify(rLejos.body).slice(0, 120)}`);

  console.log(`\n${pasados} pasados, ${fallados} fallados`);
  try { fs.unlinkSync(TMP); } catch {}
  // Respiro antes de salir: sin el, process.exit() pillaba a las conexiones de fetch a
  // medio cerrar y libuv abortaba en Windows con
  //   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c
  // El proceso salia con 127 DESPUES de pasar las 6 comprobaciones: un test en verde que
  // quien lo lanza ve en rojo. (Detectado el 27-08-2026.)
  setTimeout(() => process.exit(fallados ? 1 : 0), 300);
}, 2500);
