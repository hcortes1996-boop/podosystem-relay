#!/usr/bin/env node
'use strict';
/**
 * test_trial_web.js — Un trial activa su web de citas: verifica el correo y se le crea la clínica.
 *
 * ── Qué defiende ─────────────────────────────────────────────────────────────
 *
 * Bloque 2 del estudio (`docs/estudio_citas_web_en_el_trial.md`, decisión ③). El propio estudio
 * dejó escrito qué hay que probar, y es la espina de este fichero:
 *
 *   «que un código caducado o gastado no sirva; que dos verificaciones del mismo correo no creen
 *    dos clínicas; que sin verificar NO se cree ninguna».
 *
 * Las tres importan por lo mismo: aquí se crean clínicas solas, sin que intervenga nadie. Si eso
 * se puede disparar sin verificar, o dos veces, el panel se llena de clínicas fantasma y la
 * decisión ③ —«visible en el panel para poder borrar clientes falsos»— deja de servir de nada.
 *
 * ⚠️ El código se guarda **hasheado**, así que no se puede leer de la base. Se intercepta el
 * envío de correo para capturarlo, que además prueba de paso que el correo sale con el código
 * dentro y no vacío.
 *
 *   node scripts/test_trial_web.js
 */

const path = require('path');
const os   = require('os');
const fs   = require('fs');

const TMP  = path.join(os.tmpdir(), `relay_trialweb_${process.pid}.db`);

/* ⚠️ Un puerto que NO usa ninguna otra prueba.
 *
 * El banco comparte puertos a base de bien: el 3096 lo usan cinco ficheros, el 3097 otros
 * cinco, y el 3099 —que era el elegido aquí— ya lo usaba `test_gestionadas`. Mientras las
 * pruebas corran de una en una eso es inofensivo… salvo que una muera con `process.exit`
 * **sin cerrar su servidor**, que es lo que hacen casi todas: entonces el puerto sigue
 * ocupado por el proceso anterior y la siguiente prueba acaba hablando con la base de otra.
 *
 * Encaja con el sintoma visto el 20-09-2026: `no such table: trial_instalaciones` en una
 * prueba que sola pasa y en bateria falla, con el fichero de base intacto y con la tabla
 * dentro. No se ha demostrado que fuera esto —el fallo no se reproduce—, pero añadir una
 * colision mas cuando quitarla es gratis no tiene defensa.
 */
const PORT = 3101;

// ⚠️ Borrar la base ANTES de empezar. Los PID se reciclan en Windows y una ejecución anterior
// que muriera sin limpiar deja su fichero: la siguiente lo abriría y heredaría sus filas. Es lo
// que hizo fallar a `test_cancelar_no_libera` el 20-09-2026 (punto 27 de pendientes).
for (const sufijo of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(TMP + sufijo); } catch (_) { /* no existía: lo normal */ }
}

process.env.DB_PATH  = TMP;
process.env.PORT     = String(PORT);
process.env.NODE_ENV = 'test';

/* ── Interceptar el correo para capturar el código ──────────────────────────
 *
 * Mismo patrón que `test_checkout_session.js` usa con el SDK de Stripe: se sustituye el módulo
 * ANTES de que lo cargue la ruta.
 */
const Module = require('module');
const cargaOriginal = Module._load;
let ultimoCorreo = null;
Module._load = function (peticion, padre) {
  if (peticion === '../email') {
    return { sendMail: async (msg) => { ultimoCorreo = msg; return { id: 'test' }; } };
  }
  return cargaOriginal.apply(this, arguments);
};

const express = require('express');
const { initDB, genId } = require('../src/db');

let pasados = 0, fallados = 0;
const ok = (cond, nombre, extra) => {
  if (cond) { pasados++; console.log('  ✅ ' + nombre); }
  else { fallados++; console.log('  ❌ ' + nombre + (extra ? '\n       → ' + extra : '')); }
};

const db  = initDB();
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.db = db; next(); });
app.use('/api', require('../src/routes/trials'));
const server = app.listen(0);

const HUELLA = 'a'.repeat(32);
const EMAIL  = 'podologo@ejemplo.test';

