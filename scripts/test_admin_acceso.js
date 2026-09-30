#!/usr/bin/env node
'use strict';
/**
 * test_admin_acceso.js — el panel de administración falla CERRADO y registra quién entra (30-09-2026).
 *
 * Antes: con ADMIN_TOKEN ausente en Railway, el panel se abría con 'cambiar-este-token-en-railway',
 * una contraseña escrita en el código (que está en GitHub). Y no quedaba rastro de ningún acceso.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawnSync } = require('child_process');

const TMP = path.join(os.tmpdir(), `relay_adminacc_${process.pid}.db`);
const PORT = 3097;
process.env.DB_PATH = TMP;
process.env.PORT = String(PORT);
process.env.NODE_ENV = 'test';
process.env.ADMIN_TOKEN = 'token-de-prueba-acceso';
delete process.env.RESEND_API_KEY;

let ok = 0, fallos = 0;
const prueba = (c, n, x) => { if (c) { ok++; console.log('  ✅ ' + n); } else { fallos++; console.log('  ❌ ' + n + (x ? '\n       → ' + x : '')); } };

require('../src/index.js');
const BASE = `http://127.0.0.1:${PORT}`;
const pedir = (token) => fetch(`${BASE}/admin/api/diagnostico`, { headers: token ? { Authorization: 'Bearer ' + token } : {} })
  .then(r => r.status);

(async () => {
  let db = null;
  try {
    await new Promise(r => setTimeout(r, 900));
    console.log('\n🧪 Acceso al panel de administración\n');
    db = require('better-sqlite3')(TMP);

    prueba(await pedir('otra-cosa-cualquiera') === 401, 'con una contraseña equivocada, NO entra');
    prueba(await pedir('cambiar-este-token-en-railway') === 401, 'y la contraseña que antes venía por defecto en el código, tampoco');
    prueba(await pedir(null) === 401, 'ni sin contraseña');
    prueba(await pedir(process.env.ADMIN_TOKEN) === 200, 'con la buena, sí');

    const filas = db.prepare('SELECT * FROM admin_accesos ORDER BY id').all();
    prueba(filas.length === 4 && filas.filter(f => f.aceptado === 1).length === 1,
      'cada intento queda REGISTRADO, con si se aceptó', JSON.stringify(filas.map(f => f.aceptado)));
    prueba(filas.every(f => f.ruta === '/admin/api/diagnostico' && f.fecha),
      'con la ruta y la hora');
    prueba(!JSON.stringify(filas).includes(process.env.ADMIN_TOKEN) && !JSON.stringify(filas).includes('otra-cosa-cualquiera'),
      'y NUNCA con la contraseña, ni la buena ni la probada');

    // Sin ADMIN_TOKEN: otro proceso, porque se lee al cargar el módulo.
    const hijo = spawnSync(process.execPath, ['-e', `
      process.env.DB_PATH = ${JSON.stringify(TMP + '.sin')};
      process.env.PORT = '3098'; process.env.NODE_ENV = 'test';
      delete process.env.ADMIN_TOKEN;
      require(${JSON.stringify(path.join(__dirname, '..', 'src', 'index.js'))});
      setTimeout(async () => {
        const r1 = await fetch('http://127.0.0.1:3098/admin/api/diagnostico', { headers: { Authorization: 'Bearer cambiar-este-token-en-railway' } });
        console.log('ESTADO=' + r1.status);
        process.exit(0);
      }, 900);
    `], { encoding: 'utf-8', timeout: 30000, env: { ...process.env, ADMIN_TOKEN: '' } });
    const estado = (hijo.stdout.match(/ESTADO=(\d+)/) || [])[1];
    prueba(estado === '503', 'SIN ADMIN_TOKEN el panel NO se abre (503), ni con la contraseña de antes', 'estado ' + estado);
  } catch (e) {
    fallos++; console.log('  💥 ' + e.message);
  } finally {
    try { db && db.close(); } catch (_) {}
    for (const base of [TMP, TMP + '.sin']) for (const f of [base, base + '-wal', base + '-shm']) { try { fs.unlinkSync(f); } catch (_) {} }
    console.log(`\n${ok} bien, ${fallos} mal`);
    process.exit(fallos ? 1 : 0);
  }
})();
