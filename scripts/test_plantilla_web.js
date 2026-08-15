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

console.log('\n── Una clínica sin podólogos publicados PUEDE reservar ──');
{
  // El fallo, detectado en Merino el 15-08-2026 con la página ya desplegada:
  // `podologoSeleccionado === null` significaba a la vez «el paciente eligió
  // Cualquier disponible» y «esta clínica no publica podólogos». Con 0 publicados,
  // pickSlot preguntaba por los disponibles, recibía [] —correctamente— y contestaba
  // «esa hora ya no está disponible» a CUALQUIER hora libre. Ninguna clínica sin
  // Plan Red podía coger cita, y son la mayoría.
  const c = fs.readFileSync(path.join(PLANTILLA, 'cita.html'), 'utf-8');
  ok(/if\s*\(\s*podologoSeleccionado\s*\|\|\s*!multiPodologo\s*\)/.test(c),
     'pickSlot distingue «no hay podólogos» de «cualquiera vale»');
  ok(c.includes('multiPodologo = podologos.length >= 2'),
     'y multiPodologo sigue siendo la bandera que lo decide');
  // Con 1 se autoselecciona; con 0 va al flujo clásico. Ninguna de las dos debe
  // acabar consultando podologos-disponibles.
  ok(/if\s*\(podologos\.length === 1\)\s*podologoSeleccionado = podologos\[0\]\.id/.test(c),
     'con un solo podólogo se sigue autoseleccionando');
}

console.log('\n── Las variables se derivan una sola vez para los dos caminos ──');
{
  // `construirVars` estaba ESCRITA DOS VECES, palabra por palabra, en
  // deployClientSite y en redeployClientSite. Este bloque fija lo que produce, para
  // que al haberla unificado no haya cambiado nada por el camino.
  //
  // Los valores son los de MERINO, comprobados contra su web viva el 15-08-2026:
  // los tres colores salen de un hash del nombre, así que acertarlos prueba que la
  // derivación entera sigue igual.
  const v = deploy.construirVars({
    clinicaId: 'bhy3fWaqW0', nombre: 'CLINICA DEL PIE MERINO',
    ciudad: 'DOS HERMANAS', telefono: '675565440',
  });
  ok(v.color1 === 'hsl(230,  45%, 12%)', 'color1 como en la web viva de Merino', v.color1);
  ok(v.color2 === 'hsl(250, 50%, 22%)',  'color2 igual', v.color2);
  ok(v.colorAccent === 'hsl(10, 35%, 18%)', 'accent igual', v.colorAccent);
  ok(v.nombreHeader === 'CLINICA DEL PIE<br><strong>MERINO</strong>',
     'el nombre del header se parte igual que en la web viva', v.nombreHeader);
  ok(v.telefonoRaw === '675565440', 'el teléfono se limpia igual', v.telefonoRaw);
  ok(v.descripcion === 'Podología en DOS HERMANAS', 'la descripción se compone igual', v.descripcion);
  ok(v.logoUrl.endsWith('/api/clinicas/bhy3fWaqW0/logo'), 'el logo apunta al relay', v.logoUrl);
  ok(v.direccion === '', 'sin dirección queda vacía, no «undefined»');
}
{
  // Sin datos no puede reventar: una clínica recién dada de alta puede no tener
  // ciudad ni teléfono todavía.
  const v = deploy.construirVars({ clinicaId: 'x', nombre: 'Clinica Sola' });
  ok(v.ciudad === 'su ciudad', 'sin ciudad hay un texto de relleno, no un hueco');
  ok(v.telefono === 'Sin teléfono' && v.telefonoRaw === '000000000', 'y sin teléfono también');
  ok(v.nombreHeader === '<strong>Clinica Sola</strong>',
     'un nombre de dos palabras no se parte', v.nombreHeader);
}

console.log('\n── El sitio que se genera es el que se sube ──');
{
  // `construirFicheros` la usan el ZIP de Netlify y scripts/generar-web-clinica.js.
  // Si fueran dos recorridos distintos, lo que se revisa en local dejaría de ser lo
  // que se publica.
  const f = deploy.construirFicheros(VARS);
  const rutas = Object.keys(f).sort();
  ok(rutas.includes('cita.html'), 'lleva cita.html');
  ok(rutas.includes('gestionar.html'), 'lleva gestionar.html — la página de anulación');
  ok(rutas.includes('_redirects'), 'y el _redirects que manda la raíz a cita.html');
  ok(String(f['_redirects']).includes('/cita.html'), 'la raíz sigue apuntando a la página de citas');
  ok(rutas.some(r => r.startsWith('css/')) && rutas.some(r => r.startsWith('images/')),
     'y los assets, o la página saldría sin estilos');

  let conMarcadores = [];
  for (const [r, buf] of Object.entries(f)) {
    if (r.endsWith('.html') && /\{\{[A-Z_0-9]+\}\}/.test(String(buf))) conMarcadores.push(r);
  }
  ok(conMarcadores.length === 0,
     'NINGUNA página se sube con marcadores sin sustituir', conMarcadores.join(', '));
}

console.log(`\n${pasados} pasados, ${fallados} fallados`);
process.exit(fallados ? 1 : 0);