const llamar = async (ruta, cuerpo) => {
  const r = await fetch(`http://127.0.0.1:${server.address().port}/api${ruta}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  });
  let json = null;
  const texto = await r.text();
  try { json = JSON.parse(texto); } catch (_) {}
  return { status: r.status, json, texto };
};

const codigoDelCorreo = () => (ultimoCorreo?.html || '').match(/>(\d{6})</)?.[1] || null;
const trialFila = () => db.prepare('SELECT * FROM trials WHERE email = ?').get(EMAIL);
const cuantasClinicas = () => db.prepare('SELECT COUNT(*) AS n FROM clinicas').get().n;

(async () => {
  await new Promise(r => server.on('listening', r));
  console.log('\n🧪 Un trial activa su web de citas\n');

  // El trial existe porque se descargó la prueba. Se inserta directamente: registrar la
  // descarga ya lo cubre test_trials.js, y aquí estorbaría.
  const trialId = genId(12);
  db.prepare(`INSERT INTO trials (id, nombre, email, telefono, clinica, acepta_privacidad, acepta_privacidad_en)
              VALUES (?, ?, ?, ?, ?, 1, ?)`)
    .run(trialId, 'Ana Podóloga', EMAIL, '600111222', 'Clínica Ejemplo', new Date().toISOString());
  db.prepare(`INSERT INTO trial_instalaciones (hardwareId, inicio, fin, dias) VALUES (?, ?, ?, 60)`)
    .run(HUELLA, new Date().toISOString(), new Date(Date.now() + 60 * 864e5).toISOString());

  console.log('── Lo que ni siquiera llega a pedir código ──');
  {
    const r = await llamar('/trial/web/solicitar', { hardwareId: 'no-es-una-huella', email: EMAIL });
    ok(r.status === 400, 'una huella con mal formato se rechaza', `status ${r.status}`);
  }
  {
    const r = await llamar('/trial/web/solicitar', { hardwareId: HUELLA, email: 'esto-no-es-un-correo' });
    ok(r.status === 400, 'un correo con mal formato se rechaza', `status ${r.status}`);
  }
  {
    const r = await llamar('/trial/web/solicitar', { hardwareId: HUELLA, email: 'desconocido@ejemplo.test' });
    ok(r.status === 404, 'un correo que NO se descargó la prueba no recibe nada',
       'si no, esto sería un buzón para escribir a cualquiera');
    ok(ultimoCorreo === null, 'y no se manda ningún correo');
  }

  console.log('\n── Sin verificar NO se crea ninguna clínica ──');
  ok(cuantasClinicas() === 0, 'de momento no hay ninguna clínica');
  {
    const r = await llamar('/trial/web/confirmar', { hardwareId: HUELLA, email: EMAIL, codigo: '123456' });
    ok(r.status === 410, 'confirmar sin haber pedido código da 410', `status ${r.status}`);
    ok(cuantasClinicas() === 0, 'y NO se ha creado ninguna clínica',
       'es la exigencia del estudio: sin verificar no se crea nada');
  }

  console.log('\n── Se pide el código ──');
  const pedir = await llamar('/trial/web/solicitar', { hardwareId: HUELLA, email: EMAIL });
  ok(pedir.status === 200, 'la solicitud responde 200', `status ${pedir.status}`);
  ok(pedir.json?.validoMinutos === 15, 'dice que vale 15 minutos', String(pedir.json?.validoMinutos));
  ok(/···/.test(pedir.json?.enviadoA || ''), 'confirma a dónde fue sin revelar el correo entero',
     pedir.json?.enviadoA);
  const codigo = codigoDelCorreo();
  ok(/^\d{6}$/.test(codigo || ''), 'el correo lleva un código de 6 dígitos', String(codigo));
  ok(!(ultimoCorreo?.html || '').includes(EMAIL), 'y el correo no repite la dirección dentro del cuerpo');

  console.log('\n── Un código equivocado ──');
  {
    const malo = codigo === '000000' ? '111111' : '000000';
    const r = await llamar('/trial/web/confirmar', { hardwareId: HUELLA, email: EMAIL, codigo: malo });
    ok(r.status === 401, 'da 401', `status ${r.status}`);
    ok(r.json?.intentosRestantes === 4, 'y descuenta un intento de los cinco',
       String(r.json?.intentosRestantes));
    ok(cuantasClinicas() === 0, 'sigue sin crearse ninguna clínica');
  }

  console.log('\n── El código bueno: se verifica y nace la clínica ──');
  const bien = await llamar('/trial/web/confirmar', { hardwareId: HUELLA, email: EMAIL, codigo });
  ok(bien.status === 200, 'responde 200', `status ${bien.status} · ${bien.texto.slice(0, 120)}`);
  // ⚠️ base64url, no alfanumérico: `genId` es randomBytes(n).toString('base64url'), así que el
  // alfabeto incluye `-` y `_`. La primera versión de esta comprobación exigía [A-Za-z0-9] y
  // falló con `lZi_BtB0gE` — una suposición mía sobre el generador, no un fallo del código.
  ok(/^[A-Za-z0-9_-]{10}$/.test(bien.json?.clinicaId || ''), 'devuelve un clinicaId', bien.json?.clinicaId);
  ok(!!bien.json?.apiKey, 'y su apiKey');
  ok((bien.json?.webUrl || '').endsWith('/cita/' + bien.json?.clinicaId),
     'y la dirección de su web apunta a /cita/<clinicaId> — lo que el PC enseñará con el QR',
     bien.json?.webUrl);

  const t = trialFila();
  ok(!!t.email_verificado_en, 'el correo queda marcado como verificado');
  ok(t.clinicaId === bien.json.clinicaId, 'y el trial queda atado a su clínica');

  const cl = db.prepare('SELECT * FROM clinicas WHERE id = ?').get(bien.json.clinicaId);
  ok(cl?.fuente === 'trial', "la clínica queda marcada como fuente='trial'",
     'sin esto el panel no puede distinguirla de una de pago para borrar falsas');

  const inst = db.prepare('SELECT trialId FROM trial_instalaciones WHERE hardwareId = ?').get(HUELLA);
  ok(inst?.trialId === trialId, 'y la huella del equipo queda ATADA al trial',
     'hasta ahora trialId se adivinaba por IP, y el propio código avisa de que no identifica a nadie');

  console.log('\n── Un código gastado no vale, y no se crean dos clínicas ──');
  {
    const r = await llamar('/trial/web/confirmar', { hardwareId: HUELLA, email: EMAIL, codigo });
    ok(r.status === 200 && r.json?.yaActivada === true,
       'repetir la confirmación devuelve la clínica que ya hay', `status ${r.status}`);
    ok(r.json?.clinicaId === bien.json.clinicaId, 'y es la MISMA, no una nueva');
    ok(cuantasClinicas() === 1, 'sigue habiendo UNA sola clínica',
       'la exigencia literal del estudio: dos verificaciones no pueden crear dos clínicas');
  }
  {
    const r = await llamar('/trial/web/solicitar', { hardwareId: HUELLA, email: EMAIL });
    ok(r.json?.yaActivada === true, 'y volver a pedir código no manda otro: devuelve lo que ya hay');
    ok(cuantasClinicas() === 1, 'sin crear una segunda clínica');
  }

  console.log('\n── Un código caducado ──');
  {
    // Otro trial limpio, para no arrastrar el cerrojo de idempotencia del anterior.
    const otroId = genId(12), otroEmail = 'otra@ejemplo.test';
    db.prepare(`INSERT INTO trials (id, nombre, email, telefono, acepta_privacidad, acepta_privacidad_en)
                VALUES (?, ?, ?, ?, 1, ?)`)
      .run(otroId, 'Otro Podólogo', otroEmail, '600333444', new Date().toISOString());

    await llamar('/trial/web/solicitar', { hardwareId: HUELLA, email: otroEmail });
    const suCodigo = codigoDelCorreo();

    // Se envejece el código a mano: esperar quince minutos en una prueba no es una opción.
    db.prepare('UPDATE trial_verificaciones SET expiraEn = ? WHERE trialId = ?')
      .run(new Date(Date.now() - 1000).toISOString(), otroId);

    const r = await llamar('/trial/web/confirmar', { hardwareId: HUELLA, email: otroEmail, codigo: suCodigo });
    ok(r.status === 410, 'un código caducado da 410 y no sirve', `status ${r.status}`);

    const v = db.prepare('SELECT intentos FROM trial_verificaciones WHERE trialId = ?').get(otroId);
    ok(v.intentos === 0, 'y NO gasta uno de los cinco intentos',
       'un código muerto no debe consumir los intentos de quien luego pida otro');
    ok(cuantasClinicas() === 1, 'y no nace ninguna clínica de un código caducado');
  }

  console.log(`\n${pasados} pasados, ${fallados} fallados\n`);

  // Sin `process.exit`: mata el proceso mientras libuv cierra handles y dispara la assertion
  // `UV_HANDLE_CLOSING` — en verde, pero abortando el commit. Medido el 20-09-2026.
  process.exitCode = fallados ? 1 : 0;
  try { db.close(); } catch (_) {}
  for (const sufijo of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP + sufijo); } catch (_) {}
  }
  server.close();
})();
