#!/usr/bin/env node
'use strict';
/**
 * test_limpieza_clinicas.js — el fin del servicio de una clínica (28-09-2026).
 *
 * Lo que las Condiciones Generales van a prometer y que hoy no hacía nadie:
 *   · la página de citas de una PRUEBA caducada deja de admitir reservas (reversible);
 *   · 30 días después del fin (prueba o licencia), los datos de la clínica se borran del relay,
 *     con ENSAYO por defecto y borrado real solo con modo 'aplicar'.
 */

const path = require('path');
const os   = require('os');
const fs   = require('fs');

const TMP = path.join(os.tmpdir(), `relay_limpieza_${process.pid}.db`);
process.env.DB_PATH = TMP;
delete process.env.LIMPIEZA_MODO;

const { initDB } = require('../src/db');
const { revisarClinicas } = require('../src/lib/limpieza-clinicas');

let ok = 0, fallos = 0;
const prueba = (cond, nombre, extra) => {
  if (cond) { ok++; console.log('  ✅ ' + nombre); }
  else { fallos++; console.error('  ❌ ' + nombre + (extra ? '\n       → ' + extra : '')); }
};

const db = initDB();
const DIA = 24 * 60 * 60 * 1000;
const HOY = new Date('2026-10-01T10:00:00Z');
const dias = (n) => new Date(HOY.getTime() + n * DIA);

const clinica = (id, fuente, activa = 1) =>
  db.prepare("INSERT INTO clinicas (id, nombre, apiKey, fuente, activa) VALUES (?, ?, ?, ?, ?)")
    .run(id, 'CLINICA ' + id, 'key_' + id, fuente, activa);
const prueba_de = (clinicaId, fin, hw) => {
  const tid = 't_' + clinicaId;
  db.prepare(`INSERT INTO trials (id, nombre, email, telefono, clinicaId) VALUES (?, 'X', ?, '600', ?)`)
    .run(tid, clinicaId + '@x.es', clinicaId);
  db.prepare(`INSERT INTO trial_instalaciones (hardwareId, inicio, fin, dias, trialId) VALUES (?, ?, ?, 60, ?)`)
    .run(hw || ('hw_' + clinicaId), '2026-01-01T00:00:00Z', fin.toISOString(), tid);
};
const licencia = (id, clinicaId, estado) =>
  db.prepare("INSERT INTO licencias (id, licenseKey, clienteNombre, clienteEmail, clinicaId, estado) VALUES (?, ?, 'C', 'c@x.es', ?, ?)")
    .run(id, 'KEY-' + id, clinicaId, estado);
const reserva = (clinicaId) =>
  db.prepare("INSERT INTO reservas (id, clinicaId, nombre, telefono, fecha, hora, estado) VALUES (?, ?, 'PACIENTE', '600', '2026-09-01', '10:00', 'sincronizada')")
    .run('r_' + clinicaId + '_' + Math.random().toString(36).slice(2, 7), clinicaId);
const fila = (id) => db.prepare('SELECT activa, desactivadaPor FROM clinicas WHERE id = ?').get(id);

