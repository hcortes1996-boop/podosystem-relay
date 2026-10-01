/**
 * test_registro_secreto.js — El alta manual de clínicas solo con el secreto bueno.
 *
 * 01-10-2026: la comparación era `!==` (el tiempo de respuesta delata los caracteres que se
 * aciertan) y un REGISTRO_SECRET vacío o de dos letras en el servidor se aceptaba igual.
 */
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');

const TMP = path.join(os.tmpdir(), `relay_registro_${process.pid}.db`);
const PORT = 3093;
process.env.DB_PATH = TMP;
process.env.PORT = String(PORT);
process.env.NODE_ENV = 'test';
process.env.REGISTRO_SECRET = 'secreto-de-registro-de-prueba';
delete process.env.RESEND_API_KEY;

let ok = 0, fallos = 0;
const prueba = (c, n, x) => { if (c) { ok++; console.log('  ✅ ' + n); } else { fallos++; console.log('  ❌ ' + n + (x ? '\n       → ' + x : '')); } };

require('../src/index.js');
const alta = (cuerpo) => fetch(`http://127.0.0.1:${PORT}/api/registro-clinica`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo),
}).then(async r => ({ status: r.status, cuerpo: await r.json().catch(() => ({})) }));

(async () => {
  try {
    await new Promise(r => setTimeout(r, 900));
    console.log('\n🧪 Alta manual de clínicas\n');
    prueba((await alta({ nombre: 'X', registroSecret: 'otro' })).status === 403, 'con un secreto equivocado, NO da de alta');
    prueba((await alta({ nombre: 'X' })).status === 403, 'sin secreto, tampoco');
    prueba((await alta({ nombre: 'X', registroSecret: { $ne: 1 } })).status === 403, 'ni mandando un objeto en vez de un texto');
    const bien = await alta({ nombre: 'Clínica de prueba', registroSecret: process.env.REGISTRO_SECRET });
    prueba(bien.status === 201 && bien.cuerpo.ok && bien.cuerpo.clinicaId, 'con el secreto bueno, sí', JSON.stringify(bien.cuerpo).slice(0, 120));

    process.env.REGISTRO_SECRET = 'corto';
    prueba((await alta({ nombre: 'X', registroSecret: 'corto' })).status === 403,
      'un secreto de menos de 16 caracteres en el servidor deja la puerta CERRADA');
    process.env.REGISTRO_SECRET = '';
    prueba((await alta({ nombre: 'X', registroSecret: '' })).status === 403, 'y uno vacío, también');
  } catch (e) {
    fallos++; console.log('💥', e);
  }
  console.log(`\n${ok} bien, ${fallos} mal\n`);
  try { fs.unlinkSync(TMP); } catch (_) {}
  // Salir con las conexiones de fetch aún cerrándose dispara en Windows la aserción de libuv
  // `UV_HANDLE_CLOSING`. Un momento de margen basta.
  await new Promise(r => setTimeout(r, 300));
  process.exit(fallos ? 1 : 0);
})();
