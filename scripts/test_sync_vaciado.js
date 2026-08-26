#!/usr/bin/env node
'use strict';
/**
 * Test — un sync con ocupación vacía no debe borrar la que ya había.
 *
 * Incidente 08-2026, Bug B. El IPC `relay:syncAgenda` del PC envía cero citas
 * ocupadas cuando todas tienen podologoId y el plan no es 'red'. Y ese IPC no
 * se dispara solo desde el botón: también al AÑADIR, EDITAR o ELIMINAR una cita
 * (ClinicaApp.jsx:12835, 12844, 12853). Es decir, decenas de veces al día en una
 * clínica en funcionamiento, dejando la agenda entera reservable hasta el
 * siguiente sync automático.
 *
 * El relay no puede confiar en que el emisor esté sano: si ya tenía ocupación y
 * le llega vacío, conserva la anterior. Para vaciar de verdad hay que pedirlo
 * explícitamente con `permitirVacio: true`.
 *
 * Uso:  node scripts/test_sync_vaciado.js
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

const TMP = path.join(os.tmpdir(), `relay_vac_${process.pid}.db`);
const PORT = 3096;
process.env.DB_PATH = TMP;
process.env.PORT = String(PORT);

let pasados = 0, fallados = 0;
const ok = (cond, nombre, extra) => {
  if (cond) { pasados++; console.log('  ✅ ' + nombre); }
  else { fallados++; console.log('  ❌ ' + nombre + (extra ? '\n       ' + extra : '')); }
};

require('../src/index.js');

const CLINICA = 'testVac01';
const KEY = 'k_vac';
const HORARIO = { '0': [], '6': [],
  '1': [{ inicio: '09:30', fin: '13:00' }], '2': [{ inicio: '09:30', fin: '13:00' }],
  '3': [{ inicio: '09:30', fin: '13:00' }], '4': [{ inicio: '09:30', fin: '13:00' }],
  '5': [{ inicio: '09:30', fin: '13:00' }] };
const CONFIG = { duracionSlot: 30, diasMin: 1, diasMax: 14, horario: HORARIO };

const f = new Date(); f.setDate(f.getDate() + 3);
while (f.getDay() === 0 || f.getDay() === 6) f.setDate(f.getDate() + 1);
const FECHA = f.toISOString().slice(0, 10);

const sync = async (citasOcupadas, extra = {}) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/sync-agenda`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': KEY },
    body: JSON.stringify({ config: CONFIG, citasOcupadas, ...extra }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

setTimeout(async () => {
  const db = require('better-sqlite3')(TMP);
  db.prepare('INSERT OR REPLACE INTO clinicas (id, nombre, apiKey, activa) VALUES (?,?,?,1)')
    .run(CLINICA, 'Clinica Vaciado', KEY);

  const cuenta = () => db.prepare('SELECT COUNT(*) AS n FROM citas_ocupadas WHERE clinicaId = ?')
    .get(CLINICA).n;

  console.log(`\nfecha de prueba: ${FECHA}\n`);

  // 1. Sync inicial con 3 citas
  await sync([
    { fecha: FECHA, hora: '09:30', duracion: 30 },
    { fecha: FECHA, hora: '10:00', duracion: 30 },
    { fecha: FECHA, hora: '11:00', duracion: 60 },
  ]);
  ok(cuenta() === 3, 'sync con 3 citas → quedan 3', 'hay ' + cuenta());

  // 2. Sync vacío: NO debe borrar (es el Bug B llegando desde el PC)
  const rVacio = await sync([]);
  ok(cuenta() === 3, 'sync VACÍO no borra la ocupación previa (Bug B neutralizado)',
     'quedan ' + cuenta() + ' — respuesta: ' + JSON.stringify(rVacio.body).slice(0, 140));
  ok(rVacio.body.ocupacionConservada === true,
     'la respuesta avisa de que se conservó la ocupación',
     JSON.stringify(rVacio.body).slice(0, 140));

  // 3. Sync con datos distintos: sí reemplaza
  await sync([{ fecha: FECHA, hora: '12:00', duracion: 30 }]);
  ok(cuenta() === 1, 'sync con 1 cita sí reemplaza (comportamiento normal intacto)',
     'hay ' + cuenta());

  // 4. Vaciado explícito: sí borra
  await sync([], { permitirVacio: true });
  ok(cuenta() === 0, 'sync vacío CON permitirVacio:true sí borra (agenda realmente vacía)',
     'quedan ' + cuenta());

  // 5. Vacío sin ocupación previa: se aplica sin ruido
  const rVacio2 = await sync([]);
  ok(cuenta() === 0 && rVacio2.body.ok === true,
     'sync vacío sin ocupación previa se aplica normalmente',
     JSON.stringify(rVacio2.body).slice(0, 140));

  console.log(`\n${pasados} pasados, ${fallados} fallados`);
  try { fs.unlinkSync(TMP); } catch {}
  // Respiro antes de salir: sin el, process.exit() pillaba a las conexiones de fetch a
  // medio cerrar y libuv abortaba en Windows con
  //   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file srcwinasync.c
  // El proceso salia con 127 DESPUES de pasar todas las comprobaciones: un test en verde
  // que quien lo lanza ve en rojo. (Detectado el 27-08-2026.)
  setTimeout(() => process.exit(fallados ? 1 : 0), 300);
}, 2500);
