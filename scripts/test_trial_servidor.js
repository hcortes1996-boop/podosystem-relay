/**
 * test_trial_servidor.js — T2: la cuenta del trial la lleva el servidor.
 *
 * Lo que hay que fijar aqui, y por que cada cosa:
 *
 *   · La fecha de fin se decide UNA vez. Si volver a preguntar la moviera, el PC solo
 *     tendria que reinstalar para estrenar 60 dias — que es exactamente el agujero que
 *     esta pieza viene a cerrar.
 *   · Subir TRIAL_DIAS no alarga los trials en curso. Por eso `dias` se guarda con la
 *     fila y no se lee de la constante al responder.
 *   · Una huella con mala pinta se rechaza sin tocar la base.
 *   · Borrar los datos personales de alguien (derecho de supresion) NO le devuelve el
 *     periodo de prueba. Seria una forma elegante de reiniciarlo: pides que te borren y
 *     estrenas otros 60 dias.
 *   · Y que un fallo del servidor no invente fechas: responde 503 y el PC se queda con
 *     su cuenta local, que nunca es mas generosa.
 *
 * Uso:  node scripts/test_trial_servidor.js
 */
'use strict';

const path = require('path');
const os   = require('os');
const fs   = require('fs');

const TMP  = path.join(os.tmpdir(), `relay_trial_srv_${process.pid}.db`);
const PORT = 3097;
process.env.DB_PATH     = TMP;
process.env.PORT        = String(PORT);
process.env.NODE_ENV    = 'test';
process.env.ADMIN_TOKEN = 'token-de-prueba';

let pasados = 0, fallados = 0;
const ok = (cond, nombre, extra) => {
  if (cond) { pasados++; console.log('  ✅ ' + nombre); }
  else { fallados++; console.log('  ❌ ' + nombre + (extra ? '\n       → ' + extra : '')); }
};

const descarga = require('../src/lib/descarga');
descarga.ultimaDescarga = async () => ({ url: 'https://x/y.exe', version: 'v9.9.9' });

require('../src/index.js');
// Se abre una segunda conexion al mismo fichero para poder mirar y forzar estados.
const db = require('better-sqlite3')(TMP);

