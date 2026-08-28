'use strict';
/**
 * firma.js — el servidor firma lo que afirma.
 *
 * ── Por qué (V12, del informe del 17-08-2026) ────────────────────────────────
 *
 * Hasta ahora el PC era **juez de su propia licencia**. `licencia.js` guarda `license.enc`
 * cifrado con una clave incrustada en el propio programa: cualquiera la saca del `.asar`,
 * se escribe una licencia con el plan que quiera y `lastValidatedAt` puesto a hoy, y el
 * programa la da por buena — porque dentro del intervalo de 7 días **ni siquiera pregunta**.
 *
 * Cifrar más no arregla eso. El problema no es que el fichero sea legible: es que la
 * autoridad está en el sitio equivocado. La única salida es que la afirmación «esta
 * licencia vale» venga firmada por quien sí es autoridad, con una clave que el cliente no
 * tiene y no puede tener.
 *
 * ── Cómo ────────────────────────────────────────────────────────────────────
 *
 * Ed25519. La privada vive SOLO aquí, en `FIRMA_PRIV_KEY`. La pública va incrustada en la
 * aplicación, donde no hace daño que se lea.
 *
 * Se firma **una cadena exacta**, no un objeto: el servidor manda `firmado` (el JSON tal
 * cual) y `firma`, y el cliente verifica sobre esa misma cadena antes de interpretarla. Así
 * no hay que ponerse de acuerdo en cómo se serializa —ni orden de claves, ni espacios, ni
 * cómo se escriben las fechas—, que es donde estas cosas se rompen en silencio.
 *
 * ── Si no hay clave ─────────────────────────────────────────────────────────
 *
 * No se firma, y se avisa en el log. Es a propósito, y solo mientras dure la transición: si
 * el relay dejara de responder a las instalaciones que aún no verifican firmas, un cliente
 * al día se quedaría sin poder trabajar por un cambio nuestro. La versión siguiente exige
 * firma en el cliente; para entonces esta variable tiene que estar puesta.
 */

const crypto = require('crypto');

let _clave = null;
let _avisado = false;

function clavePrivada() {
  if (_clave !== null) return _clave;
  const pem = (process.env.FIRMA_PRIV_KEY || '').replace(/\\n/g, '\n').trim();
  if (!pem) { _clave = false; return _clave; }
  try {
    _clave = crypto.createPrivateKey(pem);
  } catch (e) {
    console.error('⚠️  [firma] FIRMA_PRIV_KEY no es una clave válida:', e.message);
    _clave = false;
  }
  return _clave;
}

/**
 * Firma un objeto. Devuelve `{ firmado, firma }` o `null` si no hay clave.
 *
 * `firmado` es la cadena EXACTA sobre la que se calculó la firma: el cliente tiene que
 * verificar sobre ella y solo después interpretarla.
 */
function firmar(objeto) {
  const clave = clavePrivada();
  if (!clave) {
    if (!_avisado) {
      _avisado = true;
      console.warn('⚠️  [firma] FIRMA_PRIV_KEY no está definida: se responde SIN firmar. ' +
                   'Las versiones que exijan firma no podrán validar.');
    }
    return null;
  }
  // `emitidoEn` va siempre: sin él, una respuesta antigua capturada valdría para siempre.
  const firmado = JSON.stringify({ ...objeto, emitidoEn: new Date().toISOString() });
  const firma = crypto.sign(null, Buffer.from(firmado, 'utf8'), clave).toString('base64');
  return { firmado, firma };
}

/** ¿Está el relay en condiciones de firmar? Para el diagnóstico. */
function puedeFirmar() {
  return clavePrivada() !== false;
}

/** La pública, para poder comprobar desde el panel que coincide con la de la app. */
function clavePublicaPem() {
  const clave = clavePrivada();
  if (!clave) return null;
  return crypto.createPublicKey(clave).export({ type: 'spki', format: 'pem' }).toString().trim();
}

module.exports = { firmar, puedeFirmar, clavePublicaPem };
