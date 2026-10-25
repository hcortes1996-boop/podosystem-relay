#!/usr/bin/env node
'use strict';
/**
 * El enlace «La quiero» de la lista de espera (Fase 2), por HTTP real contra una base temporal.
 *
 * Lo que tiene que quedar demostrado, porque es lo que causaría una doble cita:
 *   · el hueco no se lo pueden quedar dos personas;
 *   · abrir el enlace (GET, como la vista previa de WhatsApp) no acepta nada;
 *   · aceptado y sin aplicar, el hueco sigue ocupado aunque el PC sincronice sin él,
 *     con plan de un solo podólogo y con plan Red;
 *   · cualquier cosa que el PC intente con un hueco ya aceptado recibe 409 con quién fue.
 *
 * Uso: node scripts/test_oferta_hueco_e2e.js
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

const TMP = path.join(os.tmpdir(), `relay_oferta_${process.pid}.db`);
const PORT = 3091;
process.env.DB_PATH = TMP;
process.env.PORT = String(PORT);
process.env.NODE_ENV = 'test';
delete process.env.RESEND_API_KEY;

let pasados = 0, fallados = 0;
const ok = (cond, nombre, extra) => {
  if (cond) { pasados++; console.log('  ✅ ' + nombre); }
  else { fallados++; console.log('  ❌ ' + nombre + (extra ? '\n       ' + extra : '')); }
};

require('../src/index.js');

const B = `http://127.0.0.1:${PORT}`;
const CLI = 'testOferta1', KEY = 'k_oferta';
const CLI2 = 'testOferta2', KEY2 = 'k_oferta2';     // una clínica cuyo PC NO sabe de la lista web
const HORARIO = { '0': [], '6': [] };
for (const d of ['1', '2', '3', '4', '5']) HORARIO[d] = [{ inicio: '09:00', fin: '14:00' }, { inicio: '16:00', fin: '20:00' }];

const f = new Date(); f.setDate(f.getDate() + 3);
while (f.getDay() === 0 || f.getDay() === 6) f.setDate(f.getDate() + 1);
const FECHA = f.toISOString().slice(0, 10);
const g = new Date(f); g.setDate(g.getDate() + 7);
const FECHA_LEJOS = g.toISOString().slice(0, 10);

const pedir = async (metodo, ruta, cuerpo, clave) => {
  const r = await fetch(B + ruta, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', ...(clave ? { 'X-Api-Key': clave } : {}) },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const enDosHoras = () => new Date(Date.now() + 2 * 3600000).toISOString();
const oferta = (extra = {}) => ({
  huecoCitaId: 'h1', candidatoCitaId: 'c1', fecha: FECHA, hora: '10:00', duracion: 30,
  nombre: 'Ana Ruiz Pérez', citaActualFecha: FECHA_LEJOS, citaActualHora: '17:00', venceEn: enDosHoras(), ...extra,
});
const sync = (ocupadas, extra = {}) => pedir('PUT', '/api/sync-agenda', {
  config: { duracionSlot: 30, diasMin: 1, diasMax: 14, horario: HORARIO, listaEsperaWeb: true },
  citasOcupadas: ocupadas, ...extra,
}, KEY);

setTimeout(async () => {
  const db = require('better-sqlite3')(TMP);
  db.prepare('INSERT OR REPLACE INTO clinicas (id, nombre, apiKey, activa) VALUES (?,?,?,1)').run(CLI, 'Clínica Oferta', KEY);
  db.prepare('INSERT OR REPLACE INTO clinicas (id, nombre, apiKey, activa) VALUES (?,?,?,1)').run(CLI2, 'Clínica Antigua', KEY2);
  const ocupado = (fecha, hora) => !!db.prepare('SELECT 1 FROM citas_ocupadas WHERE clinicaId = ? AND fecha = ? AND hora = ?').get(CLI, fecha, hora);

  console.log(`\nfecha del hueco: ${FECHA}\n`);
  // El PC sube la agenda: el hueco azul (10:00) y la cita actual de Ana van ocupados.
  await sync([{ fecha: FECHA, hora: '10:00', duracion: 30 }, { fecha: FECHA_LEJOS, hora: '17:00', duracion: 30 }]);

  console.log('── Crear y abrir ──');
  const a = await pedir('POST', '/api/ofertas-hueco', oferta(), KEY);
  ok(a.status === 201 && a.body.token?.length === 32, 'el PC crea la oferta y recibe el token', JSON.stringify(a.body));
  ok((await pedir('POST', '/api/ofertas-hueco', oferta())).status === 401, 'sin clave no se crea nada');
  ok((await pedir('POST', '/api/ofertas-hueco', oferta({ hora: 'x' }), KEY)).status === 400, 'datos malos → 400');

  const v1 = await pedir('GET', `/api/oferta/${a.body.token}`);
  const v2 = await pedir('GET', `/api/oferta/${a.body.token}`);
  ok(v1.status === 200 && v1.body.oferta.puedeResponder && v1.body.oferta.nombre === 'Ana', 'el paciente ve la oferta con su nombre de pila');
  ok(v2.body.oferta.estado === 'abierta', 'abrirla dos veces (vista previa de WhatsApp) NO acepta nada');
  ok(!JSON.stringify(v1.body).includes('Ruiz'), 'sin apellidos en lo que ve el paciente');
  const falso = await pedir('GET', '/api/oferta/' + 'x'.repeat(32));
  ok(falso.status === 404, 'un token inventado → 404');

  console.log('\n── De uno en uno ──');
  const b = await pedir('POST', '/api/ofertas-hueco', oferta({ candidatoCitaId: 'c2', nombre: 'Bea' }), KEY);
  ok(b.status === 201, 'ofrecerlo a Bea retira la de Ana');
  const aTarde = await pedir('POST', `/api/oferta/${a.body.token}/aceptar`);
  ok(aTarde.status === 409 && aTarde.body.motivo === 'retirada', 'Ana pulsa después → «ya no está disponible»', JSON.stringify(aTarde.body));

  console.log('\n── Aceptar: dos a la vez ──');
  const [x1, x2] = await Promise.all([
    pedir('POST', `/api/oferta/${b.body.token}/aceptar`),
    pedir('POST', `/api/oferta/${b.body.token}/aceptar`),
  ]);
  ok(x1.status === 200 && x2.status === 200 && [x1, x2].filter(x => x.body.yaEstaba).length === 1,
     'doble pulsación: una acepta y la otra ve «ya estaba», sin error', `${x1.status} ${x2.status}`);
  ok(db.prepare("SELECT COUNT(*) n FROM ofertas_hueco WHERE clinicaId = ? AND huecoCitaId = 'h1' AND estado = 'aceptada'").get(CLI).n === 1,
     'en la base hay UNA aceptación para ese hueco');
  ok(ocupado(FECHA, '10:00'), 'el hueco está ocupado en la web desde ya');

  console.log('\n── El PC llega tarde ──');
  const otra = await pedir('POST', '/api/ofertas-hueco', oferta({ candidatoCitaId: 'c3', nombre: 'Carla' }), KEY);
  ok(otra.status === 409 && otra.body.yaAceptada && otra.body.oferta.candidatoCitaId === 'c2',
     'ofrecerlo a otra → 409 con quién lo aceptó', JSON.stringify(otra.body).slice(0, 160));
  const ret = await pedir('PUT', '/api/ofertas-hueco/hueco/h1/retirar', null, KEY);
  ok(ret.status === 409 && ret.body.oferta.nombrePila === 'Bea', 'liberarlo o «se la queda» a mano → 409 con quién fue');

  console.log('\n── Sincronizar sin el hueco (PC que aún no se ha enterado) ──');
  await sync([{ fecha: FECHA_LEJOS, hora: '17:00', duracion: 30 }, { fecha: FECHA, hora: '12:00', duracion: 30 }]);
  ok(ocupado(FECHA, '10:00'), 'plan de un podólogo: el hueco aceptado SIGUE ocupado');
  await sync([{ fecha: FECHA, hora: '12:00', duracion: 30 }], {
    podologos: [{ id: 'p1', nombre: 'Pod Uno' }],
    citasOcupadasPorPodologo: [{ fecha: FECHA, hora: '12:00', duracion: 30, podologoId: 'p1' }],
  });
  ok(ocupado(FECHA, '10:00'), 'plan Red: también sigue ocupado en la agregada');
  const reserva10 = await pedir('POST', '/api/reservar-slot', { clinicaId: CLI, fecha: FECHA, hora: '10:00', nombre: 'Intruso', telefono: '600111222' });
  ok(reserva10.status === 409, 'nadie puede reservar las 10:00 por la web', `HTTP ${reserva10.status}`);

  console.log('\n── El PC aplica ──');
  const resp = await pedir('GET', '/api/ofertas-hueco/respondidas', null, KEY);
  ok(resp.body.aceptadas?.length === 1 && resp.body.aceptadas[0].candidatoCitaId === 'c2', 'el PC baja la aceptación con la cita a mover');
  const ap = await pedir('PUT', `/api/ofertas-hueco/${resp.body.aceptadas[0].id}/aplicada`, null, KEY);
  ok(ap.status === 200, 'el PC marca la oferta como aplicada');
  ok((await pedir('GET', '/api/ofertas-hueco/respondidas', null, KEY)).body.aceptadas.length === 0, 'ya no vuelve a bajarla');
  await sync([{ fecha: FECHA, hora: '12:00', duracion: 30 }]);
  ok(!ocupado(FECHA, '10:00'), 'aplicada, el bloqueo deja de forzarse (manda otra vez lo que diga el PC)');

  console.log('\n── Rechazar y caducar ──');
  const c = await pedir('POST', '/api/ofertas-hueco', oferta({ huecoCitaId: 'h2', hora: '11:00', candidatoCitaId: 'c4', nombre: 'Dani' }), KEY);
  const rech = await pedir('POST', `/api/oferta/${c.body.token}/rechazar`);
  ok(rech.status === 200 && rech.body.oferta.estado === 'rechazada', '«No, gracias» queda guardado');
  const resp2 = await pedir('GET', `/api/ofertas-hueco/respondidas?desde=${encodeURIComponent(new Date(Date.now() - 60000).toISOString())}`, null, KEY);
  ok(resp2.body.rechazadas?.some(o => o.candidatoCitaId === 'c4'), 'el PC se entera del rechazo para pasar al siguiente');
  ok((await pedir('POST', `/api/oferta/${c.body.token}/aceptar`)).status === 409, 'después de rechazar ya no puede aceptar');

  const d = await pedir('POST', '/api/ofertas-hueco', oferta({ huecoCitaId: 'h3', hora: '11:30', candidatoCitaId: 'c5', nombre: 'Eva',
    venceEn: new Date(Date.now() + 1500).toISOString() }), KEY);
  await new Promise(r => setTimeout(r, 1800));
  const tarde = await pedir('POST', `/api/oferta/${d.body.token}/aceptar`);
  ok(tarde.status === 409 && tarde.body.motivo === 'caducada', 'pasado el plazo → caducada', JSON.stringify(tarde.body).slice(0, 120));
  ok(!ocupado(FECHA, '11:30'), 'una caducada no bloquea nada');

  console.log('\n── Apuntarse desde la web ──');
  const sem = await pedir('GET', `/api/semana/${CLI}`);
  ok(sem.body.listaEsperaWeb === true, 'con un PC que la sabe usar, la web pinta la casilla');
  const rw = await pedir('POST', '/api/reservar-slot', { clinicaId: CLI, fecha: FECHA, hora: '17:00', nombre: 'Fede', telefono: '600333444', listaEspera: 'tarde' });
  ok(rw.status === 201, 'reserva con la casilla marcada');
  const nuevas = await pedir('GET', '/api/reservas-nuevas', null, KEY);
  ok(nuevas.body.reservas?.find(r => r.nombre === 'Fede')?.listaEsperaFranja === 'tarde', 'el PC recibe la franja elegida');
  const rwMala = await pedir('POST', '/api/reservar-slot', { clinicaId: CLI, fecha: FECHA, hora: '17:30', nombre: 'Gema', telefono: '600333445', listaEspera: 'noche' });
  ok(rwMala.status === 201 && (await pedir('GET', '/api/reservas-nuevas', null, KEY)).body.reservas.find(r => r.nombre === 'Gema').listaEsperaFranja === null,
     'una franja inventada se ignora, la reserva sale igual');

  await pedir('PUT', '/api/sync-agenda', { config: { duracionSlot: 30, diasMin: 1, diasMax: 14, horario: HORARIO }, citasOcupadas: [] }, KEY2);
  ok((await pedir('GET', `/api/semana/${CLI2}`)).body.listaEsperaWeb === false, 'PC antiguo: la web NO pinta la casilla');
  await pedir('POST', '/api/reservar-slot', { clinicaId: CLI2, fecha: FECHA, hora: '17:00', nombre: 'Hugo', telefono: '600333446', listaEspera: 'tarde' });
  ok((await pedir('GET', '/api/reservas-nuevas', null, KEY2)).body.reservas.find(r => r.nombre === 'Hugo')?.listaEsperaFranja === null,
     'PC antiguo: aunque llegue la casilla, no se guarda (nadie la iba a atender)');

  console.log('\n── La página del enlace ──');
  const e = await pedir('POST', '/api/ofertas-hueco', oferta({ huecoCitaId: 'h4', hora: '12:30', candidatoCitaId: 'c6', nombre: 'Inés' }), KEY);
  const pag = await fetch(`${B}/oferta/${e.body.token}`);
  const html = await pag.text();
  ok(pag.status === 200 && html.includes('Clínica Oferta') && !/\{\{[A-Z_0-9]+\}\}/.test(html),
     'la página sale con los datos de la clínica y sin marcadores', `HTTP ${pag.status}`);
  ok(/noindex/.test(html), 'con noindex');
  ok(!html.includes('Inés'), 'el nombre del paciente no va en el HTML (lo pide la página con el token)');
  const pagMala = await fetch(`${B}/oferta/${'y'.repeat(32)}`);
  ok(pagMala.status === 404 && !(await pagMala.text()).includes('Clínica Oferta'), 'un token inventado no enseña ninguna clínica');
  ok(db.prepare("SELECT estado FROM ofertas_hueco WHERE huecoCitaId = 'h4'").get().estado === 'abierta', 'abrir la página no acepta nada');

  console.log(`\n${pasados} pasados, ${fallados} fallados`);
  try { db.close(); fs.unlinkSync(TMP); } catch {}
  setTimeout(() => process.exit(fallados ? 1 : 0), 300);
}, 2500);
