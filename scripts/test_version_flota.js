/**
 * test_version_flota.js — El PC dice qué versión corre, y el relay la anota.
 *
 * Hasta el 27-08-2026 el relay no sabía qué versión tenía cada instalación: el PC mandaba
 * `licenseKey`, `hardwareId` e `instanceId`, y nada más. Por eso la clínica estuvo un día
 * entero sin instalar la 3.5.0 y la única forma de enterarse fue que Francisco lo notara.
 *
 * Lo que hay que fijar aquí NO es que se guarde el dato — eso es lo fácil. Es que **esto es
 * telemetría, no autorización**, y por tanto:
 *
 *   · una licencia se valida igual aunque no se mande versión (clientes viejos);
 *   · se valida igual aunque la versión sea basura;
 *   · y el estado y el plan que devuelve no cambian por nada de esto.
 *
 * Si anotar la versión pudiera tumbar una validación, habríamos cambiado poder ver la flota
 * por dejar a un cliente sin poder trabajar. No compensa ni de lejos.
 *
 * Uso:  node scripts/test_version_flota.js
 */
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');

const TMP = path.join(os.tmpdir(), `relay_version_${process.pid}.db`);
const PORT = 3096;
process.env.DB_PATH = TMP;
process.env.PORT = String(PORT);
process.env.NODE_ENV = 'test';

let pasados = 0, fallados = 0;
const ok = (cond, nombre, extra) => {
  if (cond) { pasados++; console.log('  ✅ ' + nombre); }
  else { fallados++; console.log('  ❌ ' + nombre + (extra ? '\n       → ' + extra : '')); }
};

require('../src/index.js');

const BASE = `http://127.0.0.1:${PORT}`;
const LICENCIA = 'PODO-TEST-VERSION-001';
const HW = 'hw-flota-001';

const verificar = (body) => fetch(`${BASE}/admin/api/licencias/verificar`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

(async () => {
  await new Promise(r => setTimeout(r, 900));

  const db = require('better-sqlite3')(TMP);
  db.prepare(`INSERT INTO licencias (id, licenseKey, clienteNombre, clienteEmail, hardwareId, estado, plan)
              VALUES ('lic_flota', ?, 'Cliente flota', 'c@ejemplo.test', ?, 'active', 'clinica')`)
    .run(LICENCIA, HW);
  const fila = () => db.prepare('SELECT * FROM licencias WHERE licenseKey = ?').get(LICENCIA);

  console.log('\n── Se anota la versión ──');

  let r = await verificar({ licenseKey: LICENCIA, hardwareId: HW, version: '3.5.1' });
  ok(r.status === 200 && r.body.ok === true, 'la licencia se valida', JSON.stringify(r.body));
  ok(fila().version_instalada === '3.5.1', 'y queda anotada la versión', fila().version_instalada);
  ok(!!fila().version_vista_en, 'con la fecha en que se la vio', fila().version_vista_en);

  r = await verificar({ licenseKey: LICENCIA, hardwareId: HW, version: '3.6.0' });
  ok(fila().version_instalada === '3.6.0', 'al actualizarse el cliente, se actualiza el dato');

  console.log('\n── Pero es TELEMETRÍA, no autorización ──');

  // Un cliente anterior a esta version no manda `version`. No puede quedarse fuera.
  const antes = fila().version_instalada;
  r = await verificar({ licenseKey: LICENCIA, hardwareId: HW });
  ok(r.status === 200 && r.body.ok === true, 'sin mandar versión, la licencia se valida igual');
  ok(fila().version_instalada === antes, 'y no se borra la que ya había', fila().version_instalada);

  for (const [valor, motivo] of [
    ['a'.repeat(200),          'larguísima'],
    ['3.5.1; DROP TABLE x',    'con SQL dentro'],
    ['<script>x</script>',     'con HTML'],
    [{ objeto: true },         'que no es texto'],
    [12345,                    'que es un número'],
    ['3.5',                    'incompleta'],
    ['v3.5.1',                 'con prefijo v'],
  ]) {
    const rr = await verificar({ licenseKey: LICENCIA, hardwareId: HW, version: valor });
    ok(rr.status === 200 && rr.body.ok === true, `una versión ${motivo} NO impide validar`, JSON.stringify(rr.body));
  }
  ok(fila().version_instalada === antes, 'y ninguna de esas basuras se llegó a guardar', fila().version_instalada);

  // La forma de beta SÍ es una versión válida: si no, las betas no reportarían y el banco
  // de pruebas del portátil quedaría invisible en el panel.
  await verificar({ licenseKey: LICENCIA, hardwareId: HW, version: '3.5.1-beta.2' });
  ok(fila().version_instalada === '3.5.1-beta.2', 'una beta SÍ se guarda', fila().version_instalada);

  console.log('\n── El plan y el estado no cambian por esto ──');
  r = await verificar({ licenseKey: LICENCIA, hardwareId: HW, version: '3.5.1' });
  ok(r.body.plan === 'clinica', 'sigue devolviendo el plan correcto', r.body.plan);
  ok(r.body.estado === 'active', 'y el estado', r.body.estado);

  // Y sigue rechazando lo que tenia que rechazar.
  r = await verificar({ licenseKey: LICENCIA, hardwareId: 'otro-equipo', version: '3.5.1' });
  ok(r.status === 403, 'un hardware distinto se sigue rechazando', `status ${r.status}`);
  r = await verificar({ licenseKey: 'NO-EXISTE', version: '3.5.1' });
  ok(r.status === 404, 'y una licencia inexistente también', `status ${r.status}`);

  console.log(`\n${fallados === 0 ? `✅ ${pasados} COMPROBACIONES EN VERDE` : `❌ ${fallados} FALLIDAS de ${pasados + fallados}`}`);
  try { fs.unlinkSync(TMP); } catch {}
  await new Promise(r => setTimeout(r, 300));
  process.exit(fallados === 0 ? 0 : 1);
})();
