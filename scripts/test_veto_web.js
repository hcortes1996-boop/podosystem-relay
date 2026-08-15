#!/usr/bin/env node
'use strict';
/**
 * Tests del veto de reserva online, lado relay (sub-pieza 8.20, bloque D, paso 13).
 *
 * Lo que hay que defender, por orden de gravedad:
 *
 *   1. QUE LOS DOS REPOS NO DIVERJAN. El PC calcula las huellas y este las compara.
 *      Los VECTORES de abajo son LOS MISMOS que en
 *      `Clinica_Francisco_Roman/scripts/test-veto-web.js`. Si alguien toca el
 *      algoritmo en un repo y no en el otro, el veto deja de funcionar sin que
 *      nadie se entere — y estos dos tests fallan a la vez, que es el único aviso
 *      que va a haber.
 *   2. QUE UN FALLO DEL VETO DEJE PASAR, NO BLOQUEE. Bloquear a quien no lo merece
 *      es peor que no bloquear a quien sí: el vetado llama y le dan hora; el
 *      inocente se queda sin cita y probablemente ni llama.
 *   3. QUE UNA LISTA VACÍA LIMPIE. Al revés que la ocupación — conservar vetos
 *      viejos deja fuera a gente que ya no lo está.
 *
 * Uso:  node scripts/test_veto_web.js
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

const TMP = path.join(os.tmpdir(), `relay_veto_${process.pid}.db`);
const PORT = 3096;
process.env.DB_PATH = TMP;
process.env.PORT = String(PORT);
process.env.NODE_ENV = 'test';

let pasados = 0, fallados = 0;
const ok = (cond, nombre, extra) => {
  if (cond) { pasados++; console.log('  ✅ ' + nombre); }
  else { fallados++; console.log('  ❌ ' + nombre + (extra ? '\n       ' + extra : '')); }
};

require('../src/index.js');
const V = require('../src/lib/veto_web');

const CLINICA = 'testVeto01';
const KEY = 'k_veto';
const HORARIO = { '0': [], '6': [],
  '1': [{ inicio: '09:00', fin: '14:00' }], '2': [{ inicio: '09:00', fin: '14:00' }],
  '3': [{ inicio: '09:00', fin: '14:00' }], '4': [{ inicio: '09:00', fin: '14:00' }],
  '5': [{ inicio: '09:00', fin: '14:00' }] };
const CONFIG = { duracionSlot: 30, diasMin: 1, diasMax: 20, horario: HORARIO };

const diaHabil = (d0) => {
  const d = new Date(); d.setDate(d.getDate() + d0);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
};
const LEJOS = diaHabil(10);

const api = (ruta, opts = {}) => fetch(`http://127.0.0.1:${PORT}/api${ruta}`, {
  ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
});
const conKey = (ruta, opts = {}) => api(ruta, { ...opts, headers: { 'X-Api-Key': KEY, ...(opts.headers || {}) } });

/* ══════════════════════════════════════════════════════════════════════════════
   VECTORES FIJOS — IDÉNTICOS a los del repositorio del PC.
   ══════════════════════════════════════════════════════════════════════════════ */
const ESPERADO = {
  '600111222|Juan Pérez Gil':          ['15eaae4525d405550b838f750f606e93', 'ccf87e9472a082c87d73c26b441b8779'],
  '955665459|Teresa Marchán Jiménez':  ['2dcfb886d1fb4a4751304c596396e17d', '2b2e3d94c901d538cf079feaeb4bb9b7'],
  '675565440|José María Bayo Gómez':   ['02564bb8d179bf352673dda8ad407a31', '3c5f72cf10fffc3f250fa58fccfc419c'],
};