try {
  console.log('\n🧪 Limpieza de clínicas al acabar el servicio\n');

  clinica('PRU_CADUCADA', 'trial'); prueba_de('PRU_CADUCADA', dias(0)); reserva('PRU_CADUCADA');
  clinica('PRU_VIGENTE', 'trial');  prueba_de('PRU_VIGENTE', dias(+10));
  clinica('PRU_STRIPE', 'trial', 0); prueba_de('PRU_STRIPE', dias(+10));   // cerrada por otro
  clinica('PAGO_VIVA', 'manual');   licencia('L_VIVA', 'PAGO_VIVA', 'active'); reserva('PAGO_VIVA');
  clinica('PRU_COMPRO', 'trial');   prueba_de('PRU_COMPRO', dias(-10)); licencia('L_COMPRO', 'PRU_COMPRO', 'active');
  clinica('PAGO_BAJA', 'manual', 0); licencia('L_BAJA', 'PAGO_BAJA', 'expired'); reserva('PAGO_BAJA'); reserva('PAGO_BAJA');
  prueba_de('PAGO_BAJA', dias(-200), 'hw_otra');   // un trial suyo de hace meses: no debe mandar
  // Volvió a suscribirse: una licencia VIEJA caducada y otra NUEVA activa en la misma clínica.
  clinica('PAGO_RENOVO', 'manual'); licencia('L_VIEJA', 'PAGO_RENOVO', 'expired'); licencia('L_NUEVA', 'PAGO_RENOVO', 'active'); reserva('PAGO_RENOVO');

  console.log('── Primera pasada (hoy) ──');
  let inf = revisarClinicas(db, { ahora: HOY });
  prueba(fila('PRU_CADUCADA').activa === 0 && fila('PRU_CADUCADA').desactivadaPor === 'fin_prueba',
    'la página de una prueba CADUCADA deja de admitir reservas', JSON.stringify(fila('PRU_CADUCADA')));
  prueba(fila('PRU_VIGENTE').activa === 1, 'una prueba vigente no se toca');
  prueba(fila('PAGO_VIVA').activa === 1 && fila('PRU_COMPRO').activa === 1,
    'una clínica con licencia VIVA no se toca nunca, aunque naciera como prueba y la prueba acabara');
  prueba(inf.relojIniciado.includes('L_BAJA'), 'la licencia caducada empieza a contar su mes de cortesía');
  prueba(inf.aBorrar.length === 0 && inf.borradas.length === 0, 'y hoy no se borra nada');

  console.log('\n── Se le dan más días a la prueba desde el panel ──');
  db.prepare("UPDATE trial_instalaciones SET fin = ? WHERE hardwareId = 'hw_PRU_CADUCADA'").run(dias(+5).toISOString());
  inf = revisarClinicas(db, { ahora: HOY });
  prueba(fila('PRU_CADUCADA').activa === 1 && fila('PRU_CADUCADA').desactivadaPor === null,
    'se REABRE sola: el cierre por fin de prueba es reversible');
  prueba(fila('PRU_STRIPE').activa === 0, 'pero lo que cerró OTRO (Stripe, el admin) no lo reabre esta tarea');
  db.prepare("UPDATE trial_instalaciones SET fin = ? WHERE hardwareId = 'hw_PRU_CADUCADA'").run(dias(0).toISOString());
  revisarClinicas(db, { ahora: HOY });

  console.log('\n── A los 29 días: aún dentro del mes de cortesía ──');
  inf = revisarClinicas(db, { ahora: dias(29), modo: 'aplicar' });
  prueba(!inf.borradas.some(d => d.clinicaId === 'PAGO_BAJA') && fila('PAGO_BAJA'),
    'la licencia caducada hace 29 días NO se borra, ni en modo aplicar', JSON.stringify(inf.borradas.map(d => d.clinicaId)));

  console.log('\n── A los 31 días, en ENSAYO ──');
  inf = revisarClinicas(db, { ahora: dias(31) });
  const enLista = inf.aBorrar.find(d => d.clinicaId === 'PAGO_BAJA');
  prueba(inf.modo === 'ensayo' && enLista && enLista.filas.reservas === 2,
    'el ensayo dice QUÉ borraría, con cuántas filas', JSON.stringify(enLista));
  prueba(inf.aBorrar.some(d => d.clinicaId === 'PRU_CADUCADA'), 'también la prueba caducada hace más de 30 días');
  prueba(fila('PAGO_BAJA') && db.prepare("SELECT COUNT(*) n FROM reservas WHERE clinicaId='PAGO_BAJA'").get().n === 2,
    'y NO borra nada');
  prueba(enLista && enLista.copiaNube === 'PAGO_BAJA/', 'y avisa de la carpeta de la nube, que el relay no puede borrar');

  console.log('\n── Una licencia que se reactiva a tiempo ──');
  clinica('PAGO_VUELVE', 'manual', 0); licencia('L_VUELVE', 'PAGO_VUELVE', 'expired');
  revisarClinicas(db, { ahora: dias(31) });
  db.prepare("UPDATE licencias SET estado = 'active' WHERE id = 'L_VUELVE'").run();
  inf = revisarClinicas(db, { ahora: dias(40) });
  prueba(inf.relojAnulado.includes('L_VUELVE') &&
         db.prepare("SELECT expiradaEn FROM licencias WHERE id='L_VUELVE'").get().expiradaEn === null,
    'si vuelve a pagar, su reloj se ANULA: no se le borra nada');

  console.log('\n── A los 31 días, APLICANDO ──');
  inf = revisarClinicas(db, { ahora: dias(31), modo: 'aplicar' });
  prueba(inf.borradas.some(d => d.clinicaId === 'PAGO_BAJA') && !fila('PAGO_BAJA'),
    'se borra la clínica caducada hace más de 30 días');
  prueba(db.prepare("SELECT COUNT(*) n FROM reservas WHERE clinicaId='PAGO_BAJA'").get().n === 0,
    'con sus reservas (datos de sus pacientes)');
  const lic = db.prepare("SELECT clinicaId, estado FROM licencias WHERE id='L_BAJA'").get();
  prueba(lic && lic.clinicaId === null, 'la licencia se CONSERVA como historial, desvinculada', JSON.stringify(lic));
  prueba(db.prepare("SELECT COUNT(*) n FROM trials WHERE id='t_PRU_CADUCADA'").get().n === 1 &&
         db.prepare("SELECT clinicaId FROM trials WHERE id='t_PRU_CADUCADA'").get().clinicaId === null,
    'y el registro de la prueba también, desvinculado');
  prueba(fila('PAGO_VIVA') && db.prepare("SELECT COUNT(*) n FROM reservas WHERE clinicaId='PAGO_VIVA'").get().n === 1,
    'la clínica con licencia viva sigue intacta, con sus reservas');
  prueba(fila('PRU_VIGENTE') && fila('PRU_COMPRO') && fila('PAGO_VUELVE'), 'y las demás también');
  prueba(fila('PAGO_RENOVO') && db.prepare("SELECT COUNT(*) n FROM reservas WHERE clinicaId='PAGO_RENOVO'").get().n === 1,
    'una clínica que VOLVIÓ a suscribirse no se borra por su licencia vieja caducada');
} finally {
  try { db.close(); } catch (_) {}
  for (const f of [TMP, TMP + '-wal', TMP + '-shm']) { try { fs.unlinkSync(f); } catch (_) {} }
}

console.log(`\n${ok} bien, ${fallos} mal`);
process.exit(fallos ? 1 : 0);