const BASE = `http://127.0.0.1:${PORT}`;
const estado = (body) => fetch(`${BASE}/api/trial/estado`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

const admin = (ruta, opts = {}) => fetch(`${BASE}/admin${ruta}`, {
  ...opts,
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token-de-prueba', ...(opts.headers || {}) },
}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

const HUELLA  = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const HUELLA2 = '00112233445566778899aabbccddeeff';

(async () => {
  await new Promise(r => setTimeout(r, 400));

  console.log('\n── Primera vez que se ve un equipo ──');
  let r = await estado({ hardwareId: HUELLA, version: '3.5.2' });
  ok(r.status === 200 && r.body.ok === true, 'responde correctamente');
  ok(r.body.nuevo === true, 'lo marca como equipo nuevo');
  ok(r.body.dias === 60, 'con 60 dias', String(r.body.dias));
  ok(r.body.diasRestantes === 60, 'y 60 restantes', String(r.body.diasRestantes));
  const finOriginal = r.body.fin;
  ok(typeof finOriginal === 'string' && finOriginal.length > 10, 'devuelve una fecha de fin');

  console.log('\n── Volver a preguntar NO mueve la fecha ──');
  r = await estado({ hardwareId: HUELLA, version: '3.5.2' });
  ok(r.body.nuevo === false, 'ya no es nuevo');
  ok(r.body.fin === finOriginal, 'la fecha de fin es LA MISMA', `${r.body.fin} vs ${finOriginal}`);

  console.log('\n── Que es lo que de verdad cierra el agujero ──');
  // Se simula lo que hoy funciona: el usuario borra trial.dat y vuelve a arrancar. Para el
  // servidor eso es simplemente otra consulta con la misma huella.
  db.prepare('UPDATE trial_instalaciones SET inicio = ?, fin = ? WHERE hardwareId = ?')
    .run(new Date(Date.now() - 55 * 86400000).toISOString(),
         new Date(Date.now() + 5 * 86400000).toISOString(), HUELLA);
  r = await estado({ hardwareId: HUELLA });
  ok(r.body.diasRestantes === 5,
    'un equipo que va por el dia 55 sigue teniendo 5 dias, no 60', String(r.body.diasRestantes));

  console.log('\n── Un trial ya agotado no revive ──');
  db.prepare('UPDATE trial_instalaciones SET fin = ? WHERE hardwareId = ?')
    .run(new Date(Date.now() - 3 * 86400000).toISOString(), HUELLA);
  r = await estado({ hardwareId: HUELLA });
  ok(r.body.diasRestantes === 0, 'cero dias restantes', String(r.body.diasRestantes));
  ok(r.body.nuevo === false, 'y no se le trata como equipo nuevo');

  console.log('\n── Equipos distintos son trials distintos ──');
  r = await estado({ hardwareId: HUELLA2 });
  ok(r.body.nuevo === true && r.body.diasRestantes === 60,
    'otro equipo estrena sus propios 60 dias');

  console.log('\n── Subir el trial a 90 dias no alarga los que ya empezaron ──');
  // `dias` se guarda con la fila justamente para esto.
  const fila = db.prepare('SELECT dias FROM trial_instalaciones WHERE hardwareId = ?').get(HUELLA2);
  ok(fila.dias === 60, 'la duracion queda grabada en la fila, no se lee de la constante');

  console.log('\n── Huellas que no valen ──');
  for (const [mala, motivo] of [
    ['',                                  'vacia'],
    ['abc',                               'demasiado corta'],
    ['A1B2C3D4E5F60718293A4B5C6D7E8F9Z',  'con caracteres que no son hex'],
    ['a'.repeat(64),                      'demasiado larga'],
  ]) {
    const rr = await estado({ hardwareId: mala });
    ok(rr.status === 400, `se rechaza una huella ${motivo}`, String(rr.status));
  }
  const antes = db.prepare('SELECT COUNT(*) c FROM trial_instalaciones').get().c;
  await estado({ hardwareId: 'no-vale' });
  ok(db.prepare('SELECT COUNT(*) c FROM trial_instalaciones').get().c === antes,
    'y una huella rechazada no deja fila en la base');

  console.log('\n── Mayusculas y espacios: mismo equipo, no uno nuevo ──');
  r = await estado({ hardwareId: '  ' + HUELLA2.toUpperCase() + '  ' });
  ok(r.body.nuevo === false, 'la huella se normaliza antes de buscarla');

  console.log('\n── Se apunta la version que corre cada equipo ──');
  await estado({ hardwareId: HUELLA2, version: '3.6.0' });
  const v = db.prepare('SELECT version, vistas FROM trial_instalaciones WHERE hardwareId = ?').get(HUELLA2);
  ok(v.version === '3.6.0', 'se guarda la ultima version vista', v.version);
  ok(v.vistas >= 3, 'y se cuentan las consultas', String(v.vistas));

  console.log('\n── Derecho de supresion: borra los datos, NO devuelve el trial ──');
  // Alguien se descarga la prueba dejando sus datos, y ese equipo empieza su trial.
  await fetch(`${BASE}/api/trial/registrar`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nombre: 'Ana', email: 'ana@ejemplo.test', telefono: '600123456', aceptaPrivacidad: true }),
  });
  const idTrial = db.prepare('SELECT id FROM trials WHERE email = ?').get('ana@ejemplo.test').id;
  db.prepare('UPDATE trial_instalaciones SET trialId = ? WHERE hardwareId = ?').run(idTrial, HUELLA2);

  const d = await admin(`/api/trials/${idTrial}`, { method: 'DELETE' });
  ok(d.status === 200 && d.body.borrados === 1, 'se borran sus datos personales');
  const tras = db.prepare('SELECT trialId, ip FROM trial_instalaciones WHERE hardwareId = ?').get(HUELLA2);
  ok(tras !== undefined, 'la instalacion NO se borra — si no, estrenaria otros 60 dias');
  ok(tras.trialId === null && tras.ip === null, 'pero se queda sin nada que apunte a una persona');
  r = await estado({ hardwareId: HUELLA2 });
  ok(r.body.nuevo === false, 'y el equipo sigue con su trial de siempre');

  console.log('\n── Si el servidor falla, no inventa fechas ──');
  // Se rompe la tabla por debajo: es la forma honesta de provocar el fallo sin tocar el
  // codigo del servidor, y comprueba tambien que el error se atrapa donde debe.
  db.exec('ALTER TABLE trial_instalaciones RENAME TO trial_instalaciones_off');
  r = await estado({ hardwareId: '11111111111111111111111111111111' });
  db.exec('ALTER TABLE trial_instalaciones_off RENAME TO trial_instalaciones');
  ok(r.status === 503, 'responde 503 y no un trial improvisado', String(r.status));
  ok(!r.body.fin, 'sin fecha de fin en la respuesta');

  console.log(`\n${fallados === 0 ? `✅ ${pasados} COMPROBACIONES EN VERDE` : `❌ ${fallados} FALLIDAS de ${pasados + fallados}`}`);
  try { fs.unlinkSync(TMP); } catch {}
  await new Promise(r => setTimeout(r, 300));
  process.exit(fallados === 0 ? 0 : 1);
})();
