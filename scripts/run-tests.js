/**
 * run-tests.js — Pasa toda la batería del relay.
 *
 * ── Por qué existe ───────────────────────────────────────────────────────────
 *
 * El relay tenía **23 ficheros de prueba y ninguna forma de lanzarlos todos**. Cada uno se
 * ejecutaba a mano, cuando alguien se acordaba, y solo el que estaba tocando. Una prueba que
 * nadie ejecuta no protege de nada — es la misma lección que en el repositorio de PodoSystem,
 * donde el crash de «Ver todas las facturas» salió en SEIS versiones publicadas porque el
 * detector existía y no estaba en el camino de nadie.
 *
 * Cada prueba levanta su propio servidor en su propio puerto y su propia base temporal, así
 * que se ejecutan **de una en una**: en paralelo se pisarían los puertos y las bases.
 *
 *   node scripts/run-tests.js
 *   npm test
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const pruebas = fs.readdirSync(DIR)
  .filter(f => /^test_.*\.js$/.test(f))
  .sort();

console.log(`\n🧪 Batería del relay — ${pruebas.length} pruebas\n`);

const rojas = [];
const t0 = Date.now();

for (const f of pruebas) {
  const t = Date.now();
  const r = spawnSync(process.execPath, [path.join(DIR, f)], {
    encoding: 'utf-8',
    env: { ...process.env, NODE_ENV: 'test' },
    timeout: 120000,
  });
  const seg = ((Date.now() - t) / 1000).toFixed(1);
  const bien = r.status === 0;
  if (!bien) rojas.push({ f, salida: (r.stdout || '') + (r.stderr || '') });
  console.log(`   ${f.replace(/\.js$/, '').padEnd(34)} ${bien ? '✅' : '❌'}  ${seg}s`);
}

for (const { f, salida } of rojas) {
  console.log('\n' + '─'.repeat(70));
  console.log('❌ ' + f);
  console.log('─'.repeat(70));
  console.log(salida.split('\n').slice(-25).join('\n'));
}

const total = ((Date.now() - t0) / 1000).toFixed(1);
if (rojas.length) {
  console.error(`\n❌ ${rojas.length} de ${pruebas.length} en rojo (${total}s)\n`);
  process.exit(1);
}
console.log(`\n✅ Las ${pruebas.length} en verde (${total}s)\n`);
