#!/usr/bin/env node
'use strict';
/**
 * test_admin_2fa.js — Doble autenticación del panel, llave de lectura y resumen (16-10-2026).
 *
 * Antes el panel se abría con una contraseña que el navegador guardaba para siempre, y su
 * resumen decía «76 € al mes» con cuatro licencias que no pagan. Aquí se fija:
 *   · que la contraseña sola deja de abrir el panel en cuanto se enlaza Google Authenticator,
 *   · que un código vale una sola vez, y que la sesión se puede cerrar,
 *   · que la llave de lectura mira y no toca,
 *   · y que el resumen cuenta como cliente solo lo que paga por Stripe.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

const TMP = path.join(os.tmpdir(), `relay_admin2fa_${process.pid}.db`);
const PORT = 3096;
process.env.DB_PATH = TMP;
process.env.PORT = String(PORT);
process.env.NODE_ENV = 'test';
process.env.ADMIN_TOKEN = 'contraseña-de-prueba-2fa';
process.env.ADMIN_TOKEN_LECTURA = 'llave-de-solo-lectura-para-pruebas';
process.env.RELAY_COPIA_CLAVE = require('crypto').randomBytes(32).toString('hex');
delete process.env.RESEND_API_KEY;

const T = require('../src/lib/admin-2fa');

let ok = 0, fallos = 0;
const prueba = (c, n, x) => { if (c) { ok++; console.log('  ✅ ' + n); } else { fallos++; console.log('  ❌ ' + n + (x ? '\n       → ' + x : '')); } };

require('../src/index.js');
const BASE = `http://127.0.0.1:${PORT}/admin`;
const llamar = async (metodo, ruta, token, cuerpo) => {
  const r = await fetch(BASE + ruta, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  return { status: r.status, j: await r.json().catch(() => ({})) };
};
const entrar = (password, codigo) => llamar('POST', '/api/login', null, { password, codigo });

(async () => {
  let db = null;
  try {
    await new Promise(r => setTimeout(r, 900));
    db = require('better-sqlite3')(TMP);

    console.log('\n🧪 El código de Google Authenticator\n');
    // Vector del RFC 6238 (SHA1, secreto «12345678901234567890»): a los 59 s, 94287082 → 287082
    const sRfc = T.aBase32(Buffer.from('12345678901234567890'));
    prueba(T.codigoEn(sRfc, T.contadorDe(59 * 1000)) === '287082', 'calcula el código igual que el estándar (RFC 6238)');
    prueba(T.deBase32(sRfc).toString() === '12345678901234567890', 'y la clave en base32 va y vuelve');

    console.log('\n🧪 Antes de enlazar el móvil\n');
    prueba((await llamar('GET', '/api/resumen', process.env.ADMIN_TOKEN)).status === 200,
      'la contraseña sola entra (es el paso intermedio, y lo que usan las demás pruebas)');
    const mala = await entrar('otra-cosa', '');
    prueba(mala.status === 401 && !mala.j.qr, 'con una contraseña equivocada no se enseña ningún QR');
    const prisa = await entrar(process.env.ADMIN_TOKEN, '123456');
    prueba(prisa.j.alta === true && !!prisa.j.qr, 'si escribe un código antes de ver el QR, se le enseña el QR (no un error sin salida)');
    const alta = await entrar(process.env.ADMIN_TOKEN, '');
    prueba(alta.j.alta === true && /^data:image\/png;base64,/.test(alta.j.qr || '') && /^[A-Z2-7]{32}$/.test(alta.j.secreto || ''),
      'con la buena, el panel enseña el QR para enlazar el móvil');
    prueba((await entrar(process.env.ADMIN_TOKEN, '000000')).status === 401, 'un código inventado no activa nada');
    prueba(!T.activado(db), 'y sigue sin activar');

    const ahora = Date.now();
    const activa = await entrar(process.env.ADMIN_TOKEN, T.codigoEn(alta.j.secreto, T.contadorDe(ahora)));
    prueba(activa.j.ok === true && activa.j.recienActivada === true && /^ses_[0-9a-f]{64}$/.test(activa.j.token || ''),
      'con el código del QR se activa y da una sesión');
    const SESION = activa.j.token;

    console.log('\n🧪 Ya activada\n');
    const sola = await llamar('GET', '/api/resumen', process.env.ADMIN_TOKEN);
    prueba(sola.status === 401 && sola.j.necesita2fa === true, 'la contraseña sola YA NO abre el panel');
    prueba((await llamar('GET', '/api/resumen', SESION)).status === 200, 'la sesión sí');
    const fila = db.prepare('SELECT * FROM admin_sesiones').all();
    prueba(fila.length === 1 && !JSON.stringify(fila).includes(SESION), 'la base guarda la huella de la sesión, nunca la sesión');
    prueba((await entrar(process.env.ADMIN_TOKEN, T.codigoEn(alta.j.secreto, T.contadorDe(ahora)))).status === 401,
      'el mismo código no vale dos veces');
    const otra = await entrar(process.env.ADMIN_TOKEN, T.codigoEn(alta.j.secreto, T.contadorDe(ahora) + 1));
    prueba(otra.j.ok === true, 'el siguiente sí (el móvil puede ir unos segundos adelantado)');
    prueba((await entrar('otra-cosa', T.codigoEn(alta.j.secreto, T.contadorDe(ahora) + 1))).status === 401,
      'y un código bueno con la contraseña mala, no');
    prueba((await llamar('POST', '/api/logout', otra.j.token)).status === 200 &&
           (await llamar('GET', '/api/resumen', otra.j.token)).status === 401, 'al salir, la sesión deja de valer');
    db.prepare("UPDATE admin_sesiones SET expira = '2000-01-01T00:00:00.000Z'").run();
    prueba((await llamar('GET', '/api/resumen', SESION)).status === 401, 'y una sesión caducada tampoco');

    console.log('\n🧪 La llave de solo lectura\n');
    const L = process.env.ADMIN_TOKEN_LECTURA;
    prueba((await llamar('GET', '/api/licencias', L)).status === 200, 'mira');
    const toca = await llamar('POST', '/api/licencias', L, { clienteNombre: 'X', clienteEmail: 'x@x.es' });
    prueba(toca.status === 403, 'y no toca', JSON.stringify(toca));
    prueba(db.prepare('SELECT COUNT(*) AS n FROM licencias').get().n === 0, 'no se creó nada');

    console.log('\n🧪 El resumen dice la verdad\n');
    // Los códigos de esta ventana ya están gastados: la sesión se abre directamente.
    const S = T.abrirSesion(db, '127.0.0.1').token;
    const lic = (id, fuente, plan, estado = 'active') => db.prepare(
      `INSERT INTO licencias (id, licenseKey, clienteNombre, clienteEmail, estado, fuente, plan) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, 'K-' + id, 'Cliente ' + id, id + '@x.es', estado, fuente, plan);
    lic('a', 'stripe', 'clinica'); lic('b', 'stripe', 'red'); lic('c', 'manual', 'clinica'); lic('d', 'stripe', 'basico', 'cancelada');
    db.prepare(`INSERT INTO trials (id, nombre, email, telefono, clinica, acepta_privacidad) VALUES ('t1', 'Ana Prueba', 'ana@x.es', '600111222', 'Podología Ana', 1)`).run();
    const dentro = (d) => new Date(Date.now() + d * 86400000).toISOString();
    db.prepare(`INSERT INTO trial_instalaciones (hardwareId, inicio, fin, dias, trialId, version) VALUES (?, ?, ?, 60, 't1', '3.12.7')`)
      .run('a'.repeat(32), dentro(-57), dentro(3));
    db.prepare(`INSERT INTO trial_instalaciones (hardwareId, inicio, fin, dias, version) VALUES (?, ?, ?, 60, '3.12.6')`)
      .run('b'.repeat(32), dentro(-10), dentro(50));
    db.prepare(`INSERT INTO solicitudes_alta (id, nombre_clinica, profesional, telefono, email) VALUES ('s1', 'C', 'P', '600', 'p@x.es')`).run();

    const r = (await llamar('GET', '/api/resumen', S)).j;
    prueba(r.clientes.pagan === 2 && r.clientes.ingresosMes === 61, 'clientes = solo los de Stripe vivos, a 27 + 34 €', JSON.stringify(r.clientes));
    prueba(r.clientes.cortesia === 1, 'la manual se cuenta aparte, como cortesía');
    prueba(r.pruebas.enMarcha === 2 && r.pruebas.acabanPronto.length === 1, 'dos pruebas en marcha, una se acaba esta semana');
    prueba(r.pruebas.acabanPronto[0].persona && r.pruebas.acabanPronto[0].persona.telefono === '600111222',
      'y viene con el teléfono para llamar');
    prueba(r.avisos.some(a => a.ir === 'solicitudes') && r.avisos.some(a => /sin contactar|no las has contactado/.test(a.texto)),
      'avisa de la solicitud de alta y de quien no se ha contactado');
    prueba(r.flota.versiones['3.12.7'] === 1 && r.flota.versiones['3.12.6'] === 1, 'y cuenta las versiones de los equipos');

    console.log('\n🧪 Seguimiento de quien prueba\n');
    prueba((await llamar('PUT', '/api/trials/t1/seguimiento', S, { seguimiento: 'lo-que-sea' })).status === 400, 'un estado inventado no se guarda');
    await llamar('PUT', '/api/trials/t1/seguimiento', S, { seguimiento: 'interesado' });
    await llamar('PUT', '/api/trials/t1/seguimiento', S, { notas: 'Llamar el lunes' });
    const t1 = db.prepare('SELECT seguimiento, notas_admin, seguimiento_en FROM trials WHERE id = ?').get('t1');
    prueba(t1.seguimiento === 'interesado' && t1.notas_admin === 'Llamar el lunes' && t1.seguimiento_en,
      'el estado y las notas se guardan, y cambiar una no borra la otra');
    const tr = (await llamar('GET', '/api/trials', S)).j.trials[0];
    prueba(tr.equipo && tr.equipo.diasRestantes === 3, 'la lista dice si abrió el programa y cuántos días le quedan');

    console.log('\n🧪 Si se pierde el móvil\n');
    T.reiniciar(db);
    prueba((await llamar('GET', '/api/resumen', process.env.ADMIN_TOKEN)).status === 200 &&
           (await llamar('GET', '/api/resumen', S)).status === 401,
      'reiniciar borra el secreto y las sesiones: vuelve a pedir el QR');

    console.log('\n🧪 El panel\n');
    const html = await (await fetch(BASE + '/')).text();
    prueba(!/localStorage\.setItem\('ps_admin_token'/.test(html), 'ya no guarda la contraseña en el navegador');
    prueba(!/redeploy/i.test(html.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/.*$/gm, '')), 'ni ofrece «Redeploy web»');
  } catch (e) {
    fallos++; console.log('  ❌ excepción: ' + e.stack);
  } finally {
    try { db && db.close(); } catch (_) {}
    for (const f of [TMP, TMP + '-wal', TMP + '-shm']) { try { fs.unlinkSync(f); } catch (_) {} }
    console.log(`\n${fallos ? '❌' : '✅'} ${ok} COMPROBACIONES EN VERDE${fallos ? `, ${fallos} FALLOS` : ''}`);
    process.exit(fallos ? 1 : 0);
  }
})();
