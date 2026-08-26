#!/usr/bin/env node
'use strict';
/**
 * Tests de `GET /reservas-gestionadas` — lo que el PC baja para enterarse de que un
 * paciente ha anulado, o lo ha intentado fuera de plazo.
 *
 * Lo que importa aquí:
 *   · Que las anulaciones y los intentos NO se mezclen. Una anulación libera un
 *     hueco; un intento deja la cita en pie y pide una llamada. Tratarlos igual
 *     sería peor que no avisar.
 *   · Que `desde` acote de verdad. Sin eso el PC reprocesaría lo mismo cada minuto.
 *   · Que una clínica no vea las reservas de otra.
 *
 * Uso:  node scripts/test_gestionadas.js
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

const TMP = path.join(os.tmpdir(), `relay_gest_${process.pid}.db`);
const PORT = 3099;
process.env.DB_PATH = TMP;
process.env.PORT = String(PORT);
process.env.NODE_ENV = 'test';

let pasados = 0, fallados = 0;
const ok = (cond, nombre, extra) => {
  if (cond) { pasados++; console.log('  ✅ ' + nombre); }
  else { fallados++; console.log('  ❌ ' + nombre + (extra ? '\n       ' + extra : '')); }
};

require('../src/index.js');

const A = { id: 'gestA', key: 'k_gestA' };
const B = { id: 'gestB', key: 'k_gestB' };

setTimeout(async () => {
  const db = require('better-sqlite3')(TMP);
  for (const c of [A, B]) {
    db.prepare('INSERT OR REPLACE INTO clinicas (id, nombre, apiKey, activa) VALUES (?,?,?,1)')
      .run(c.id, 'Clinica ' + c.id, c.key);
  }

  const t = (offsetMin) => new Date(Date.now() + offsetMin * 60000).toISOString();
  const meter = (clinicaId, id, extra = {}) => {
    const f = { fecha: '2026-09-10', hora: '10:00', duracion: 30, nombre: 'P ' + id,
                telefono: '600000000', estado: 'pendiente_pc', ...extra };
    db.prepare(`INSERT INTO reservas (id, clinicaId, fecha, hora, duracion, nombre, telefono,
                estado, canceladaEn, canceladaPor, motivoCancelacion, intentoAnularEn, intentoAnularNota)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, clinicaId, f.fecha, f.hora, f.duracion, f.nombre, f.telefono, f.estado,
           f.canceladaEn || null, f.canceladaPor || null, f.motivoCancelacion || null,
           f.intentoAnularEn || null, f.intentoAnularNota || null);
  };
  const pedir = async (clinica, desde) => {
    const q = desde ? `?desde=${encodeURIComponent(desde)}` : '';
    const r = await fetch(`http://127.0.0.1:${PORT}/api/reservas-gestionadas${q}`,
      { headers: { 'X-Api-Key': clinica.key } });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };

  // Anulada por el paciente hace 10 min
  meter(A.id, 'r_anulada', { estado: 'cancelada', canceladaEn: t(-10), canceladaPor: 'paciente',
                             motivoCancelacion: 'Imprevisto' });
  // Anulada por la CLÍNICA: el PC ya lo sabe, no debe volver
  meter(A.id, 'r_anul_clinica', { estado: 'cancelada', canceladaEn: t(-10), canceladaPor: 'clinica' });
  // Intento fuera de plazo hace 5 min, la reserva sigue activa
  meter(A.id, 'r_intento', { intentoAnularEn: t(-5), intentoAnularNota: 'No puedo ir' });
  // De otra clínica
  meter(B.id, 'r_de_B', { estado: 'cancelada', canceladaEn: t(-10), canceladaPor: 'paciente' });

  console.log('\n── Separa anulaciones de intentos ──');
  let { status, body } = await pedir(A);
  ok(status === 200 && body.ok, 'responde', JSON.stringify(body).slice(0, 120));
  ok(body.canceladas.length === 1 && body.canceladas[0].id === 'r_anulada',
     'solo la anulada POR EL PACIENTE', JSON.stringify(body.canceladas.map(x => x.id)));
  ok(!body.canceladas.some(x => x.id === 'r_anul_clinica'),
     'la que canceló la propia clínica NO vuelve — el PC ya lo sabía');
  ok(body.intentos.length === 1 && body.intentos[0].id === 'r_intento',
     'el intento va en su propia lista', JSON.stringify(body.intentos.map(x => x.id)));
  ok(body.canceladas[0].motivoCancelacion === 'Imprevisto', 'con el motivo del paciente');
  ok(body.intentos[0].intentoAnularNota === 'No puedo ir', 'y el intento con el suyo');
  ok(!!body.hasta, 'devuelve `hasta` para que el PC guarde la marca de agua');

  console.log('\n── Un intento NO es una anulación ──');
  ok(!body.canceladas.some(x => x.id === 'r_intento'),
     'CRÍTICO: el intento no aparece como anulación — su cita sigue en pie');

  console.log('\n── Aislamiento entre clínicas ──');
  ok(!JSON.stringify(body).includes('r_de_B'), 'A no ve las reservas de B');
  const deB = await pedir(B);
  ok(deB.body.canceladas.length === 1 && deB.body.canceladas[0].id === 'r_de_B', 'y B ve las suyas');
  const sinKey = await fetch(`http://127.0.0.1:${PORT}/api/reservas-gestionadas`);
  ok(sinKey.status === 401, 'sin apiKey se rechaza', String(sinKey.status));

  console.log('\n── `desde` acota ──');
  const conMarca = await pedir(A, t(-1));   // hace 1 min: todo es anterior
  ok(conMarca.body.canceladas.length === 0 && conMarca.body.intentos.length === 0,
     'con la marca al día no devuelve nada — el PC no reprocesa',
     JSON.stringify({ c: conMarca.body.canceladas.length, i: conMarca.body.intentos.length }));

  const conMarcaVieja = await pedir(A, t(-60));
  ok(conMarcaVieja.body.canceladas.length === 1 && conMarcaVieja.body.intentos.length === 1,
     'con una marca de hace una hora sí devuelve ambas');

  // Un PC apagado varios días se pone al día solo (por defecto, 7 días).
  meter(A.id, 'r_vieja', { estado: 'cancelada', canceladaEn: t(-60 * 24 * 3), canceladaPor: 'paciente' });
  const sinMarca = await pedir(A);
  ok(sinMarca.body.canceladas.some(x => x.id === 'r_vieja'),
     'sin marca alcanza 7 días atrás: un PC apagado se pone al día');
  meter(A.id, 'r_antigua', { estado: 'cancelada', canceladaEn: t(-60 * 24 * 20), canceladaPor: 'paciente' });
  const sinMarca2 = await pedir(A);
  ok(!sinMarca2.body.canceladas.some(x => x.id === 'r_antigua'),
     'pero no arrastra lo de hace 20 días');

  console.log('\n── Orden ──');
  meter(A.id, 'r_anulada2', { estado: 'cancelada', canceladaEn: t(-2), canceladaPor: 'paciente' });
  const orden = await pedir(A, t(-30));
  const fechas = orden.body.canceladas.map(x => x.canceladaEn);
  ok(fechas.join() === [...fechas].sort().join(), 'las anulaciones llegan en orden cronológico');

  console.log(`\n${pasados} pasados, ${fallados} fallados`);
  try { fs.unlinkSync(TMP); } catch {}
  // Respiro antes de salir: sin el, process.exit() pillaba a las conexiones de fetch a
  // medio cerrar y libuv abortaba en Windows con
  //   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c
  // El proceso salia con 127 DESPUES de pasar las 16 comprobaciones: un test en verde que
  // quien lo lanza ve en rojo. (Detectado el 27-08-2026.)
  setTimeout(() => process.exit(fallados ? 1 : 0), 300);
}, 2500);
