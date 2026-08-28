/**
 * test_firma.js — el relay firma lo que afirma (V12 + T3).
 *
 * Lo que hay que fijar:
 *
 *   · Sin FIRMA_PRIV_KEY no se firma, pero **no se rompe nada**: se responde sin firma y se
 *     avisa. Es a proposito y solo durante la transicion — si el relay dejara de responder
 *     a las instalaciones que aun no verifican, un cliente al dia se quedaria sin trabajar
 *     por un cambio nuestro.
 *   · Con clave, lo firmado incluye SIEMPRE `emitidoEn`. Sin el, una respuesta capturada
 *     valdria para siempre.
 *   · Y `firmado` es la cadena EXACTA que se firmo: si el cliente verificase sobre una
 *     reserializacion propia, cualquier diferencia de formato —orden de claves, espacios,
 *     como se escriben las fechas— rompeuria la firma sin que nadie supiera por que.
 *
 * Uso:  node scripts/test_firma.js
 */
'use strict';

const crypto = require('crypto');

let pasados = 0, fallados = 0;
const ok = (cond, nombre, extra) => {
  if (cond) { pasados++; console.log('  ✅ ' + nombre); }
  else { fallados++; console.log('  ❌ ' + nombre + (extra ? '\n       → ' + extra : '')); }
};

console.log('\n🧪 Firma del relay\n');

// ── Sin clave ────────────────────────────────────────────────────────────────
delete process.env.FIRMA_PRIV_KEY;
{
  const firma = require('../src/firma');
  ok(firma.puedeFirmar() === false, 'sin FIRMA_PRIV_KEY, no puede firmar');
  ok(firma.firmar({ tipo: 'licencia' }) === null, 'y firmar() devuelve null en vez de reventar');
  ok(firma.clavePublicaPem() === null, 'ni hay clave publica que ensenar');
}

// El modulo cachea la clave, asi que para probar el otro caso hace falta recargarlo.
delete require.cache[require.resolve('../src/firma')];

// ── Con clave ────────────────────────────────────────────────────────────────
const par = crypto.generateKeyPairSync('ed25519');
const privPem = par.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

// Se guarda como una sola linea con \n literales, que es como se pega en Railway: si el
// modulo no supiera deshacer eso, funcionaria en pruebas y fallaria en produccion.
process.env.FIRMA_PRIV_KEY = privPem.trim().replace(/\n/g, '\\n');

{
  const firma = require('../src/firma');
  ok(firma.puedeFirmar() === true, 'con la clave en una sola linea, SI puede firmar');
  ok(firma.clavePublicaPem() === par.publicKey.export({ type: 'spki', format: 'pem' }).toString().trim(),
    'y la publica que deriva es la que toca');

  const sello = firma.firmar({ tipo: 'licencia', licenseKey: 'ABC', hardwareId: 'a'.repeat(32), plan: 'red' });
  ok(!!sello && !!sello.firmado && !!sello.firma, 'firmar() devuelve firmado + firma');

  const valida = crypto.verify(null, Buffer.from(sello.firmado, 'utf8'), par.publicKey,
                               Buffer.from(sello.firma, 'base64'));
  ok(valida === true, 'la firma verifica con la clave publica');

  const datos = JSON.parse(sello.firmado);
  ok(!!datos.emitidoEn, 'lo firmado lleva emitidoEn — sin el, una captura valdria siempre');
  ok(datos.plan === 'red' && datos.licenseKey === 'ABC', 'y lleva lo que se le paso');
  ok(Math.abs(Date.now() - new Date(datos.emitidoEn).getTime()) < 60000,
    'emitidoEn es de ahora, no una fecha inventada');

  // Cambiar un solo caracter tiene que romperla.
  const tocado = sello.firmado.replace('"red"', '"basico"');
  ok(crypto.verify(null, Buffer.from(tocado, 'utf8'), par.publicKey,
                   Buffer.from(sello.firma, 'base64')) === false,
    'cambiar el plan a mano invalida la firma');

  // Dos firmas del mismo contenido no tienen por que ser iguales byte a byte, pero las dos
  // valen: lo que importa es que verifiquen, no que coincidan.
  const otro = firma.firmar({ tipo: 'licencia', licenseKey: 'ABC' });
  ok(crypto.verify(null, Buffer.from(otro.firmado, 'utf8'), par.publicKey,
                   Buffer.from(otro.firma, 'base64')) === true,
    'una segunda firma tambien verifica');
}

// ── Una clave que no vale ────────────────────────────────────────────────────
delete require.cache[require.resolve('../src/firma')];
process.env.FIRMA_PRIV_KEY = 'esto-no-es-una-clave';
{
  const firma = require('../src/firma');
  ok(firma.puedeFirmar() === false, 'una clave con basura no se acepta');
  ok(firma.firmar({ tipo: 'licencia' }) === null, 'y se responde sin firma en vez de caerse');
}

console.log(`\n${fallados === 0 ? `✅ ${pasados} COMPROBACIONES EN VERDE` : `❌ ${fallados} FALLIDAS de ${pasados + fallados}`}\n`);
process.exit(fallados === 0 ? 0 : 1);
