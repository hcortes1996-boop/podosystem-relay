/**
 * test_liberar_licencia.js — el botón de soporte que suelta una licencia de su equipo.
 *
 *   POST /admin/api/licencias/:id/liberar
 *   GET  /admin/api/licencias/:id/historial
 *
 * ── Por qué existe, y qué hay que fijar ──────────────────────────────────────
 *
 * `reasignar/*` deja que el cliente se lo haga solo, con un código al correo registrado. Este
 * botón es la salida para el caso que aquel endpoint documenta y no puede resolver: **el dueño
 * ha perdido el acceso a ese buzón, o la licencia nunca tuvo correo.**
 *
 * Hasta hoy eso se hacía borrando a mano un campo de texto en el panel: sin motivo, sin rastro
 * y sin avisar al titular. O sea, la operación más delicada del sistema era también la única
 * sin registro.
 *
 * Lo que se defiende aquí no es que funcione —eso es lo fácil— sino que **no se pueda usar a la
 * ligera ni en silencio**:
 *
 *   · sin motivo y sin decir cómo se comprobó la identidad, NO libera;
 *   · pone `hardwareId` a NULL, nunca escribe una huella inventada;
 *   · deja fila en `reasignaciones` y anota el motivo en la licencia;
 *   · exige token de administrador;
 *   · y no toca el resto de la licencia — ni el plan, ni el estado, ni el clinicaId.
 *
 * Uso:  node scripts/test_liberar_licencia.js
 */
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');

const TMP = path.join(os.tmpdir(), `relay_liberar_${process.pid}.db`);
const PORT = 3094;
process.env.DB_PATH = TMP;
process.env.PORT = String(PORT);
process.env.NODE_ENV = 'test';
process.env.ADMIN_TOKEN = 'token-de-prueba-liberar';
delete process.env.RESEND_API_KEY;    // sin clave, sendMail avisa y no envía nada

let pasados = 0, fallados = 0;
let db = null;
const ok = (cond, nombre, extra) => {
  if (cond) { pasados++; console.log('  ✅ ' + nombre); }
  else { fallados++; console.log('  ❌ ' + nombre + (extra ? '\n       → ' + extra : '')); }
};

require('../src/index.js');

const BASE = `http://127.0.0.1:${PORT}`;
const LICENCIA = 'PODO-TEST-LIBERAR-0001';
const HW = 'huella-del-equipo-viejo-01';

