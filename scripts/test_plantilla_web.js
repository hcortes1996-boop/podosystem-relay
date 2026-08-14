#!/usr/bin/env node
'use strict';
/**
 * Tests de la plantilla web y de cómo se despliega.
 *
 * Lo que defiende, y por qué existe: `applyPlaceholders` estaba atado al NOMBRE del
 * fichero (`e.name === 'cita.html'`). Al añadir `gestionar.html`, sus marcadores
 * `{{CLINICA_*}}` se habrían subido literales — el CSS con `{{CLINICA_COLOR_1}}` no es
 * válido y la página del paciente habría salido rota. Un fallo que solo se ve en
 * producción, en la página nueva, y con un paciente delante.
 *
 * Uso:  node scripts/test_plantilla_web.js
 */
const path = require('path');
const fs = require('fs');

let pasados = 0, fallados = 0;
const ok = (cond, nombre, extra) => {
  if (cond) { pasados++; console.log('  ✅ ' + nombre); }
  else { fallados++; console.log('  ❌ ' + nombre + (extra ? '\n       ' + extra : '')); }
};

const RAIZ = path.join(__dirname, '..');
const PLANTILLA = path.join(RAIZ, 'web-template');
const deploy = require(path.join(RAIZ, 'src', 'netlify-deploy.js'));

const VARS = {
  clinicaId: 'testABC123', nombre: 'Clínica de Prueba', nombreHeader: 'Prueba',
  color1: '#1a237e', color2: '#1a5fa8', colorAccent: '#f4d080',
  ciudad: 'Sevilla', direccion: 'Calle Falsa 1', telefono: '954 00 11 22',
  telefonoRaw: '+34954001122', descripcion: 'Podología', logoUrl: 'images/logo.png',
};

console.log('\n── Los ficheros de la plantilla ──');
const html = fs.readdirSync(PLANTILLA).filter(f => f.endsWith('.html')).sort();
ok(html.includes('cita.html'), 'está cita.html', html.join(', '));
ok(html.includes('gestionar.html'), 'está gestionar.html — la página del paciente', html.join(', '));

console.log('\n── Ningún marcador se queda sin sustituir ──');
// Se aplica la misma función que usa el despliegue, no una copia.
const aplicar = deploy.__test__?.applyPlaceholders;
ok(typeof aplicar === 'function',
   'netlify-deploy expone applyPlaceholders para poder probarla',
   'sin esto el test tendría que replicar la lógica, que es como se cuelan los fallos');

if (typeof aplicar === 'function') {
  for (const f of html) {
    const crudo = fs.readFileSync(path.join(PLANTILLA, f), 'utf-8');
    const puestos = [...new Set(crudo.match(/\{\{[A-Z0-9_]+\}\}/g) || [])];
    const salida = aplicar(crudo, VARS);
    const quedan = [...new Set(salida.match(/\{\{[A-Z0-9_]+\}\}/g) || [])];
    ok(quedan.length === 0,
       `${f}: sus ${puestos.length} marcadores se sustituyen todos`,
       'quedan sin sustituir: ' + quedan.join(', '));
  }
}

console.log('\n── La página del paciente, por dentro ──');
{
  const g = fs.readFileSync(path.join(PLANTILLA, 'gestionar.html'), 'utf-8');
  ok(g.includes("get('gestionar')"),
     'lee el token del parámetro `gestionar` — no choca con el `clinica` de cita.html');
  ok(/\/api\/cita\/'?\s*\+?\s*encodeURIComponent/.test(g) || g.includes('/api/cita/'),
     'llama a /api/cita/:token del relay');
  ok(g.includes('noindex'),
     'lleva noindex: cada dirección es el enlace privado de un paciente');
  ok(g.includes('podosystem-web'),
     'lleva el sello de versión, para saber qué está desplegado en cada clínica');
  // Las cuatro salidas que puede dar el servidor tienen que estar contempladas.
  for (const [marca, desc] of [
    ['anulada',      'la cita ya estaba anulada'],
    ['permitido',    'se puede anular (dentro de plazo)'],
    ['pasada',       'la cita ya pasó'],
    ['fuera_plazo',  'quedan menos de 24 h'],
  ]) {
    ok(g.includes(marca), `contempla el caso: ${desc}`);
  }
  ok(g.includes('avisoRegistrado'),
     'fuera de plazo, avisa al paciente de que se ha registrado su intento',
     'sin esto cree que su gesto no ha servido y no llama');
  ok((g.match(/TELEFONO/g) || []).length >= 4,
     'ofrece el teléfono de la clínica en todas las salidas sin salida');
}

console.log('\n── cita.html no se ha tocado ──');
{
  // La página de reservas es la que trae pacientes. La anulación va aparte
  // precisamente para no meterle mano.
  const c = fs.readFileSync(path.join(PLANTILLA, 'cita.html'), 'utf-8');
  ok(!c.includes('gestionar='),
     'la página de reservas no sabe nada del token — sigue siendo la de siempre');
}

console.log(`\n${pasados} pasados, ${fallados} fallados`);
process.exit(fallados ? 1 : 0);
