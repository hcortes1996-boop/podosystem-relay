#!/usr/bin/env node
'use strict';
/**
 * test_revision_legal.js — Lo que la revisión legal del 07-10-2026 encontró en el servidor.
 *
 *   · Una licencia caducada o cancelada ya no vale: antes solo se cortaban las bloqueadas, y un
 *     cliente que dejaba de pagar seguía con el programa entero.
 *   · El formulario antiguo de solicitud (guardaba la IP del paciente) está retirado.
 *   · La reserva tiene límite de peticiones.
 *   · Se purgan: cambios del móvil ya recogidos (7 días), solicitudes antiguas (30 días) y los
 *     datos de quien probó y no contrató (12 meses; de sus equipos solo se borra la IP).
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

const TMP = path.join(os.tmpdir(), `relay_revlegal_${process.pid}.db`);
const PORT = 3104;
process.env.DB_PATH = TMP;
process.env.PORT = String(PORT);
process.env.NODE_ENV = 'test';
delete process.env.LIMPIEZA_MODO;

let ok = 0, fallos = 0;
const prueba = (c, n, x) => { if (c) { ok++; console.log('  ✅ ' + n); } else { fallos++; console.log('  ❌ ' + n + (x ? '\n       → ' + x : '')); } };

require('../src/index.js');
const BASE = `http://127.0.0.1:${PORT}`;
const post = (ruta, body) => fetch(BASE + ruta, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

setTimeout(async () => {
  const db = require('better-sqlite3')(TMP);
  try {
    console.log('\n🧪 Revisión legal: lo que había que arreglar en el servidor\n');
    const lic = (id, estado, hw) => db.prepare(
      "INSERT INTO licencias (id, licenseKey, clienteNombre, clienteEmail, estado, hardwareId) VALUES (?,?,'C',?,?,?)")
      .run(id, 'KEY-' + id, id.toLowerCase() + '@x.es', estado, hw);

    console.log('── La licencia caducada ──');
    lic('VIVA', 'active', 'HW1');
    lic('CADUCADA', 'expired', 'HW2');
    lic('CANCELADA', 'cancelled', 'HW3');
    lic('BLOQUEADA', 'blocked', 'HW4');
    lic('CADSINEQUIPO', 'expired', null);
    const verif = (k, hw) => post('/admin/api/licencias/verificar', { licenseKey: 'KEY-' + k, hardwareId: hw });
    let r = await verif('VIVA', 'HW1');
    prueba(r.status === 200 && r.body.ok === true, 'una licencia activa sigue valiendo');
    r = await verif('CADUCADA', 'HW2');
    prueba(r.status === 403 && r.body.ok === false, 'una licencia CADUCADA ya no vale (antes respondía ok)', JSON.stringify(r.body));
    r = await verif('CANCELADA', 'HW3');
    prueba(r.status === 403 && r.body.ok === false, 'una CANCELADA tampoco');
    r = await verif('BLOQUEADA', 'HW4');
    prueba(r.status === 403, 'la bloqueada, como siempre');
    r = await verif('CADSINEQUIPO', 'HW9');
    const est = db.prepare("SELECT estado, hardwareId FROM licencias WHERE id = 'CADSINEQUIPO'").get();
    prueba(r.status === 403 && est.estado === 'expired' && !est.hardwareId,
      'y una caducada sin equipo NO se reactiva al verificarla (antes se ponía «active»)', JSON.stringify(est));
    db.prepare("UPDATE licencias SET estado = 'active' WHERE id = 'CADUCADA'").run();
    r = await verif('CADUCADA', 'HW2');
    prueba(r.status === 200 && r.body.ok, 'al volver a pagar (active), vuelve a valer sola');

    console.log('\n── El formulario antiguo ──');
    db.prepare("INSERT INTO clinicas (id, nombre, apiKey) VALUES ('CLIN1', 'C', 'k1')").run();
    r = await post('/api/solicitud-cita', { clinicaId: 'CLIN1', nombre: 'P', telefono: '600000000', motivo: 'x' });
    prueba(r.status === 410 && /ya no está disponible/.test(r.body.error), 'responde «ya no está disponible» (410)');
    prueba(db.prepare('SELECT COUNT(*) AS n FROM solicitudes').get().n === 0, 'y no guarda nada (ni la IP)');

    console.log('\n── La reserva ──');
    const ag = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'agenda.js'), 'utf8');
    prueba(/router\.post\('\/reservar-slot', limiteReservar,/.test(ag), 'tiene límite de peticiones');

    console.log('\n── Las purgas ──');
    const { revisarClinicas } = require('../src/lib/limpieza-clinicas');
    const DIA = 864e5, AHORA = new Date('2027-06-01T10:00:00Z');
    const hace = d => new Date(AHORA.getTime() - d * DIA).toISOString();
    db.prepare("INSERT INTO citas_remote_ops (id, clinicaId, op, citaId, citaData, syncedAt) VALUES ('o1','CLIN1','add','c1','{}',?), ('o2','CLIN1','add','c2','{}',?), ('o3','CLIN1','add','c3','{}',NULL)")
      .run(hace(10), hace(2));
    db.prepare("INSERT INTO solicitudes (id, clinicaId, nombre, telefono, motivo, creadaEn, ip) VALUES ('s1','CLIN1','P','600','x',?, '1.2.3.4'), ('s2','CLIN1','P','600','x',?, '1.2.3.4')")
      .run(hace(40), hace(5));
    db.prepare("INSERT INTO trials (id, nombre, email, telefono, ultima_descarga, ip) VALUES ('t1','A','vieja@x.es','600',?,'1.1.1.1'), ('t2','B','reciente@x.es','600',?,'1.1.1.1'), ('t3','C','viva@x.es','600',?,'1.1.1.1')")
      .run(hace(400), hace(30), hace(400));
    db.prepare("INSERT INTO trial_instalaciones (hardwareId, inicio, fin, dias, ultimaVista, ip) VALUES ('h1',?,?,60,?,'9.9.9.9'), ('h2',?,?,60,?,'9.9.9.9')")
      .run(hace(500), hace(440), hace(400), hace(40), hace(-20), hace(10));
    const legal = require('../src/lib/legal'); legal.asegurarTabla(db);
    db.prepare("INSERT INTO aceptaciones_legales (id, para, email, fecha, documentos) VALUES ('a1','prueba','vieja@x.es',?,'[]'), ('a2','compra','vieja@x.es',?,'[]')").run(hace(400), hace(400));

    let inf = revisarClinicas(db, { ahora: AHORA, modo: 'ensayo' });
    prueba(inf.purgas && inf.purgas.citasRemotasSincronizadas === 1 && inf.purgas.solicitudesAntiguas === 1 &&
           inf.purgas.pruebasSinContratar === 1 && inf.purgas.ipsDeEquipos === 1 && !inf.purgas.borradas,
      'en ensayo, solo cuenta lo que borraría', JSON.stringify(inf.purgas));
    // «viva@x.es» probó hace 400 días y luego CONTRATÓ: no se toca
    db.prepare("INSERT INTO licencias (id, licenseKey, clienteNombre, clienteEmail, estado) VALUES ('LV','KEY-LV','C','viva@x.es','active')").run();
    inf = revisarClinicas(db, { ahora: AHORA, modo: 'aplicar' });
    const ids = (t, c = 'id') => db.prepare(`SELECT ${c} AS v FROM ${t}`).all().map(x => x.v).sort().join(',');
    prueba(ids('citas_remote_ops') === 'o2,o3', 'los cambios del móvil recogidos hace más de 7 días se borran; los recientes y los pendientes, no', ids('citas_remote_ops'));
    prueba(ids('solicitudes') === 's2', 'las solicitudes antiguas de más de 30 días se borran');
    prueba(ids('trials') === 't2,t3', 'quien probó hace más de 12 meses y no contrató se borra; quien contrató, no', ids('trials'));
    prueba(db.prepare("SELECT ip FROM trial_instalaciones WHERE hardwareId='h1'").get().ip === null &&
           db.prepare("SELECT fin FROM trial_instalaciones WHERE hardwareId='h1'").get().fin,
      'del equipo se borra la IP pero se conserva su fecha de fin (impide repetir la prueba)');
    prueba(db.prepare("SELECT ip FROM trial_instalaciones WHERE hardwareId='h2'").get().ip === '9.9.9.9', 'un equipo reciente conserva su IP');
    prueba(ids('aceptaciones_legales') === 'a2', 'las aceptaciones de prueba antiguas se borran; las de compra, no', ids('aceptaciones_legales'));
  } catch (e) {
    fallos++; console.error('💥', e);
  }
  console.log(`\n${ok} pasados, ${fallos} fallados`);
  try { db.close(); fs.unlinkSync(TMP); } catch {}
  setTimeout(() => process.exit(fallos ? 1 : 0), 300);
}, 2500);