const liberar = (body, token = process.env.ADMIN_TOKEN) =>
  fetch(`${BASE}/admin/api/licencias/lic_liberar/liberar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify(body || {}),
  }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

process.on('uncaughtException', (e) => {
  fallados++; console.log('  💥 excepción no capturada: ' + e.message); cerrar();
});

(async () => {
 try {
  await new Promise(r => setTimeout(r, 900));
  db = require('better-sqlite3')(TMP);

  const sembrar = () => {
    db.prepare('DELETE FROM licencias WHERE licenseKey = ?').run(LICENCIA);
    db.prepare('DELETE FROM reasignaciones').run();
    db.prepare(`INSERT INTO licencias (id, licenseKey, clienteNombre, clienteEmail, clinicaId,
                  hardwareId, instanceId, estado, plan, notas)
                VALUES ('lic_liberar', ?, 'Cliente de prueba', 'duenyo@ejemplo.test', 'CLIN123',
                  ?, 'PodoSystem-PCVIEJO', 'active', 'red', 'nota previa')`)
      .run(LICENCIA, HW);
  };
  const lic = () => db.prepare('SELECT * FROM licencias WHERE id = ?').get('lic_liberar');

  console.log('\n🧪 Liberar una licencia desde el panel\n');

  // ── Lo que impide usarlo a la ligera ──────────────────────────────────────
  console.log('── Sin motivo y sin identidad, no libera ──');
  sembrar();
  {
    const r1 = await liberar({});
    ok(r1.status === 400, 'sin nada: 400', 'status ' + r1.status);
    ok(lic().hardwareId === HW, 'y el equipo sigue asignado');

    const r2 = await liberar({ motivo: 'corto' , identidadVerificada: 'llamó por teléfono' });
    ok(r2.status === 400, 'con un motivo de 5 letras: 400 (se pide algo que se entienda luego)');

    const r3 = await liberar({ motivo: 'se le ha estropeado el ordenador y no puede entrar al correo' });
    ok(r3.status === 400, 'con motivo pero SIN decir cómo se comprobó la identidad: 400');
    ok(lic().hardwareId === HW, 'y sigue sin liberarse nada');
  }

  console.log('\n── Y exige token de administrador ──');
  {
    const r = await liberar(
      { motivo: 'se le ha estropeado el ordenador entero', identidadVerificada: 'factura y teléfono' },
      'token-inventado');
    ok(r.status === 401, 'con un token que no es: 401', 'status ' + r.status);
    ok(lic().hardwareId === HW, 'y el equipo sigue asignado');
  }

  // ── El camino bueno ───────────────────────────────────────────────────────
  console.log('\n── Liberada como debe ──');
  const antes = lic();
  {
    const r = await liberar({
      motivo: 'se le ha estropeado el PC y perdio el acceso a su correo de contacto',
      identidadVerificada: 'llamo desde el telefono registrado y dio el numero de factura',
    });
    ok(r.status === 200 && r.body.ok === true, 'responde ok', JSON.stringify(r.body).slice(0, 120));

    const d = lic();
    ok(d.hardwareId === null, 'el hardwareId queda a NULL — el proximo equipo que active se la queda');
    ok(d.instanceId === '', 'y el instanceId se limpia');

    // Lo que NO puede tocar: si esto cambia, liberar un equipo se convierte en cambiar el plan
    // de un cliente sin querer.
    ok(d.plan === antes.plan, 'NO toca el plan');
    ok(d.estado === antes.estado, 'NO toca el estado');
    ok(d.clinicaId === antes.clinicaId, 'NO toca el clinicaId (sin el, la app no encuentra sus copias)');
    ok(d.licenseKey === antes.licenseKey, 'NO toca la clave');
    ok(d.clienteEmail === antes.clienteEmail, 'NO toca el correo');
  }

  console.log('\n── Deja rastro, que es la mitad del asunto ──');
  {
    const d = lic();
    ok(/Liberada por soporte/.test(d.notas || ''), 'queda anotado en las notas de la licencia');
    ok(/perdio el acceso a su correo/.test(d.notas || ''), 'con el motivo escrito');
    ok(/telefono registrado/.test(d.notas || ''), 'y con como se comprobo la identidad');
    ok(/nota previa/.test(d.notas || ''), 'sin borrar lo que ya hubiera anotado');

    const fila = db.prepare('SELECT * FROM reasignaciones WHERE licenciaId = ?').get('lic_liberar');
    ok(!!fila, 'y fila en reasignaciones, el mismo sitio que el flujo automatico');
    ok(fila && fila.hardwareAntes === HW, 'anotando DE QUE equipo se libero');
    ok(fila && fila.hardwareNuevo === null, 'y que todavia no hay equipo nuevo');
    ok(fila && fila.codigoHash === '', 'con codigoHash vacio: asi se distingue de una del cliente');
  }

  console.log('\n── El historial lo cuenta sin revelar nada ──');
  {
    const r = await fetch(`${BASE}/admin/api/licencias/lic_liberar/historial`, {
      headers: { Authorization: 'Bearer ' + process.env.ADMIN_TOKEN },
    }).then(x => x.json());
    ok(r.ok === true && Array.isArray(r.historial), 'devuelve el historial');
    ok(r.historial[0] && /soporte/.test(r.historial[0].via), 'y dice que la movio soporte, no el cliente');
    ok(!JSON.stringify(r).includes('codigoHash'), 'sin filtrar el hash del codigo');

    const sinAuth = await fetch(`${BASE}/admin/api/licencias/lic_liberar/historial`);
    ok(sinAuth.status === 401, 'y sin token, 401');
  }

  console.log('\n── Liberar dos veces no tiene sentido y se dice ──');
  {
    const r = await liberar({
      motivo: 'intento de liberar una licencia que ya estaba libre',
      identidadVerificada: 'la misma comprobacion de antes',
    });
    ok(r.status === 409, 'la segunda vez: 409, ya estaba libre', 'status ' + r.status);
  }

  console.log('\n── Una licencia que no existe ──');
  {
    const r = await fetch(`${BASE}/admin/api/licencias/no_existe/liberar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.ADMIN_TOKEN },
      body: JSON.stringify({ motivo: 'probando una licencia inexistente', identidadVerificada: 'ninguna' }),
    }).then(async x => ({ status: x.status }));
    ok(r.status === 404, '404, y no 500');
  }

 } catch (e) {
  fallados++; console.log('  💥 ' + e.message);
 }
 cerrar();
})();

// ⚠️ El cierre es el MISMO que el de las demás pruebas del relay, y no por uniformidad.
//
// La primera versión usaba `fs.unlinkSync` y su propio orden, y el proceso moría con
// `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` de libuv **después** de imprimir
// «29 pasados, 0 fallados» — saliendo con código 127. O sea: todas las comprobaciones en
// verde y el `run-tests.js` contándolo como fallo, que es el peor de los dos mundos.
function cerrar() {
  console.log(`\n${fallados ? '❌' : '✅'} ${pasados} en verde, ${fallados} en rojo\n`);

  // Un respiro antes de cerrar la base y salir. Sin él, el proceso moría con
  // `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` de libuv **después** de imprimir
  // el resumen, saliendo con código 127: las 29 comprobaciones en verde y `run-tests.js`
  // contándolo como fallo. El peor de los dos mundos — un rojo que no señala nada.
  //
  // Es una carrera entre el `sendMail` que queda en vuelo (aunque no envíe, pasa por el
  // planificador) y el cierre de la base que el servidor tiene abierta en este mismo proceso.
  setTimeout(() => {
    try { if (db) db.close(); } catch (_) {}
    try { fs.rmSync(TMP, { force: true }); } catch (_) {}
    try { fs.rmSync(TMP + '-wal', { force: true }); fs.rmSync(TMP + '-shm', { force: true }); } catch (_) {}
    process.exit(fallados ? 1 : 0);
  }, 250);
}
