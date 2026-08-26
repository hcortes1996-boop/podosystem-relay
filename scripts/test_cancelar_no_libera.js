#!/usr/bin/env node
'use strict';
/**
 * Test — cancelar una reserva NO debe liberar el hueco por su cuenta.
 *
 * `PUT /reservas/:id/cancelar` hacía un DELETE en citas_ocupadas por
 * (clinicaId, fecha, hora). El comentario decía «si solo lo bloqueaba esta
 * reserva», pero el SQL no llevaba esa condición — y la tabla no tiene columna
 * de procedencia, así que es IMPOSIBLE saber si ese hueco lo ocupaba la reserva
 * web o una cita que el PC metió a mano.
 *
 * Hoy apenas se llama (solo cuando la clínica cancela desde el panel). Con el
 * autoservicio de anulación se llamaría a diario, y cada llamada podía liberar
 * una hora ocupada durante hasta 30 minutos —lo que tarda el siguiente
 * sync-agenda—. Es el mecanismo de las dobles citas de agosto de 2026 con un
 * disparador nuevo y mucho más frecuente.
 *
 * La ocupación la reconstruye siempre el PC. El relay solo marca la reserva.
 *
 * Uso:  node scripts/test_cancelar_no_libera.js
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

const TMP = path.join(os.tmpdir(), `relay_canc_${process.pid}.db`);
const PORT = 3097;
process.env.DB_PATH = TMP;
process.env.PORT = String(PORT);

let pasados = 0, fallados = 0;
const ok = (cond, nombre, extra) => {
  if (cond) { pasados++; console.log('  ✅ ' + nombre); }
  else { fallados++; console.log('  ❌ ' + nombre + (extra ? '\n       ' + extra : '')); }
};

require('../src/index.js');

const CLINICA = 'testCanc01';
const KEY = 'k_canc';
const HORARIO = { '0': [], '6': [],
  '1': [{ inicio: '09:30', fin: '13:00' }], '2': [{ inicio: '09:30', fin: '13:00' }],
  '3': [{ inicio: '09:30', fin: '13:00' }], '4': [{ inicio: '09:30', fin: '13:00' }],
  '5': [{ inicio: '09:30', fin: '13:00' }] };
const CONFIG = { duracionSlot: 30, diasMin: 1, diasMax: 14, horario: HORARIO };

const f = new Date(); f.setDate(f.getDate() + 3);
while (f.getDay() === 0 || f.getDay() === 6) f.setDate(f.getDate() + 1);
const FECHA = f.toISOString().slice(0, 10);

const api = (ruta, opts = {}) => fetch(`http://127.0.0.1:${PORT}/api${ruta}`, {
  ...opts,
  headers: { 'Content-Type': 'application/json', 'X-Api-Key': KEY, ...(opts.headers || {}) },
});

setTimeout(async () => {
  const db = require('better-sqlite3')(TMP);
  db.prepare('INSERT OR REPLACE INTO clinicas (id, nombre, apiKey, activa) VALUES (?,?,?,1)')
    .run(CLINICA, 'Clinica Cancelar', KEY);

  const ocupadas = () => db.prepare('SELECT fecha, hora FROM citas_ocupadas WHERE clinicaId = ?')
    .all(CLINICA).map(r => `${r.fecha} ${r.hora}`);
  const estado = id => db.prepare('SELECT estado FROM reservas WHERE id = ?').get(id)?.estado;

  console.log(`\nfecha de prueba: ${FECHA}\n`);

  // El PC declara su ocupación: dos horas ocupadas por citas suyas de consulta.
  await api('/sync-agenda', { method: 'PUT', body: JSON.stringify({
    config: CONFIG,
    citasOcupadas: [
      { fecha: FECHA, hora: '09:30', duracion: 30 },
      { fecha: FECHA, hora: '10:00', duracion: 30 },
    ],
    ventana: { desde: new Date().toISOString().slice(0, 10), hasta: FECHA },
  }) });
  ok(ocupadas().length === 2, 'el PC declara 2 horas ocupadas', ocupadas().join(', '));

  // Un paciente reserva un hueco libre.
  const rRes = await api('/reservar-slot', { method: 'POST', body: JSON.stringify({
    clinicaId: CLINICA, fecha: FECHA, hora: '11:00', duracion: 30,
    nombre: 'Paciente Prueba', telefono: '600000001',
  }) });
  const bodyRes = await rRes.json().catch(() => ({}));
  const reservaId = bodyRes.reservaId;
  ok(!!reservaId, 'la reserva se crea', JSON.stringify(bodyRes).slice(0, 160));
  ok(ocupadas().includes(`${FECHA} 11:00`), 'reservar bloquea su hueco', ocupadas().join(', '));

  // ── Lo que se está probando ───────────────────────────────────────────────
  const antes = ocupadas().length;
  const rCanc = await api(`/reservas/${reservaId}/cancelar`, { method: 'PUT' });
  const bodyCanc = await rCanc.json().catch(() => ({}));
  ok(bodyCanc.ok === true, 'cancelar responde ok', JSON.stringify(bodyCanc).slice(0, 160));
  ok(estado(reservaId) === 'cancelada', 'la reserva queda marcada como cancelada',
     'estado = ' + estado(reservaId));
  ok(ocupadas().length === antes,
     'cancelar NO toca citas_ocupadas — la ocupación la manda el PC',
     `antes ${antes}, ahora ${ocupadas().length}: ${ocupadas().join(', ')}`);
  ok(ocupadas().includes(`${FECHA} 09:30`) && ocupadas().includes(`${FECHA} 10:00`),
     'las citas propias del PC siguen bloqueadas (esto es lo que se rompía)',
     ocupadas().join(', '));

  // El PC re-sincroniza sin esa hora: ahí es donde se libera de verdad.
  await api('/sync-agenda', { method: 'PUT', body: JSON.stringify({
    config: CONFIG,
    citasOcupadas: [
      { fecha: FECHA, hora: '09:30', duracion: 30 },
      { fecha: FECHA, hora: '10:00', duracion: 30 },
    ],
    ventana: { desde: new Date().toISOString().slice(0, 10), hasta: FECHA },
  }) });
  ok(!ocupadas().includes(`${FECHA} 11:00`),
     'tras el sync del PC el hueco sí queda libre', ocupadas().join(', '));
  ok(ocupadas().length === 2, 'y solo quedan las dos citas propias', ocupadas().join(', '));

  // Reactivar una reserva sí vuelve a bloquear: es aditivo, no borra nada.
  await api(`/reservas/${reservaId}/pendiente`, { method: 'PUT' });
  ok(ocupadas().includes(`${FECHA} 11:00`),
     'reactivar vuelve a bloquear el hueco (INSERT OR IGNORE, sigue siendo seguro)',
     ocupadas().join(', '));

  console.log(`\n${pasados} pasados, ${fallados} fallados`);
  try { fs.unlinkSync(TMP); } catch {}
  // Respiro antes de salir: sin el, process.exit() pillaba a las conexiones de fetch a
  // medio cerrar y libuv abortaba en Windows con
  //   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file srcwinasync.c
  // El proceso salia con 127 DESPUES de pasar todas las comprobaciones: un test en verde
  // que quien lo lanza ve en rojo. (Detectado el 27-08-2026.)
  setTimeout(() => process.exit(fallados ? 1 : 0), 300);
}, 2500);