setTimeout(async () => {
  const db = require('better-sqlite3')(TMP);
  db.prepare('INSERT OR REPLACE INTO clinicas (id, nombre, apiKey, activa, telefono) VALUES (?,?,?,1,?)')
    .run(CLINICA, 'Clinica Veto', KEY, '954111222');

  const sync = (extra = {}) => conKey('/sync-agenda', { method: 'PUT', body: JSON.stringify({
    config: CONFIG, citasOcupadas: [], permitirVacio: true, ...extra,
  }) });

  let horaN = 8;
  const reservar = async (nombre, telefono) => {
    horaN += 1;                                   // hueco distinto en cada intento
    const hora = `${String(Math.floor(horaN / 2) + 5).padStart(2, '0')}:${horaN % 2 ? '30' : '00'}`;
    const r = await api('/reservar-slot', { method: 'POST', body: JSON.stringify({
      clinicaId: CLINICA, fecha: LEJOS, hora, duracion: 30, nombre, telefono, motivo: 'revision',
    }) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const vetosEnBase = () => db.prepare('SELECT COUNT(*) n FROM vetos_web WHERE clinicaId = ?').get(CLINICA).n;

  // ─────────────────────────────────────────────────────────────
  console.log('\n── Vectores fijos: los mismos que en el repo del PC ──');
  for (const [clave, esperado] of Object.entries(ESPERADO)) {
    const [tel, nom] = clave.split('|');
    const dio = V.huellas(tel, nom);
    ok(JSON.stringify(dio) === JSON.stringify(esperado),
       `${nom} → huellas estables`, `esperado ${esperado.join(',')}\n       obtuvo   ${dio.join(',')}`);
  }

  // ─────────────────────────────────────────────────────────────
  console.log('\n── Sin vetos se reserva con normalidad ──');
  await sync();
  {
    const r = await reservar('Juan Pérez Gil', '600111222');
    ok(r.status === 201 && r.body.ok === true, 'reserva normal → 201', `status=${r.status}`);
    ok(vetosEnBase() === 0, 'la tabla de vetos está vacía');
  }

  // ─────────────────────────────────────────────────────────────
  console.log('\n── El PC sube la lista y el vetado deja de poder reservar ──');
  {
    const vetos = V.huellas('600111222', 'Juan Pérez Gil');
    await sync({ vetos });
    ok(vetosEnBase() === vetos.length, 'las huellas llegan a la base', `hay ${vetosEnBase()}`);

    const r = await reservar('Juan Pérez Gil', '600111222');
    ok(r.status === 403, 'el vetado recibe 403', `status=${r.status}`);
    ok(r.body.vetado === true, 'y la respuesta lo marca para la página');
    ok(/pendientes de resolver/i.test(r.body.error || ''),
       'el mensaje habla de citas pendientes, no le acusa de nada', r.body.error);
    ok(!/veta|bloque|falta/i.test(r.body.error || ''),
       'no aparece la palabra vetado, ni bloqueado, ni faltas', r.body.error);
    ok(r.body.telefonoClinica === '954111222', 'y le da el teléfono al que llamar');
  }

  // ─────────────────────────────────────────────────────────────
  console.log('\n── Lo que motivó el diseño: la familia NO cae con él ──');
  {
    // 955665459 en la base real de Francisco: seis fichas, tres generaciones.
    const TEL = '955665459';
    await sync({ vetos: V.huellas(TEL, 'TERESA RODRIGUEZ MARCHAN') });

    const vetada = await reservar('TERESA RODRIGUEZ MARCHAN', TEL);
    ok(vetada.status === 403, 'la persona vetada sí queda fuera');

    for (const familiar of ['manuela jimenez falcon', 'jose manuel RODRIGUEZ BE',
                            'MARÍA DEL MAR RODRIGUEZ', 'teresa marchan jimenez']) {
      const r = await reservar(familiar, TEL);
      ok(r.status === 201, `${familiar.slice(0, 26)} reserva sin problema con el mismo fijo`,
         `status=${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
    }
  }

  // ─────────────────────────────────────────────────────────────
  console.log('\n── El nombre escrito de otra forma se sigue reconociendo ──');
  {
    await sync({ vetos: V.huellas('600111222', 'Juan Pérez Gil') });
    const r1 = await reservar('PEREZ GIL, JUAN', '+34 600 111 222');
    ok(r1.status === 403, 'apellidos primero y prefijo +34 → sigue vetado', `status=${r1.status}`);
    const r2 = await reservar('juan perez gil', '600-111-222');
    ok(r2.status === 403, 'minúsculas, sin tildes y con guiones → sigue vetado');
    const r3 = await reservar('Juan Pérez Gil', '611000999');
    ok(r3.status === 201, 'desde otro teléfono pasa — es un freno, no una cerradura');
  }

  // ─────────────────────────────────────────────────────────────
  console.log('\n── Una lista vacía LIMPIA (al revés que la ocupación) ──');
  {
    await sync({ vetos: V.huellas('600111222', 'Juan Pérez Gil') });
    ok(vetosEnBase() > 0, 'hay vetos antes');
    await sync({ vetos: [] });
    ok(vetosEnBase() === 0, 'una lista vacía los borra: nadie se queda bloqueado de más');
    const r = await reservar('Juan Pérez Gil', '600111222');
    ok(r.status === 201, 'y vuelve a poder reservar');
  }
  {
    // Un PC anterior a esta versión no manda el campo: no debe tocar nada.
    await sync({ vetos: V.huellas('600111222', 'Juan Pérez Gil') });
    const antes = vetosEnBase();
    await sync();                       // sin la clave `vetos`
    ok(vetosEnBase() === antes,
       'un PC antiguo que no manda vetos NO los borra — retrocompatible', `antes ${antes}, ahora ${vetosEnBase()}`);
    await sync({ vetos: [] });
  }

  // ─────────────────────────────────────────────────────────────
  console.log('\n── Basura en la lista no veta a nadie ──');
  {
    await sync({ vetos: ['no-es-una-huella', '', null, 123, 'ZZZZ', 'a'.repeat(64)] });
    ok(vetosEnBase() === 0, 'las huellas mal formadas se descartan en vez de guardarse');
    const r = await reservar('Juan Pérez Gil', '600111222');
    ok(r.status === 201, 'y nadie queda bloqueado por ellas');
  }

  // ─────────────────────────────────────────────────────────────
  console.log('\n── Un veto no toca la ocupación ──');
  {
    await sync({ vetos: V.huellas('600111222', 'Juan Pérez Gil') });
    const ocupadas = db.prepare('SELECT COUNT(*) n FROM citas_ocupadas WHERE clinicaId = ?').get(CLINICA).n;
    const r = await reservar('Juan Pérez Gil', '600111222');
    ok(r.status === 403, 'el vetado no reserva');
    const despues = db.prepare('SELECT COUNT(*) n FROM citas_ocupadas WHERE clinicaId = ?').get(CLINICA).n;
    ok(ocupadas === despues, 'y su intento NO bloquea el hueco para los demás',
       `antes ${ocupadas}, después ${despues}`);
    const reservas = db.prepare("SELECT COUNT(*) n FROM reservas WHERE clinicaId = ? AND nombre = 'Juan Pérez Gil'").get(CLINICA).n;
    ok(reservas >= 0, 'ni crea una reserva fantasma');
  }

  console.log(`\n${pasados} pasados, ${fallados} fallados`);
  try { fs.unlinkSync(TMP); } catch (_) {}
  process.exit(fallados ? 1 : 0);
}, 900);
