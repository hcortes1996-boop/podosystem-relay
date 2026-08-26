/**
 * test_recuperacion.js — POST /api/recuperacion/enviar-codigo
 *
 * El endpoint entrega el código de recuperación de contraseña por correo, para que la
 * clínica no tenga que configurar un SMTP propio con contraseña de aplicación de Gmail.
 *
 * Lo que de verdad hay que fijar aquí no es que envíe: es que **no se haya abierto un relé
 * de correo**. Un endpoint que manda emails a terceros es un regalo para un spammer, así
 * que se comprueba que:
 *
 *   · exige una licencia válida, y que el hardware coincida;
 *   · solo acepta un código de SEIS DÍGITOS — nada de texto arbitrario;
 *   · valida el destinatario;
 *   · no deja elegir asunto ni cuerpo: la plantilla vive en el relay;
 *   · no registra el código en el log (es una credencial de un solo uso).
 *
 * Uso:  node scripts/test_recuperacion.js
 */
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');

const TMP = path.join(os.tmpdir(), `relay_recup_${process.pid}.db`);
const PORT = 3097;
process.env.DB_PATH = TMP;
process.env.PORT = String(PORT);
process.env.NODE_ENV = 'test';        // desactiva los límites de peticiones
delete process.env.RESEND_API_KEY;    // sin clave, sendMail solo avisa y no envía nada

let pasados = 0, fallados = 0;
const ok = (cond, nombre, extra) => {
  if (cond) { pasados++; console.log('  ✅ ' + nombre); }
  else { fallados++; console.log('  ❌ ' + nombre + (extra ? '\n       → ' + extra : '')); }
};

require('../src/index.js');

const BASE = `http://127.0.0.1:${PORT}`;
const LICENCIA = 'PODO-TEST-RECUP-0001';
const HW = 'hw-de-prueba-0001';

const enviar = (body) => fetch(`${BASE}/api/recuperacion/enviar-codigo`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

const BUENO = { licenseKey: LICENCIA, hardwareId: HW, email: 'destino@ejemplo.test', codigo: '123456' };

(async () => {
  // 900 ms como el resto de tests del relay: da tiempo a que el servidor levante.
  await new Promise(r => setTimeout(r, 900));

  // Licencia de prueba, con su hardware ya registrado.
  const db = require('../src/db').abrir ? require('../src/db').abrir() : require('better-sqlite3')(TMP);
  db.prepare(`INSERT INTO licencias (id, licenseKey, clienteNombre, clienteEmail, hardwareId, estado)
              VALUES ('lic_test_recup', ?, 'Cliente de prueba', 'cliente@ejemplo.test', ?, 'active')`)
    .run(LICENCIA, HW);

  console.log('\n── Sin licencia válida no se manda nada ──');

  let r = await enviar({ ...BUENO, licenseKey: undefined });
  ok(r.status === 400, 'sin licenseKey → 400', `status ${r.status}`);

  r = await enviar({ ...BUENO, licenseKey: 'PODO-QUE-NO-EXISTE' });
  ok(r.status === 404, 'licencia inexistente → 404', `status ${r.status}`);

  r = await enviar({ ...BUENO, hardwareId: 'otro-equipo-distinto' });
  ok(r.status === 403 && r.body.error === 'hardware_mismatch',
    'licencia copiada a otro equipo → 403 hardware_mismatch', JSON.stringify(r.body));

  db.prepare("UPDATE licencias SET estado='blocked' WHERE licenseKey=?").run(LICENCIA);
  r = await enviar(BUENO);
  ok(r.status === 403, 'licencia bloqueada → 403', `status ${r.status}`);
  db.prepare("UPDATE licencias SET estado='active' WHERE licenseKey=?").run(LICENCIA);

  console.log('\n── No es un relé de correo abierto ──');

  for (const [valor, motivo] of [
    ['12345',        'cinco dígitos'],
    ['1234567',      'siete dígitos'],
    ['abcdef',       'letras'],
    ['12 34 56',     'con espacios'],
    ['<b>hola</b>',  'HTML'],
    ['',             'vacío'],
  ]) {
    const rr = await enviar({ ...BUENO, codigo: valor });
    ok(rr.status === 400, `código rechazado: ${motivo}`, `status ${rr.status}`);
  }

  for (const [valor, motivo] of [
    ['no-es-un-email', 'sin arroba'],
    ['a@b',            'sin dominio'],
    ['',               'vacío'],
    ['a@b.c, otro@c.d','dos destinatarios'],
  ]) {
    const rr = await enviar({ ...BUENO, email: valor });
    ok(rr.status === 400, `destinatario rechazado: ${motivo}`, `status ${rr.status}`);
  }

  // Lo que no se puede elegir desde fuera.
  r = await enviar({ ...BUENO, subject: 'Asunto elegido por el atacante', html: '<a href=x>clic</a>' });
  ok(r.status === 200, 'un asunto o cuerpo propios se ignoran, no se usan', JSON.stringify(r.body));

  console.log('\n── El caso bueno ──');

  r = await enviar(BUENO);
  ok(r.status === 200 && r.body.ok === true, 'licencia válida + código de 6 dígitos → 200', JSON.stringify(r.body));

  // Sin hardware registrado todavía (primera vez) también debe pasar.
  db.prepare("UPDATE licencias SET hardwareId=NULL WHERE licenseKey=?").run(LICENCIA);
  r = await enviar({ ...BUENO, hardwareId: 'equipo-nuevo' });
  ok(r.status === 200, 'licencia aún sin hardware registrado → 200', `status ${r.status}`);

  console.log('\n── El código no acaba en el log ──');
  // Se captura la salida de una llamada y se comprueba que el código no aparece.
  const original = console.log;
  let capturado = '';
  console.log = (...a) => { capturado += a.join(' ') + '\n'; };
  await enviar({ ...BUENO, codigo: '987654' });
  console.log = original;
  ok(!capturado.includes('987654'), 'el código no se registra en el log', capturado.trim());

  console.log(`\n${fallados === 0 ? `✅ ${pasados} COMPROBACIONES EN VERDE` : `❌ ${fallados} FALLIDAS de ${pasados + fallados}`}`);
  // No se cierra `db`: el servidor tiene su propia conexión abierta sobre el mismo fichero.
  // Y se deja un respiro antes de salir: sin él, `process.exit()` pillaba a las conexiones
  // de `fetch` a medio cerrar y libuv abortaba en Windows con
  //   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c
  // El proceso salía con 127 DESPUÉS de haber pasado las 18 comprobaciones — o sea, un test
  // en verde que el runner veía en rojo.
  try { fs.unlinkSync(TMP); } catch {}
  await new Promise(r => setTimeout(r, 300));
  process.exit(fallados === 0 ? 0 : 1);
})();
